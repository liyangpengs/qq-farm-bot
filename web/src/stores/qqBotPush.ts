import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface QqBotPushUser {
  openid: string
  nickname: string
  avatar: string
  lastSeenAt: number
}

export interface QqBotPushConfig {
  /** 推送渠道总开关：关闭时设置卡片隐藏、服务不启动 */
  channelEnabled: boolean
  enabled: boolean
  appId: string
  appSecret: string
  openid: string
  eventKeys: string[]
  batchWindowSec: number
  dailyLimit: number
  minuteLimit: number
  includeIcons: boolean
  includeAvatars: boolean
  showAccount: boolean
  offlineNotify: boolean
  reloginEnabled: boolean
  /** 账号ID -> 接收用户 openid 列表 */
  accountRoutes: Record<string, string[]>
}

export interface QqBotPushStatus {
  connected: boolean
  connecting: boolean
  openid: string
  lastError: string
  tokenReady: boolean
  sentToday: number
  sentThisMinute: number
  queued: number
  mediaCount: number
  users: QqBotPushUser[]
  /** 多账号可同时等待扫码，每个账号一条会话状态 */
  relogin: Array<{ active: boolean, accountId: string, stage: string, startedAt: number }>
}

export interface QqBotPushRecord {
  id: string
  time: string
  dateKey: string
  accountId: string
  accountName: string
  recipientOpenid: string
  recipientName: string
  content: string
  itemCount: number
}

export interface QqBotPushDetails {
  records: QqBotPushRecord[]
  queue: any[]
  media: Array<{ key: string; url: string; imageId: string; localPath: string; name: string; lastUsed: number }>
}

export interface QqBotEventOption {
  key: string
  label: string
  desc: string
}

export const QQ_BOT_EVENT_OPTIONS: QqBotEventOption[] = [
  { key: 'sell_success', label: '出售成功', desc: '仓库果实出售完成' },
  { key: '照顾好友', label: '照顾好友', desc: '给好友放草放虫等' },
  { key: '领取任务', label: '农场任务', desc: '农场每日任务领取' },
  { key: 'ranch_task_claim', label: '牧场任务', desc: '牧场每日任务领取' },
  { key: 'ranch_steal', label: '偷取好友牧场', desc: '从好友牧场偷取' },
  { key: 'ranch_cleanFriend', label: '清理好友牧场', desc: '清理好友牧场污物/蚊子' },
  { key: '收获作物', label: '收获作物', desc: '农场作物收获完成' },
  { key: '神秘商人自动购买', label: '神秘商人', desc: '神秘商人自动购买成功' },
]

function createDefaultConfig(): QqBotPushConfig {
  return {
    channelEnabled: false,
    enabled: false,
    appId: '',
    appSecret: '',
    openid: '',
    eventKeys: QQ_BOT_EVENT_OPTIONS.map(o => o.key),
    batchWindowSec: 60,
    dailyLimit: 800,
    minuteLimit: 8,
    includeIcons: true,
    includeAvatars: true,
    showAccount: true,
    offlineNotify: true,
    reloginEnabled: true, // 微信账号掉线推送带「重新登录」按钮（免扫码换码）
    accountRoutes: {},
  }
}

export const useQqBotPushStore = defineStore('qqBotPush', () => {
  const config = ref<QqBotPushConfig>(createDefaultConfig())
  const status = ref<QqBotPushStatus>({
    connected: false,
    connecting: false,
    openid: '',
    lastError: '',
    tokenReady: false,
    sentToday: 0,
    sentThisMinute: 0,
    queued: 0,
    mediaCount: 0,
    users: [],
    relogin: [],
  })
  const loading = ref(false)
  const loaded = ref(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function applyData(data: any) {
    if (!data) return
    if (data.config) config.value = { ...config.value, ...data.config }
    if (data.status) status.value = { ...status.value, ...data.status }
  }

  async function fetch() {
    loading.value = true
    try {
      const { data } = await api.get('/api/settings/qq-bot-push')
      if (data?.ok) applyData(data.data)
      loaded.value = true
      return data
    }
    finally {
      loading.value = false
    }
  }

  async function save(next: QqBotPushConfig) {
    const { data } = await api.post('/api/settings/qq-bot-push', next)
    if (data?.ok) {
      config.value = { ...config.value, ...data.data?.config }
      status.value = { ...status.value, ...data.data?.status }
    }
    return data
  }

  async function fetchDetails(): Promise<QqBotPushDetails> {
    const empty: QqBotPushDetails = { records: [], queue: [], media: [] }
    try {
      const { data } = await api.get('/api/settings/qq-bot-push/details')
      return data?.ok && data?.data ? data.data : empty
    } catch {
      return empty
    }
  }

  async function deleteRecords(dateKey: string): Promise<QqBotPushDetails | null> {
    const { data } = await api.post('/api/settings/qq-bot-push/delete-records', { dateKey })
    return data?.ok ? (data.data?.details || null) : null
  }

  async function testSend() {
    const { data } = await api.post('/api/settings/qq-bot-push/test')
    return data
  }

  async function capture() {
    const { data } = await api.post('/api/settings/qq-bot-push/capture')
    return data
  }

  async function selectUser(openid: string) {
    const { data } = await api.post('/api/settings/qq-bot-push/select-user', { openid })
    if (data?.ok) config.value = { ...config.value, ...data.data?.config }
    return data
  }

  async function deleteUser(openid: string) {
    const { data } = await api.post('/api/settings/qq-bot-push/delete-user', { openid })
    if (data?.ok) {
      config.value = { ...config.value, ...data.data?.config }
      status.value = { ...status.value, ...data.data?.status }
    }
    return data
  }

  /** 只在还没拉过时请求一次（设置页/渠道弹窗都会调用） */
  async function ensureLoaded() {
    if (loaded.value || loading.value) return
    await fetch().catch(() => {})
  }

  /** 只切换渠道总开关，不动其它字段 */
  async function setChannelEnabled(value: boolean) {
    const data = await save({ ...config.value, channelEnabled: value })
    return Boolean(data?.ok)
  }

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => { fetch().catch(() => {}) }, 5000)
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  return {
    config,
    status,
    loading,
    loaded,
    ensureLoaded,
    setChannelEnabled,
    fetch,
    fetchDetails,
    deleteRecords,
    save,
    testSend,
    capture,
    selectUser,
    deleteUser,
    startPolling,
    stopPolling,
  }
})
