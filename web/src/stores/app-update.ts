import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  AUTO_RELOAD_STORAGE_KEY,
  evaluateWebBuildChange,
} from '@/utils/panel-update'

export const useAppUpdateStore = defineStore('app-update', () => {
  const initialBuildId = typeof __WEB_BUILD_ID__ === 'string' && __WEB_BUILD_ID__
    ? __WEB_BUILD_ID__
    : 'dev'

  const currentBuildId = ref(initialBuildId)
  const socketReconnecting = ref(false)
  const httpUnavailable = ref(false)
  const pendingBuildId = ref('')
  const updatePromptVisible = ref(false)
  const editGuards = ref<Map<symbol, boolean>>(new Map())

  let monitoringActive = false
  let lastCheckAt = 0
  let lastReconnectCount = 0
  let inFlightCheck: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const followUpTimers = new Set<ReturnType<typeof setTimeout>>()

  function readAutoReloadedBuildId(): string {
    try {
      return typeof sessionStorage !== 'undefined'
        ? (sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY) || '')
        : ''
    }
    catch {
      return ''
    }
  }

  function writeAutoReloadedBuildId(buildId: string): boolean {
    try {
      if (typeof sessionStorage === 'undefined')
        return false
      if (buildId)
        sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, buildId)
      else
        sessionStorage.removeItem(AUTO_RELOAD_STORAGE_KEY)
      return true
    }
    catch {
      return false
    }
  }

  if (readAutoReloadedBuildId() && readAutoReloadedBuildId() === currentBuildId.value)
    writeAutoReloadedBuildId('')

  const hasUnsavedEdits = computed(() => {
    for (const dirty of editGuards.value.values()) {
      if (dirty)
        return true
    }
    return false
  })

  const reconnecting = computed(() => socketReconnecting.value || httpUnavailable.value)

  function clearFollowUpTimers(): void {
    for (const timer of followUpTimers)
      clearTimeout(timer)
    followUpTimers.clear()
  }

  function triggerReload(): void {
    clearFollowUpTimers()
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function')
      window.location.reload()
  }

  function observeBuildId(observedBuildId: string) {
    const candidate = String(observedBuildId || '').trim()
    const decision = evaluateWebBuildChange({
      currentBuildId: currentBuildId.value,
      observedBuildId: candidate,
      hasUnsavedEdits: hasUnsavedEdits.value,
      lastAutoReloadedBuildId: readAutoReloadedBuildId(),
    })

    if (decision === 'none') {
      if (candidate && candidate === currentBuildId.value) {
        pendingBuildId.value = ''
        updatePromptVisible.value = false
      }
      return 'none' as const
    }

    pendingBuildId.value = candidate
    if (decision === 'auto_reload' && writeAutoReloadedBuildId(candidate)) {
      updatePromptVisible.value = false
      triggerReload()
      return 'auto_reload' as const
    }

    updatePromptVisible.value = true
    return 'prompt_refresh' as const
  }

  function applyPendingUpdate(): void {
    if (pendingBuildId.value)
      writeAutoReloadedBuildId(pendingBuildId.value)
    updatePromptVisible.value = false
    triggerReload()
  }

  function notifyBackendReachable(): void {
    httpUnavailable.value = false
  }

  function notifyBackendUnavailable(): void {
    httpUnavailable.value = true
  }

  function setEditGuard(id: symbol, dirty: boolean): void {
    const next = new Map(editGuards.value)
    next.set(id, Boolean(dirty))
    editGuards.value = next
  }

  function removeEditGuard(id: symbol): void {
    if (!editGuards.value.has(id))
      return
    const next = new Map(editGuards.value)
    next.delete(id)
    editGuards.value = next
  }

  async function fetchVersionManifest(): Promise<string> {
    if (typeof fetch !== 'function')
      return ''
    const response = await fetch(`/version.json?t=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
      },
    })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as { buildId?: string }
    return String(data?.buildId || '').trim()
  }

  async function checkVersionNow(force = false): Promise<void> {
    if (currentBuildId.value === 'dev')
      return
    if (socketReconnecting.value && !force)
      return

    const currentTime = Date.now()
    if (!force && currentTime - lastCheckAt < 15_000)
      return

    if (inFlightCheck) {
      if (!force)
        return inFlightCheck
      await inFlightCheck
      if (inFlightCheck)
        return inFlightCheck
    }

    lastCheckAt = Date.now()
    const currentRun = (async () => {
      try {
        const buildId = await fetchVersionManifest()
        notifyBackendReachable()
        if (buildId)
          observeBuildId(buildId)
      }
      catch {
        // Silent best-effort check; transient network errors are handled elsewhere.
      }
    })().finally(() => {
      if (inFlightCheck === currentRun)
        inFlightCheck = null
    })

    inFlightCheck = currentRun
    return currentRun
  }

  function syncSocketState(isReconnecting: boolean, reconnectCount: number): void {
    const wasReconnecting = socketReconnecting.value
    socketReconnecting.value = Boolean(isReconnecting)

    if (socketReconnecting.value) {
      clearFollowUpTimers()
      return
    }

    const reconnected = wasReconnecting || reconnectCount > lastReconnectCount
    lastReconnectCount = reconnectCount
    if (reconnected) {
      notifyBackendReachable()
      clearFollowUpTimers()
      void checkVersionNow(true)
      for (const delay of [1500, 4000]) {
        const timer = setTimeout(() => {
          followUpTimers.delete(timer)
          void checkVersionNow(true)
        }, delay)
        followUpTimers.add(timer)
      }
    }
  }

  function onVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible')
      void checkVersionNow(false)
  }

  function onWindowFocus(): void {
    void checkVersionNow(false)
  }

  function onVitePreloadError(event: Event): void {
    if (currentBuildId.value === 'dev')
      return
    event.preventDefault?.()
    void checkVersionNow(true)
  }

  function startMonitoring(): void {
    if (monitoringActive)
      return
    monitoringActive = true

    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibilityChange)
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onWindowFocus)
      window.addEventListener('vite:preloadError', onVitePreloadError as EventListener)
    }

    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible')
        return
      void checkVersionNow(false)
    }, 30_000)
  }

  function stopMonitoring(): void {
    monitoringActive = false
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    clearFollowUpTimers()
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibilityChange)
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('vite:preloadError', onVitePreloadError as EventListener)
    }
  }

  return {
    currentBuildId,
    reconnecting,
    pendingBuildId,
    updatePromptVisible,
    hasUnsavedEdits,
    observeBuildId,
    applyPendingUpdate,
    notifyBackendReachable,
    notifyBackendUnavailable,
    setEditGuard,
    removeEditGuard,
    checkVersionNow,
    syncSocketState,
    startMonitoring,
    stopMonitoring,
  }
})
