import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

type RanchFeedStage = 'any' | 'longest' | 'to_production' | 'near_harvest'

export interface AutomationConfig {
  ranch_harvest?: boolean
  ranch_produce?: boolean
  ranch_buy?: boolean
  ranch_upgrade?: boolean
  ranch_activate_shed?: boolean
  ranch_sell?: boolean
  ranch_market_organic?: boolean
  ranch_market_organic_poop?: boolean
  ranch_market_organic_pinecone?: boolean
  ranch_grass?: boolean
  ranch_grass_buy?: boolean
  ranch_grass_threshold_percent?: number
  ranch_fill_cans?: boolean
  ranch_feed_normal?: boolean
  ranch_feed_normal_stage?: RanchFeedStage
  ranch_feed_organic?: boolean
  ranch_feed_organic_stage?: RanchFeedStage
  ranch_clean?: boolean
  ranch_stroke?: boolean
  ranch_friend_steal?: boolean
  ranch_friend_produce?: boolean
  ranch_friend_clean?: boolean
  ranch_friend_mosquito?: boolean
  ranch_task?: boolean
  ranch_illustrated?: boolean
  ranch_share?: boolean
  ranch_daily_benefit?: boolean
  ranch_check_minutes?: number
  ranch_strategy?: string
  ranch_bag_fallback?: string
  ranch_coop_animal?: number
  ranch_shed_animal?: number
  ranch_coop_cub_priority?: number[]
  ranch_shed_cub_priority?: number[]
  farm?: boolean
  farm_harvest_tiangong?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  friend_auto_accept?: boolean
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
  friend_help_protect_dog_ignore_exp_limit?: boolean
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
  show_manual_fertilizer?: boolean
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

export interface PushChannelOption {
  label: string
  value: string
  docUrl: string
}

export const PUSH_CHANNEL_OPTIONS: PushChannelOption[] = [
  { label: 'Webhook(自定义接口)', value: 'webhook', docUrl: '' },
  { label: 'Qmsg 酱', value: 'qmsg', docUrl: 'https://qmsg.zendee.cn/' },
  { label: 'Server 酱', value: 'serverchan', docUrl: 'https://sct.ftqq.com/' },
  { label: 'Push Plus', value: 'pushplus', docUrl: 'https://www.pushplus.plus/' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip', docUrl: 'https://pushplus.hxtrip.com/' },
  { label: '钉钉', value: 'dingtalk', docUrl: 'https://open.dingtalk.com/document/orgapp/customize-robot-security-settings' },
  { label: '企业微信', value: 'wecom', docUrl: 'https://guole.fun/posts/626/' },
  { label: 'Bark', value: 'bark', docUrl: 'https://github.com/Finb/Bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp', docUrl: 'https://docs.go-cqhttp.org/api/' },
  { label: 'OneBot', value: 'onebot', docUrl: 'https://docs.go-cqhttp.org/api/' },
  { label: 'Atri', value: 'atri', docUrl: 'https://blog.tianli0.top/' },
  { label: 'PushDeer', value: 'pushdeer', docUrl: 'https://www.pushdeer.com/' },
  { label: 'iGot', value: 'igot', docUrl: 'https://push.hellyw.com/' },
  { label: 'Telegram', value: 'telegram', docUrl: 'https://core.telegram.org/bots' },
  { label: '飞书', value: 'feishu', docUrl: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973' },
  { label: 'IFTTT', value: 'ifttt', docUrl: 'https://ifttt.com/maker_webhooks' },
  { label: '企业微信群机器人', value: 'wecombot', docUrl: 'https://developer.work.weixin.qq.com/document/path/91770' },
  { label: 'Discord', value: 'discord', docUrl: 'https://discord.com/developers/docs/resources/webhook#execute-webhook' },
  { label: 'WxPusher', value: 'wxpusher', docUrl: 'https://wxpusher.zjiecode.com/docs/#/' },
  { label: 'MeoW', value: 'meow', docUrl: 'https://www.chuckfang.com/MeoW/api_doc.html' },
]

export interface OfflineChannelConfig {
  channel: string
  enabled: boolean
  endpoint: string
  token: string
  secret: string
}

export type PushChannelChange = Pick<OfflineChannelConfig, 'channel' | 'enabled'> & Partial<OfflineChannelConfig>

export interface OfflineConfig {
  notificationTypes?: {
    offline: boolean
    mysteryArrival: boolean
    mysteryPurchase: boolean
  }
  channel: string
  endpoint: string
  token: string
  secret: string
  channels: OfflineChannelConfig[]
  title: string
  msg: string
  offlineDeleteSec: number
}

const VALID_PUSH_CHANNELS = new Set(PUSH_CHANNEL_OPTIONS.map(item => item.value))

export function getPushChannelLabel(channel: string): string {
  const key = String(channel || '').trim().toLowerCase()
  return PUSH_CHANNEL_OPTIONS.find(item => item.value === key)?.label || key || '未知渠道'
}

export function getPushChannelDocUrl(channel: string): string {
  const key = String(channel || '').trim().toLowerCase()
  return PUSH_CHANNEL_OPTIONS.find(item => item.value === key)?.docUrl || ''
}

export function isPushChannelConfigured(input?: Partial<OfflineChannelConfig>): boolean {
  if (!input)
    return false
  const channel = String(input.channel || '').trim().toLowerCase()
  if (!VALID_PUSH_CHANNELS.has(channel))
    return false
  const endpoint = String(input.endpoint || '').trim()
  const token = String(input.token || '').trim()
  if (channel === 'webhook')
    return endpoint.length > 0
  if (channel === 'dingtalk')
    return endpoint.length > 0 || token.length > 0
  return token.length > 0
}

export function validateDingTalkWebhook(endpointInput: string): string {
  const endpoint = String(endpointInput || '').trim()
  if (!endpoint)
    return '请填写钉钉机器人设置页提供的完整 Webhook 地址'
  try {
    const url = new URL(endpoint)
    const isOfficialWebhook = url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
      && url.pathname === '/robot/send'
      && !!url.searchParams.get('access_token')
    if (!isOfficialWebhook)
      return '钉钉 Webhook 地址格式不正确，请从群机器人设置页重新复制'
  }
  catch {
    return '钉钉 Webhook 地址格式不正确，请从群机器人设置页重新复制'
  }
  return ''
}

export function normalizeChannelEntry(raw: Partial<OfflineChannelConfig> | null | undefined): OfflineChannelConfig | null {
  if (!raw || typeof raw !== 'object')
    return null
  const channel = String(raw.channel || '').trim().toLowerCase()
  if (!VALID_PUSH_CHANNELS.has(channel))
    return null
  let endpoint = String(raw.endpoint || '').trim()
  let token = String(raw.token || '').trim()
  const secret = String(raw.secret || '').trim()

  if (channel === 'dingtalk') {
    if (!endpoint && token) {
      endpoint = /^https?:\/\//i.test(token)
        ? token
        : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`
    }
    token = ''
  }

  const configured = isPushChannelConfigured({ channel, endpoint, token })
  if (!configured && !endpoint && !token && !secret)
    return null

  return {
    channel,
    enabled: raw.enabled === true && configured,
    endpoint,
    token,
    secret,
  }
}

export function normalizeOfflineConfig(config?: Partial<OfflineConfig>): OfflineConfig {
  const rawChannel = String(config?.channel || 'webhook').trim().toLowerCase()
  let channel = VALID_PUSH_CHANNELS.has(rawChannel) ? rawChannel : 'webhook'
  let endpoint = String(config?.endpoint ?? '').trim()
  let token = String(config?.token ?? '').trim()
  let secret = String(config?.secret ?? '').trim()

  const hasExplicitChannels = Array.isArray(config?.channels)
  const channels: OfflineChannelConfig[] = []
  if (hasExplicitChannels) {
    const map = new Map<string, OfflineChannelConfig>()
    for (const item of config!.channels!) {
      const normalized = normalizeChannelEntry(item)
      if (!normalized)
        continue
      if (map.has(normalized.channel))
        map.delete(normalized.channel)
      map.set(normalized.channel, normalized)
    }
    channels.push(...map.values())
  }
  else {
    const migrated = normalizeChannelEntry({ channel, endpoint, token, secret, enabled: true })
    if (migrated && isPushChannelConfigured(migrated))
      channels.push(migrated)
  }

  const primary = channels.find(c => c.enabled)
  if (primary) {
    channel = primary.channel
    endpoint = primary.endpoint
    token = primary.token
    secret = primary.secret
  }
  else if (hasExplicitChannels) {
    channel = 'webhook'
    endpoint = ''
    token = ''
    secret = ''
  }

  const parsedDeleteSec = Number.parseInt(String(config?.offlineDeleteSec ?? 0), 10)
  return {
    channel,
    endpoint,
    token,
    secret,
    channels,
    notificationTypes: config?.notificationTypes ? { ...config.notificationTypes } : undefined,
    title: typeof config?.title === 'string' ? config.title : '账号下线提醒',
    msg: typeof config?.msg === 'string' ? config.msg : '账号下线',
    offlineDeleteSec: Number.isFinite(parsedDeleteSec) && parsedDeleteSec >= 0 ? parsedDeleteSec : 0,
  }
}

export interface UIConfig {
  theme?: string
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  bagSeedPriority: number[]
  bagSeedMultiLandReservationEnabled: boolean
  bagSeedLandTypes: Record<string, string[]>
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
  emailClaimHour: number
  autoAcceptFriendMinLevel: number
  autoAcceptRequireOwnLevel: boolean
  autoAcceptHarvestStealEnabled: boolean
  autoAcceptHarvestStealHarvest: number
  autoAcceptHarvestStealSteal: number
}

type SaveableSettingsKey
  = | 'plantingStrategy'
    | 'preferredSeedId'
    | 'bagSeedPriority'
    | 'bagSeedMultiLandReservationEnabled'
    | 'bagSeedLandTypes'
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
    | 'emailClaimHour'
    | 'autoAcceptFriendMinLevel'
    | 'autoAcceptRequireOwnLevel'
    | 'autoAcceptHarvestStealEnabled'
    | 'autoAcceptHarvestStealHarvest'
    | 'autoAcceptHarvestStealSteal'

export type SettingsSavePayload = Partial<Pick<SettingsState, SaveableSettingsKey>>

const SAVEABLE_SETTINGS_KEYS: SaveableSettingsKey[] = [
  'plantingStrategy',
  'preferredSeedId',
  'bagSeedPriority',
  'bagSeedMultiLandReservationEnabled',
  'bagSeedLandTypes',
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
  'emailClaimHour',
  'autoAcceptFriendMinLevel',
  'autoAcceptRequireOwnLevel',
  'autoAcceptHarvestStealEnabled',
  'autoAcceptHarvestStealHarvest',
  'autoAcceptHarvestStealSteal',
]

function createDefaultSettings(): SettingsState {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
    automation: {},
    ui: {},
    offlineReminder: normalizeOfflineConfig(),
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    emailClaimHour: 10,
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null)
    return value
  return JSON.parse(JSON.stringify(value))
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>(createDefaultSettings())
  const supportsPushChannels = ref<boolean | null>(null)
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
    supportsPushChannels.value = Array.isArray(data.offlineReminder?.channels)
    const defaults = createDefaultSettings()
    settings.value = {
      plantingStrategy: data.strategy || defaults.plantingStrategy,
      preferredSeedId: data.preferredSeed || defaults.preferredSeedId,
      bagSeedPriority: cloneValue(data.bagSeedPriority ?? defaults.bagSeedPriority),
      bagSeedMultiLandReservationEnabled: data.bagSeedMultiLandReservationEnabled ?? defaults.bagSeedMultiLandReservationEnabled,
      bagSeedLandTypes: cloneValue(data.bagSeedLandTypes ?? defaults.bagSeedLandTypes),
      bagSeedFallbackStrategy: data.bagSeedFallbackStrategy ?? defaults.bagSeedFallbackStrategy,
      intervals: cloneValue(data.intervals || defaults.intervals),
      friendQuietHours: {
        ...defaults.friendQuietHours,
        ...(cloneValue(data.friendQuietHours) || {}),
      },
      automation: cloneValue(data.automation || defaults.automation),
      ui: cloneValue(data.ui || defaults.ui),
      offlineReminder: normalizeOfflineConfig(data.offlineReminder),
      stealDelaySeconds: data.stealDelaySeconds ?? defaults.stealDelaySeconds,
      plantOrderRandom: data.plantOrderRandom ?? defaults.plantOrderRandom,
      plantDelaySeconds: data.plantDelaySeconds ?? defaults.plantDelaySeconds,
      fertilizerBuyOrganicCount: data.fertilizerBuyOrganicCount ?? defaults.fertilizerBuyOrganicCount,
      fertilizerBuyOrganicThresholdHours: data.fertilizerBuyOrganicThresholdHours ?? defaults.fertilizerBuyOrganicThresholdHours,
      fertilizerBuyNormalCount: data.fertilizerBuyNormalCount ?? defaults.fertilizerBuyNormalCount,
      fertilizerBuyNormalThresholdHours: data.fertilizerBuyNormalThresholdHours ?? defaults.fertilizerBuyNormalThresholdHours,
      fertilizerBuyCheckIntervalMinutes: data.fertilizerBuyCheckIntervalMinutes ?? defaults.fertilizerBuyCheckIntervalMinutes,
      emailClaimHour: data.emailClaimHour ?? defaults.emailClaimHour,
      autoAcceptFriendMinLevel: data.autoAcceptFriendMinLevel ?? defaults.autoAcceptFriendMinLevel,
      autoAcceptRequireOwnLevel: data.autoAcceptRequireOwnLevel ?? defaults.autoAcceptRequireOwnLevel,
      autoAcceptHarvestStealEnabled: data.autoAcceptHarvestStealEnabled ?? defaults.autoAcceptHarvestStealEnabled,
      autoAcceptHarvestStealHarvest: data.autoAcceptHarvestStealHarvest ?? defaults.autoAcceptHarvestStealHarvest,
      autoAcceptHarvestStealSteal: data.autoAcceptHarvestStealSteal ?? defaults.autoAcceptHarvestStealSteal,
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
          error: getApiErrorMessage(data, '保存失败'),
        }
      }

      if (!latestRequestedAccountId || latestRequestedAccountId === accountId) {
        loadedAccountId.value = accountId
        applySavedSettings(payload, data.data)
      }
      return { ok: true, data: data.data }
    }
    catch (error: any) {
      return { ok: false, error: getApiErrorMessage(error, '保存失败') }
    }
    finally {
      endRequest()
    }
  }

  async function saveOfflineConfig(config: Partial<OfflineConfig> & { enabled?: boolean }) {
    beginRequest()
    try {
      let payload = cloneValue(config)
      if (supportsPushChannels.value === false && config.enabled !== undefined) {
        const { channel = 'webhook', endpoint = '', token = '', secret = '' } = config
        payload = config.enabled ? { channel, endpoint, token, secret } : { channel: 'webhook', endpoint: '', token: '', secret: '' }
      }
      const { data } = await api.post('/api/settings/offline-reminder', payload)
      if (data && data.ok) {
        supportsPushChannels.value = Array.isArray(data.data?.channels)
        settings.value.offlineReminder = normalizeOfflineConfig(data.data)
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

  return { settings, loading, loadedAccountId, supportsPushChannels, fetchSettings, saveSettings, saveOfflineConfig }
})
