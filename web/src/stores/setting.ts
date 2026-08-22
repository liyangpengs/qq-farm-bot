import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface AutomationConfig {
  farm?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  task?: boolean
  sell?: boolean
  fertilizer?: string
  fertilizer_multi_season?: boolean
  fertilizer_land_types?: string[]
  fertilizer_smart_seconds?: number
  friend_steal?: boolean
  friend_help?: boolean
  friend_bad?: boolean
  friend_help_exp_limit?: boolean
  fertilizer_gift?: boolean
  fertilizer_buy_organic?: boolean
  fertilizer_buy_normal?: boolean
  mystery_shop_auto_buy?: boolean
  mystery_shop_allow_gold?: boolean
  mystery_shop_allow_coupon?: boolean
  mystery_shop_allow_gold_bean?: boolean
  mystery_shop_allow_diamond?: boolean
  mystery_shop_arrival_notify?: boolean
  mystery_shop_purchase_notify?: boolean
  skip_own_weed_bug?: boolean
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
  continueFarm?: boolean
}

export interface OfflineConfig {
  channel: string
  endpoint: string
  token: string
  secret: string
  title: string
  msg: string
  offlineDeleteSec: number
}

export interface UIConfig {
  theme?: string
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  bagSeedPriority: number[]
  bagSeedFallbackStrategy: string
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  automation: AutomationConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
}

type SaveableSettingsKey
  = | 'plantingStrategy'
    | 'preferredSeedId'
    | 'bagSeedPriority'
    | 'bagSeedFallbackStrategy'
    | 'intervals'
    | 'friendQuietHours'
    | 'automation'
    | 'stealDelaySeconds'
    | 'plantOrderRandom'
    | 'plantDelaySeconds'
    | 'fertilizerBuyOrganicCount'
    | 'fertilizerBuyOrganicThresholdHours'
    | 'fertilizerBuyNormalCount'
    | 'fertilizerBuyNormalThresholdHours'
    | 'fertilizerBuyCheckIntervalMinutes'

export type SettingsSavePayload = Partial<Pick<SettingsState, SaveableSettingsKey>>

const SAVEABLE_SETTINGS_KEYS: SaveableSettingsKey[] = [
  'plantingStrategy',
  'preferredSeedId',
  'bagSeedPriority',
  'bagSeedFallbackStrategy',
  'intervals',
  'friendQuietHours',
  'automation',
  'stealDelaySeconds',
  'plantOrderRandom',
  'plantDelaySeconds',
  'fertilizerBuyOrganicCount',
  'fertilizerBuyOrganicThresholdHours',
  'fertilizerBuyNormalCount',
  'fertilizerBuyNormalThresholdHours',
  'fertilizerBuyCheckIntervalMinutes',
]

function createDefaultSettings(): SettingsState {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    bagSeedPriority: [],
    bagSeedFallbackStrategy: 'level',
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
    automation: {},
    ui: {},
    offlineReminder: {
      channel: 'webhook',
      endpoint: '',
      token: '',
      secret: '',
      title: '账号下线提醒',
      msg: '账号下线',
      offlineDeleteSec: 0,
    },
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null)
    return value
  return JSON.parse(JSON.stringify(value))
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>(createDefaultSettings())
  const loading = ref(false)
  const loadedAccountId = ref('')
  let pendingRequests = 0
  let fetchRevision = 0
  let latestRequestedAccountId = ''

  function beginRequest() {
    pendingRequests++
    loading.value = true
  }

  function endRequest() {
    pendingRequests = Math.max(0, pendingRequests - 1)
    loading.value = pendingRequests > 0
  }

  function applyFetchedSettings(data: any) {
    const defaults = createDefaultSettings()
    settings.value = {
      plantingStrategy: data.strategy || defaults.plantingStrategy,
      preferredSeedId: data.preferredSeed || defaults.preferredSeedId,
      bagSeedPriority: cloneValue(data.bagSeedPriority ?? defaults.bagSeedPriority),
      bagSeedFallbackStrategy: data.bagSeedFallbackStrategy ?? defaults.bagSeedFallbackStrategy,
      intervals: cloneValue(data.intervals || defaults.intervals),
      friendQuietHours: {
        ...defaults.friendQuietHours,
        ...(cloneValue(data.friendQuietHours) || {}),
      },
      automation: cloneValue(data.automation || defaults.automation),
      ui: cloneValue(data.ui || defaults.ui),
      offlineReminder: {
        ...defaults.offlineReminder,
        ...(cloneValue(data.offlineReminder) || {}),
      },
      stealDelaySeconds: data.stealDelaySeconds ?? defaults.stealDelaySeconds,
      plantOrderRandom: data.plantOrderRandom ?? defaults.plantOrderRandom,
      plantDelaySeconds: data.plantDelaySeconds ?? defaults.plantDelaySeconds,
      fertilizerBuyOrganicCount: data.fertilizerBuyOrganicCount ?? defaults.fertilizerBuyOrganicCount,
      fertilizerBuyOrganicThresholdHours: data.fertilizerBuyOrganicThresholdHours ?? defaults.fertilizerBuyOrganicThresholdHours,
      fertilizerBuyNormalCount: data.fertilizerBuyNormalCount ?? defaults.fertilizerBuyNormalCount,
      fertilizerBuyNormalThresholdHours: data.fertilizerBuyNormalThresholdHours ?? defaults.fertilizerBuyNormalThresholdHours,
      fertilizerBuyCheckIntervalMinutes: data.fertilizerBuyCheckIntervalMinutes ?? defaults.fertilizerBuyCheckIntervalMinutes,
    }
  }

  function applySavedSettings(payload: SettingsSavePayload, data: any) {
    const normalized = data && typeof data === 'object' ? data : {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, key))
        (settings.value as any)[key] = cloneValue(payload[key])
      if (Object.prototype.hasOwnProperty.call(normalized, key))
        (settings.value as any)[key] = cloneValue(normalized[key])
    }

    if (normalized.strategy !== undefined)
      settings.value.plantingStrategy = normalized.strategy || 'max_exp'
    if (normalized.preferredSeed !== undefined)
      settings.value.preferredSeedId = normalized.preferredSeed || 0
  }

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return false
    const requestRevision = ++fetchRevision
    latestRequestedAccountId = accountId
    loadedAccountId.value = ''
    beginRequest()
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      if (requestRevision !== fetchRevision)
        return false
      if (data && data.ok && data.data) {
        applyFetchedSettings(data.data)
        loadedAccountId.value = accountId
        return true
      }
      return false
    }
    finally {
      endRequest()
    }
  }

  async function saveSettings(accountId: string, newSettings: SettingsSavePayload) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }

    const payload: SettingsSavePayload = {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(newSettings, key))
        (payload as any)[key] = cloneValue(newSettings[key])
    }

    if (Object.keys(payload).length === 0)
      return { ok: false, error: '没有需要保存的设置' }

    beginRequest()
    try {
      const { data } = await api.post('/api/settings/save', payload, {
        headers: { 'x-account-id': accountId },
        timeout: 15000,
      })
      if (!data?.ok) {
        if (data?.saved && (!latestRequestedAccountId || latestRequestedAccountId === accountId)) {
          loadedAccountId.value = accountId
          applySavedSettings(payload, data.data)
        }
        return {
          ok: false,
          saved: !!data?.saved,
          unconfirmed: !!data?.unconfirmed,
          data: data?.data,
          error: data?.error || '保存失败',
        }
      }

      if (!latestRequestedAccountId || latestRequestedAccountId === accountId) {
        loadedAccountId.value = accountId
        applySavedSettings(payload, data.data)
      }
      return { ok: true, data: data.data }
    }
    catch (error: any) {
      return { ok: false, error: error?.response?.data?.error || error?.message || '保存失败' }
    }
    finally {
      endRequest()
    }
  }

  async function saveOfflineConfig(config: OfflineConfig) {
    beginRequest()
    try {
      const { data } = await api.post('/api/settings/offline-reminder', config)
      if (data && data.ok) {
        settings.value.offlineReminder = cloneValue(config)
        return { ok: true }
      }
      return { ok: false, error: '保存失败' }
    }
    catch (error: any) {
      return { ok: false, error: error?.response?.data?.error || error?.message || '保存失败' }
    }
    finally {
      endRequest()
    }
  }

  return { settings, loading, loadedAccountId, fetchSettings, saveSettings, saveOfflineConfig }
})
