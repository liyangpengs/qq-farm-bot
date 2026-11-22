import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface UpdateStatus {
  state?: 'idle' | 'running' | 'success' | 'failed' | 'unknown'
  step?: string
  hasUpdate?: boolean
  behind?: number
  deployedSha?: string
  deployedShort?: string
  latestSha?: string
  latestShort?: string
  commits?: string[]
  message?: string
  checkedAt?: number
  requestPending?: boolean
}

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus | null>(null)
  const checking = ref(false)
  const modalOpen = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function fetchStatus() {
    try {
      const res = await api.get('/api/update/status', { skipErrorToast: true } as any)
      status.value = (res.data && res.data.data) || null
    }
    catch {
      // Panel temporarily unavailable (e.g. mid-update restart); retry later.
    }
    schedule()
  }

  function schedule() {
    const busy = status.value?.state === 'running' || status.value?.requestPending
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(fetchStatus, busy ? 3000 : 60000)
  }

  async function check() {
    checking.value = true
    try {
      await api.post('/api/update/check', {}, { skipErrorToast: true } as any)
      setTimeout(fetchStatus, 2500)
    }
    finally {
      checking.value = false
    }
  }

  async function apply() {
    await api.post('/api/update/apply', {}, { skipErrorToast: true } as any)
    await fetchStatus()
  }

  return { status, checking, modalOpen, fetchStatus, check, apply }
})
