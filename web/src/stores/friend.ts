import type { CareerHarvestSteal } from '@/components/CareerHarvestSteal.vue'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage, normalizeApiErrorMessage } from '@/api'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

export interface BlacklistItem {
  gid: number
  name: string
  avatarUrl: string
}

export interface KnownFriendSettings {
  knownFriendGids: number[]
  knownFriendGidSyncCooldownSec: number
  friendsListCacheTtlSec: number
}

interface KnownFriendSettingsReply {
  ok: boolean
  data: KnownFriendSettings
  addedCount?: number
  removedCount?: number
}

export interface FriendInteractionItemDto {
  id: string
  itemId: string
  name: string
  image: string
  count: number
  saleConditionSatisfiedCount: number
  interactionType: string
  protocol: 'item-use'
  selfUsable: boolean
  targetKind: 'land' | 'farm'
  description: string
  activityId: string
  sellCondition: string
  nearestExpireTime: number
  serverValidationRequired: boolean
}

export interface FriendInteractionResultDto {
  landId: string
  ok: boolean
  code: string
  message: string
  updatedLand?: any
  interactionEffects?: FriendInteractionEffectDto[]
  target?: any
}

export interface FriendInteractionEffectDto {
  landId: string
  itemId: string
  itemName?: string
  plantId?: string
  hostGid?: string
  effectType?: number
  activityId?: number
  usedAt?: number | string
  confirmed: boolean
  source: string
}

export interface FriendInteractionBatchDto {
  hostGid: string
  ownerName: string
  itemId: string
  itemName: string
  requestedLandIds: string[]
  usedLandIds: string[]
  failedLandIds: string[]
  successCount: number
  failureCount: number
  results: FriendInteractionResultDto[]
  updatedLands?: any[]
  interactionEffects?: FriendInteractionEffectDto[]
  items: FriendInteractionItemDto[]
  message: string
  targetKind?: 'land' | 'farm'
}

export const useFriendStore = defineStore('friend', () => {
  const friends = ref<any[]>([])
  const loading = ref(false)
  const friendsListState = ref<'unloaded' | 'ready' | 'partial' | 'error'>('unloaded')
  const friendsError = ref('')
  const accountStore = useAccountStore()
  const knownFriendSettings = ref<KnownFriendSettings | null>(null)
  const knownFriendGids = computed(() => knownFriendSettings.value?.knownFriendGids ?? [])
  const settingsRequest = ref<'load' | 'save' | null>(null)
  const knownFriendSettingsLoading = computed(() => settingsRequest.value === 'load')
  const knownFriendSettingsSaving = computed(() => settingsRequest.value === 'save')
  let settingsSequence = 0
  let friendsRequestSequence = 0
  watch(() => accountStore.currentAccountId, () => {
    settingsSequence++
    settingsRequest.value = null
    knownFriendSettings.value = null
    friendsRequestSequence++
    friends.value = []
    loading.value = false
    friendsListState.value = 'unloaded'
    friendsError.value = ''
  }, { flush: 'sync' })
  const friendLands = ref<Record<string, any[]>>({})
  const friendLandsLoading = ref<Record<string, boolean>>({})
  const friendLandsError = ref<Record<string, string>>({})
  const friendLandsLoaded = ref<Record<string, boolean>>({})
  const friendCareer = ref<Record<string, CareerHarvestSteal | null>>({})
  const blacklist = ref<BlacklistItem[]>([])
  const interactRecords = ref<any[]>([])
  const interactLoading = ref(false)
  const interactError = ref('')
  const interactionItems = ref<FriendInteractionItemDto[]>([])
  const interactionItemsLoading = ref(false)
  const interactionItemsError = ref('')
  const interactionUsePending = ref(false)
  const interactionUseError = ref('')
  const interactionItemsAccountId = ref('')
  const interactionUsedLandIds = ref<Record<string, string[]>>({})
  const friendLandOverlays = ref<Record<string, {
    lands: any[]
    effects: FriendInteractionEffectDto[]
    updatedAt: number
  }>>({})
  const FRIEND_LAND_OVERLAY_TTL_MS = 15 * 60 * 1000
  let friendLandRequestSequence = 0
  let interactionItemsRequestSequence = 0

  function normalizeLandId(value: unknown) {
    const text = String(value ?? '').trim()
    return /^\d+$/.test(text) && text !== '0' ? text : ''
  }

  function pruneFriendLandOverlays(now = Date.now()) {
    const next = { ...friendLandOverlays.value }
    let changed = false
    for (const [key, overlay] of Object.entries(next)) {
      if (!overlay || now - overlay.updatedAt > FRIEND_LAND_OVERLAY_TTL_MS) {
        delete next[key]
        changed = true
      }
    }
    if (changed)
      friendLandOverlays.value = next
  }

  function mergeLandUpdateList(landsInput: any[], updatesInput: any[]) {
    const lands = Array.isArray(landsInput) ? landsInput : []
    const updates = Array.isArray(updatesInput) ? updatesInput.filter(Boolean) : []
    if (updates.length === 0)
      return lands

    const byId = new Map(lands.map(land => [normalizeLandId(land?.id), land]))
    for (const update of updates) {
      const updateId = normalizeLandId(update?.id)
      if (!updateId)
        continue
      const occupiedIds = [...new Set([
        updateId,
        ...(Array.isArray(update?.occupiedLandIds) ? update.occupiedLandIds.map(normalizeLandId) : []),
      ].filter(Boolean))]
      const current = byId.get(updateId)
      byId.set(updateId, {
        ...(current || {}),
        ...update,
        id: current?.id ?? update.id,
        occupiedLandIds: occupiedIds,
      })
      for (const occupiedId of occupiedIds) {
        if (occupiedId === updateId)
          continue
        const slave = byId.get(occupiedId)
        if (!slave)
          continue
        byId.set(occupiedId, {
          ...slave,
          ...update,
          id: slave.id,
          unlocked: slave.unlocked,
          level: slave.level,
          maxLevel: slave.maxLevel,
          landsLevel: slave.landsLevel,
          landSize: slave.landSize,
          couldUnlock: slave.couldUnlock,
          couldUpgrade: slave.couldUpgrade,
          occupiedByMaster: true,
          masterLandId: Number(updateId),
          occupiedLandIds: occupiedIds,
        })
      }
    }

    const originalIds = new Set(lands.map(land => normalizeLandId(land?.id)))
    const merged = lands.map(land => byId.get(normalizeLandId(land?.id)) || land)
    for (const [id, land] of byId) {
      if (id && !originalIds.has(id))
        merged.push(land)
    }
    return merged
  }

  function applyFriendLandOverlay(friendId: string, landsInput: any[]) {
    pruneFriendLandOverlays()
    const overlay = friendLandOverlays.value[String(friendId)]
    if (!overlay)
      return Array.isArray(landsInput) ? landsInput : []
    // UseReply.land 是刚刚成功操作后的权威快照；在短期 overlay 有效期内，
    // 后续 Enter/AllLands 的旧快照不能覆盖它。TTL 到期后再完全信任服务端。
    let lands = mergeLandUpdateList(landsInput, overlay.lands)
    const effects = Array.isArray(overlay.effects) ? overlay.effects : []
    if (effects.length === 0)
      return lands
    lands = lands.map((land: any) => {
      const landId = normalizeLandId(land?.id)
      const occupiedIds = new Set([
        landId,
        ...(Array.isArray(land?.occupiedLandIds) ? land.occupiedLandIds.map(normalizeLandId) : []),
        normalizeLandId(land?.masterLandId),
      ].filter(Boolean))
      const plantId = normalizeLandId(land?.plantId)
      const visibleEffects = effects.filter(effect => (
        occupiedIds.has(normalizeLandId(effect?.landId))
        && (!normalizeLandId(effect?.plantId) || normalizeLandId(effect?.plantId) === plantId)
      ))
      if (visibleEffects.length === 0)
        return land
      const existing = Array.isArray(land?.interactionEffects) ? land.interactionEffects : []
      const seen = new Set(existing.map((effect: any) => `${effect?.itemId}:${effect?.landId}:${effect?.plantId || ''}:${effect?.usedAt || ''}`))
      const mergedEffects = [...existing]
      for (const effect of visibleEffects) {
        const key = `${effect.itemId}:${effect.landId}:${effect.plantId || ''}:${effect.usedAt || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          mergedEffects.push(effect)
        }
      }
      return { ...land, interactionEffects: mergedEffects }
    })
    return lands
  }

  function mergeFriendLandUpdates(
    friendIdInput: unknown,
    updatedLandsInput: any[],
    effectsInput: FriendInteractionEffectDto[] = [],
  ) {
    const key = String(friendIdInput || '')
    if (!key)
      return
    const updatedLands = Array.isArray(updatedLandsInput) ? updatedLandsInput.filter(Boolean) : []
    const effects = Array.isArray(effectsInput) ? effectsInput.filter(effect => !!effect?.confirmed) : []
    if (updatedLands.length === 0 && effects.length === 0)
      return
    const previous = friendLandOverlays.value[key]
    const mergedUpdates = mergeLandUpdateList(previous?.lands || [], updatedLands)
    friendLandOverlays.value = {
      ...friendLandOverlays.value,
      [key]: {
        lands: mergedUpdates,
        effects: [...(previous?.effects || []), ...effects].filter((effect, index, list) => (
          list.findIndex(item => `${item.itemId}:${item.landId}:${item.plantId || ''}:${item.usedAt || ''}` === `${effect.itemId}:${effect.landId}:${effect.plantId || ''}:${effect.usedAt || ''}`) === index
        )),
        updatedAt: Date.now(),
      },
    }
    const current = friendLands.value[key] || []
    const merged = applyFriendLandOverlay(key, mergeLandUpdateList(current, updatedLands))
    friendLands.value = { ...friendLands.value, [key]: merged }
    const friendSummary = friends.value.find(friend => String(friend?.gid || '') === key)
    if (friendSummary)
      syncFriendPlantSummary(key, merged, null)
  }

  function buildPlantSummaryFromDetail(lands: any[], summary: any) {
    let stealNum = 0
    let dryNum = 0
    let weedNum = 0
    let insectNum = 0

    const detailLands = Array.isArray(lands) ? lands : []
    if (detailLands.length > 0) {
      for (const land of detailLands) {
        if (!land || !land.unlocked)
          continue
        if (land.occupiedByMaster)
          continue
        if (land.status === 'stealable')
          stealNum++
        if (land.needWater)
          dryNum++
        if (land.needWeed)
          weedNum++
        if (land.needBug)
          insectNum++
      }
    }
    else {
      stealNum = Array.isArray(summary?.stealable) ? summary.stealable.length : 0
      dryNum = Array.isArray(summary?.needWater) ? summary.needWater.length : 0
      weedNum = Array.isArray(summary?.needWeed) ? summary.needWeed.length : 0
      insectNum = Array.isArray(summary?.needBug) ? summary.needBug.length : 0
    }

    return {
      stealNum: Number(stealNum) || 0,
      dryNum: Number(dryNum) || 0,
      weedNum: Number(weedNum) || 0,
      insectNum: Number(insectNum) || 0,
    }
  }

  function syncFriendPlantSummary(friendId: string, lands: any[], summary: any) {
    const key = String(friendId)
    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)
    if (idx < 0)
      return

    const nextPlant = buildPlantSummaryFromDetail(lands, summary)
    friends.value[idx] = {
      ...friends.value[idx],
      plant: nextPlant,
    }
  }

  async function fetchFriends(accountId: string, forceSync = false) {
    if (!accountId || accountId !== accountStore.currentAccountId)
      return
    const sequence = ++friendsRequestSequence
    loading.value = true
    try {
      const res = await api.get('/api/friends', {
        headers: { 'x-account-id': accountId },
        params: forceSync ? { forceSync: 'true' } : {},
        skipErrorToast: true,
      } as any)
      if (sequence !== friendsRequestSequence)
        return
      if (!res.data.ok)
        throw new Error(getApiErrorMessage(res.data, '读取好友列表失败'))
      friends.value = res.data.data
      friendsListState.value = res.data.partial ? 'partial' : 'ready'
      friendsError.value = ''
    }
    catch (error) {
      if (sequence === friendsRequestSequence) {
        friendsListState.value = 'error'
        friendsError.value = getApiErrorMessage(error, '读取好友列表失败')
      }
    }
    finally {
      if (sequence === friendsRequestSequence)
        loading.value = false
    }
  }

  async function fetchFriendsCache(accountId: string) {
    if (!accountId || accountId !== accountStore.currentAccountId || loading.value)
      return
    const sequence = friendsRequestSequence
    try {
      const res = await api.get('/api/friends/cache', { headers: { 'x-account-id': accountId } })
      if (sequence === friendsRequestSequence && res.data.ok && res.data.data?.length) {
        friends.value = res.data.data
        friendsListState.value = res.data.partial ? 'partial' : 'ready'
      }
    }
    catch { /* 保留已显示的列表 */ }
  }

  async function fetchInteractRecords(accountId: string) {
    if (!accountId)
      return
    interactLoading.value = true
    interactError.value = ''
    interactRecords.value = []

    try {
      const res = await api.get('/api/interact-records', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        interactRecords.value = Array.isArray(res.data.data) ? res.data.data : []
      }
      else {
        interactError.value = getApiErrorMessage(res.data, '加载访客记录失败')
      }
    }
    catch (error: any) {
      interactError.value = getApiErrorMessage(error, '加载访客记录失败')
    }
    finally {
      interactLoading.value = false
    }
  }

  async function fetchBlacklist(accountId: string) {
    if (!accountId)
      return
    try {
      const res = await api.get('/api/friend-blacklist', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        blacklist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleBlacklist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-blacklist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      blacklist.value = res.data.data || []
    }
  }

  async function deleteFriend(accountId: string, friend: { gid: number; name?: string; avatarUrl?: string }) {
    const gid = Number(friend?.gid)
    if (!accountId || !gid)
      return { ok: false, message: '参数无效' }
    try {
      const res = await api.post(`/api/friend/${gid}/delete`, {}, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok)
        return { ok: false, message: getApiErrorMessage(res.data, '删除好友失败') }

      const key = String(gid)
      friends.value = friends.value.filter(item => Number(item.gid) !== gid)
      const nextLands = { ...friendLands.value }
      const nextLandsLoading = { ...friendLandsLoading.value }
      const nextLandsError = { ...friendLandsError.value }
      const nextLandsLoaded = { ...friendLandsLoaded.value }
      const nextCareer = { ...friendCareer.value }
      delete nextLands[key]
      delete nextLandsLoading[key]
      delete nextLandsError[key]
      delete nextLandsLoaded[key]
      delete nextCareer[key]
      friendLands.value = nextLands
      friendLandsLoading.value = nextLandsLoading
      friendLandsError.value = nextLandsError
      friendLandsLoaded.value = nextLandsLoaded
      friendCareer.value = nextCareer

      await Promise.all([
        fetchBlacklist(accountId),
        fetchKnownFriendSettings(accountId),
      ])
      const displayName = String(friend.name || '').trim()
      const displayAvatar = String(friend.avatarUrl || '').trim()
      const existing = blacklist.value.find(item => Number(item.gid) === gid)
      if (!existing) {
        blacklist.value = [
          ...blacklist.value,
          { gid, name: displayName, avatarUrl: displayAvatar },
        ]
      }
      else if ((!existing.name && displayName) || (!existing.avatarUrl && displayAvatar)) {
        blacklist.value = blacklist.value.map(item => Number(item.gid) === gid
          ? {
              ...item,
              name: item.name || displayName,
              avatarUrl: item.avatarUrl || displayAvatar,
            }
          : item)
      }
      return { ok: true, message: res.data?.message || '删除好友成功' }
    }
    catch (e: any) {
      return { ok: false, message: getApiErrorMessage(e, '删除好友失败') }
    }
  }

  async function fetchFriendLands(accountId: string, friendId: string) {
    if (!accountId || !friendId)
      return false
    const sequence = ++friendLandRequestSequence
    const key = String(friendId)
    friendLandsLoading.value[key] = true
    friendLandsError.value[key] = ''
    friendLandsLoaded.value[key] = false
    try {
      const res = await api.get(`/api/friend/${key}/lands`, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (sequence !== friendLandRequestSequence)
        return false
      if (res.data.ok) {
        const lands = applyFriendLandOverlay(key, res.data.data.lands || [])
        const summary = res.data.data.summary || null
        friendLands.value[key] = lands
        friendCareer.value = { ...friendCareer.value, [key]: res.data.data.career || null }
        syncFriendPlantSummary(key, lands, summary)
        return true
      }
      friendLands.value[key] = []
      friendCareer.value = { ...friendCareer.value, [key]: null }
      friendLandsError.value[key] = getApiErrorMessage(res.data, '无法读取好友土地')
      return false
    }
    catch (error: any) {
      if (sequence !== friendLandRequestSequence)
        return false
      friendLands.value[key] = []
      friendCareer.value = { ...friendCareer.value, [key]: null }
      friendLandsError.value[key] = getApiErrorMessage(error, '无法读取好友土地，请稍后重试')
      return false
    }
    finally {
      if (sequence === friendLandRequestSequence) {
        friendLandsLoaded.value[key] = true
        friendLandsLoading.value[key] = false
      }
    }
  }

  function resetFriendLandState() {
    friendLandRequestSequence++
    friendLands.value = {}
    friendLandsLoading.value = {}
    friendLandsError.value = {}
    friendLandsLoaded.value = {}
    friendCareer.value = {}
    friendLandOverlays.value = {}
  }

  async function operate(accountId: string, friendId: string, opType: string) {
    if (!accountId || !friendId)
      return { ok: false, message: '参数无效' }
    try {
      const res = await api.post(`/api/friend/${friendId}/op`, { opType }, {
        headers: { 'x-account-id': accountId },
      })
      if (!res.data?.ok) {
        if (res.data?.reason === 'invalid_removed' && accountId === accountStore.currentAccountId) {
          await Promise.all([fetchKnownFriendSettings(accountId), fetchFriends(accountId)])
        }
        return {
          ok: false,
          message: getApiErrorMessage(res.data, '操作失败'),
        }
      }
      const result = res.data?.data || res.data || {}
      if (result && typeof result.message === 'string')
        result.message = normalizeApiErrorMessage(result.message)
      await fetchFriends(accountId)
      if (accountId === accountStore.currentAccountId && friendLands.value[friendId]) {
        await fetchFriendLands(accountId, friendId)
      }
      return result
    }
    catch (e: any) {
      return { ok: false, message: getApiErrorMessage(e, '操作失败') }
    }
  }

  function interactionUsageKey(accountId: string, itemId: unknown, friendId: unknown) {
    return `${String(accountId || '')}:${String(itemId || '')}:${String(friendId || '')}`
  }

  function getInteractionUsedLandIds(accountId: string, itemId: unknown, friendId: unknown) {
    return interactionUsedLandIds.value[interactionUsageKey(accountId, itemId, friendId)] || []
  }

  function recordInteractionUsage(accountId: string, result: FriendInteractionBatchDto) {
    const key = interactionUsageKey(accountId, result.itemId, result.hostGid)
    const used = new Set(interactionUsedLandIds.value[key] || [])
    for (const landId of result.usedLandIds || [])
      used.add(String(landId))
    interactionUsedLandIds.value = {
      ...interactionUsedLandIds.value,
      [key]: [...used].sort((left, right) => Number(left) - Number(right)),
    }
  }

  async function fetchInteractionItems(accountId: string) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId)
      return false
    const sequence = ++interactionItemsRequestSequence
    if (interactionItemsAccountId.value !== requestedAccountId) {
      interactionItems.value = []
      interactionItemsAccountId.value = requestedAccountId
    }
    interactionItemsLoading.value = true
    interactionItemsError.value = ''
    try {
      const res = await api.get('/api/friend-interaction-items', {
        headers: { 'x-account-id': requestedAccountId },
        skipErrorToast: true,
      } as any)
      if (sequence !== interactionItemsRequestSequence)
        return false
      if (!res.data?.ok) {
        interactionItems.value = []
        interactionItemsError.value = getApiErrorMessage(res.data, '无法读取特殊互动道具')
        return false
      }
      interactionItems.value = Array.isArray(res.data?.data?.items) ? res.data.data.items : []
      return true
    }
    catch (error: any) {
      if (sequence !== interactionItemsRequestSequence)
        return false
      interactionItems.value = []
      interactionItemsError.value = getApiErrorMessage(error, '无法读取特殊互动道具')
      return false
    }
    finally {
      if (sequence === interactionItemsRequestSequence)
        interactionItemsLoading.value = false
    }
  }

  async function useInteractionItemBatch(accountId: string, friendId: string, itemId: string, landIds: string[]) {
    if (!accountId || !friendId || !itemId || !Array.isArray(landIds) || landIds.length === 0)
      return false
    if (interactionUsePending.value)
      return false
    interactionUsePending.value = true
    interactionUseError.value = ''
    try {
      const res = await api.post(`/api/friend/${encodeURIComponent(friendId)}/interaction-items/use-batch`, {
        itemId,
        landIds,
      }, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok) {
        interactionUseError.value = getApiErrorMessage(res.data, '特殊互动道具使用失败')
        return false
      }
      const result = res.data.data as FriendInteractionBatchDto
      if (Array.isArray(result?.items))
        interactionItems.value = result.items
      if (result && typeof result.message === 'string')
        result.message = normalizeApiErrorMessage(result.message)
      for (const item of result?.results || []) {
        if (item && typeof item.message === 'string')
          item.message = normalizeApiErrorMessage(item.message)
      }
      recordInteractionUsage(accountId, result)
      mergeFriendLandUpdates(result?.hostGid || friendId, result?.updatedLands || [], result?.interactionEffects || [])
      return result
    }
    catch (error: any) {
      interactionUseError.value = getApiErrorMessage(error, '特殊互动道具使用失败')
      return false
    }
    finally {
      interactionUsePending.value = false
    }
  }

  async function useFarmInteractionItem(accountId: string, friendId: string, itemId: string) {
    if (!accountId || !friendId || !itemId || interactionUsePending.value)
      return false
    interactionUsePending.value = true
    interactionUseError.value = ''
    try {
      const res = await api.post(`/api/friend/${encodeURIComponent(friendId)}/interaction-items/use-farm`, {
        itemId,
      }, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok) {
        interactionUseError.value = getApiErrorMessage(res.data, '好友农场道具使用失败')
        return false
      }
      const result = res.data.data as FriendInteractionBatchDto
      if (result && typeof result.message === 'string')
        result.message = normalizeApiErrorMessage(result.message)
      for (const item of result?.results || []) {
        if (item && typeof item.message === 'string')
          item.message = normalizeApiErrorMessage(item.message)
      }
      if (Array.isArray(result?.items))
        interactionItems.value = result.items
      return result
    }
    catch (error: any) {
      interactionUseError.value = getApiErrorMessage(error, '好友农场道具使用失败')
      return false
    }
    finally {
      interactionUsePending.value = false
    }
  }

  function resetInteractionState() {
    interactionItemsRequestSequence++
    interactionItems.value = []
    interactionItemsLoading.value = false
    interactionItemsError.value = ''
    interactionUseError.value = ''
    interactionItemsAccountId.value = ''
    interactionUsedLandIds.value = {}
    friendLandOverlays.value = {}
  }

  async function requestKnownFriendSettings(accountId: string, change?: { suffix?: string, body: unknown }) {
    if (!accountId || accountId !== accountStore.currentAccountId || knownFriendSettingsSaving.value)
      return null
    const sequence = ++settingsSequence
    settingsRequest.value = change ? 'save' : 'load'
    const options = { headers: { 'x-account-id': accountId }, skipErrorToast: true }
    const path = '/api/friend-known-gids'
    const failure = change ? '保存好友设置失败' : '读取好友设置失败'
    try {
      const res = change
        ? await api.post<KnownFriendSettingsReply>(path + (change.suffix ?? ''), change.body, options)
        : await api.get<KnownFriendSettingsReply>(path, options)
      if (sequence !== settingsSequence)
        return null
      if (!res.data?.ok || !res.data.data)
        throw new Error(getApiErrorMessage(res.data, failure))
      knownFriendSettings.value = res.data.data
      return res.data
    }
    catch (error) {
      if (sequence === settingsSequence)
        useToastStore().error(getApiErrorMessage(error, failure))
      return null
    }
    finally {
      if (sequence === settingsSequence)
        settingsRequest.value = null
    }
  }

  function fetchKnownFriendSettings(accountId: string) {
    return requestKnownFriendSettings(accountId)
  }

  function saveKnownFriendSettings(accountId: string, payload: Partial<KnownFriendSettings>) {
    return requestKnownFriendSettings(accountId, { body: payload })
  }

  async function removeKnownFriendGid(accountId: string, gid: number) {
    return !!gid && !!await requestKnownFriendSettings(accountId, { suffix: '/remove', body: { gid } })
  }

  async function batchAddKnownFriendGids(accountId: string, gids: number[]) {
    const result = gids.length ? await requestKnownFriendSettings(accountId, { suffix: '/batch-add', body: { gids } }) : null
    return { ok: !!result, addedCount: result?.addedCount || 0 }
  }

  async function removeUnsyncedKnownFriendGids(accountId: string, gids: number[]) {
    const result = gids.length ? await requestKnownFriendSettings(accountId, { suffix: '/batch-remove', body: { gids } }) : null
    return { ok: !!result, removedCount: result?.removedCount || 0 }
  }

  return {
    friends,
    loading,
    friendsListState,
    friendsError,
    friendLands,
    friendLandsLoading,
    friendLandsError,
    friendLandsLoaded,
    friendCareer,
    blacklist,
    interactRecords,
    interactLoading,
    interactError,
    interactionItems,
    interactionItemsLoading,
    interactionItemsError,
    interactionUsePending,
    interactionUseError,
    knownFriendGids,
    knownFriendSettings,
    knownFriendSettingsLoading,
    knownFriendSettingsSaving,
    fetchFriends,
    fetchFriendsCache,
    fetchBlacklist,
    toggleBlacklist,
    deleteFriend,
    fetchInteractRecords,
    fetchFriendLands,
    resetFriendLandState,
    operate,
    fetchInteractionItems,
    useInteractionItemBatch,
    useFarmInteractionItem,
    getInteractionUsedLandIds,
    resetInteractionState,
    fetchKnownFriendSettings,
    saveKnownFriendSettings,
    removeKnownFriendGid,
    batchAddKnownFriendGids,
    removeUnsyncedKnownFriendGids,
  }
})
