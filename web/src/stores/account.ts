import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { createRequestGuard } from '@/utils/request-guard'

export interface Account {
  id: string
  name: string
  nick?: string
  uin?: number | string
  avatar?: string
  platform?: string
  running?: boolean
  runtimeState?: 'logging_in' | 'relogin_waiting' | 'running' | 'offline' | 'stopping' | 'stopped'
  reloginAt?: number | null
  /** 微信 openid（续期微信授权用）。 */
  wxid?: string
  /** 后端判定的「wxid + refreshtoken 齐备、可免扫码续期」标记；接口不下发凭证明文。 */
  wxPreflightSupported?: boolean
  /**
   * 后端判定的「掉线后能免扫码恢复」标记：在 refreshtoken 之外还包含只有
   * loginBuffer 的账号（滚不了 token，但能直接换 Code）。
   * 自动续期账本按这个字段决定是否展示；缺失代表服务尚未更新。
   */
  wxCanRecover?: boolean
  /** 自动续期账本快照：只有时间戳与次数，无任何凭证内容；字段缺失代表服务尚未更新。 */
  wxPreflightStats?: {
    date?: string
    lastSuccessAt?: number
    lastFailureAt?: number
    successesToday?: number
    failuresToday?: number
  }
  /** 微信授权到期信息，用于展示剩余时间。 */
  expires_at?: number
  expires_in?: number
  wxCredentialRefreshedAt?: number
  wxCredentialLastAttemptAt?: number
  wxCredentialRefreshError?: string
  // Add other fields as discovered
}

export interface AccountLog {
  time: string
  action: string
  msg: string
  reason?: string
}

/** 账号 Code 自动监听快照，字段与 core/services/code-watch.ts 对齐。 */
export interface CodeHealthItem {
  accountId: string
  name: string
  platform: string
  level: 'ok' | 'unknown' | 'expiring' | 'expired' | 'refresh_failed' | 'offline'
  reason: string
  autoFixable: boolean
  needsManual: boolean
  remainingMs: number
  latestLogAction: string
}

export function getPlatformLabel(p?: string) {
  if (p === 'qq')
    return 'QQ'
  if (p === 'wx')
    return '微信'
  return ''
}

export function getPlatformClass(p?: string) {
  if (p === 'qq')
    return 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
  if (p === 'wx')
    return 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
  return ''
}

/** 轮询去抖：账号列表内容没变时不替换数组（每项字段级比较，数量小开销可忽略）。 */
function accountsEqual(a: Account[], b: Account[]) {
  if (a === b)
    return true
  if (a.length !== b.length)
    return false
  return a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]))
}

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Account[]>([])
  const currentAccountId = useStorage('current_account_id', '')
  const loading = ref(false)
  const logs = ref<AccountLog[]>([])
  const codeHealth = ref<CodeHealthItem[]>([])
  const codeHealthLoaded = ref(false)
  const accountsGuard = createRequestGuard()

  const currentAccount = computed(() =>
    accounts.value.find(a => String(a.id) === currentAccountId.value),
  )

  async function fetchAccounts() {
    const ticket = accountsGuard.next()
    loading.value = true
    try {
      // api interceptor adds x-admin-token
      const res = await api.get('/api/accounts')
      if (accountsGuard.isStale(ticket))
        return
      if (res.data.ok && res.data.data && res.data.data.accounts) {
        const nextAccounts: Account[] = res.data.data.accounts
        // 10s 轮询：列表内容没变就不替换数组，避免顶栏账号菜单等全局组件周期性重渲染。
        if (!accountsEqual(accounts.value, nextAccounts))
          accounts.value = nextAccounts

        // Auto-select first account if none selected or selected not found
        if (accounts.value.length > 0) {
          const found = accounts.value.find(a => String(a.id) === currentAccountId.value)
          if (!found && accounts.value[0]) {
            currentAccountId.value = String(accounts.value[0].id)
          }
        }
        else {
          // 如果账号列表为空，清空当前选中的账号ID
          currentAccountId.value = ''
        }
      }
      else {
        // 如果返回数据无效，也清空账号列表和选中状态
        accounts.value = []
        currentAccountId.value = ''
      }
    }
    catch (e) {
      console.error('获取账号失败', e)
      if (accountsGuard.isStale(ticket))
        return
      // 网络/超时类失败保留上一份账号快照，不要清空。
      // 真正的「无账号/未登录」由成功响应里的空列表分支处理。
    }
    finally {
      if (!accountsGuard.isStale(ticket))
        loading.value = false
    }
  }

  function selectAccount(id: string) {
    currentAccountId.value = id
  }

  function setCurrentAccount(acc: Account) {
    selectAccount(acc.id)
  }

  function syncAccountAvatar(id: string, avatar: string) {
    const account = accounts.value.find(item => String(item.id) === String(id))
    if (account && avatar) {
      account.avatar = avatar
    }
  }

  async function startAccount(id: string) {
    await api.post(`/api/accounts/${id}/start`)
    await fetchAccounts()
  }

  async function stopAccount(id: string) {
    await api.post(`/api/accounts/${id}/stop`)
    await fetchAccounts()
  }

  async function deleteAccount(id: string) {
    await api.delete(`/api/accounts/${id}`)
    if (currentAccountId.value === id) {
      currentAccountId.value = ''
    }
    await fetchAccounts()
  }

  async function fetchLogs() {
    try {
      const res = await api.get('/api/account-logs?limit=100')
      if (Array.isArray(res.data)) {
        logs.value = res.data
      }
    }
    catch (e) {
      console.error('获取账号日志失败', e)
    }
  }

  async function addAccount(payload: any) {
    try {
      await api.post('/api/accounts', payload)
      await fetchAccounts()
    }
    catch (e) {
      console.error('添加账号失败', e)
      throw e
    }
  }

  /** 续期全部微信账号授权（后端逐账号刷新并写回新 Code）。 */
  async function refreshWxCodes() {
    const res = await api.post('/api/accounts/refresh-wx-credentials')
    await fetchAccounts()
    return res.data
  }

  /** Code 健康快照：由侧栏 10 秒轮询驱动，账号管理页据此自动监听过期。 */
  async function fetchCodeHealth() {
    try {
      const res = await api.get('/api/accounts/code-health')
      const items = res.data?.data?.items
      codeHealth.value = Array.isArray(items) ? items as CodeHealthItem[] : []
      codeHealthLoaded.value = true
    }
    catch {
      // 快照拉取失败时保留上次的判定，避免网络抖动把状态清空后重复自动补码。
    }
    return codeHealth.value
  }

  /** 自动补 Code（微信免扫码换码 / QQ 尽力重签），并同步刷新账号与快照。 */
  async function autoFixCode(id: string) {
    const res = await api.post(`/api/accounts/${id}/auto-fix-code`)
    await fetchAccounts()
    await fetchCodeHealth()
    return res.data
  }

  async function updateAccount(id: string, payload: any) {
    try {
      // core uses POST /api/accounts for both add and update (if id is present)
      await api.post('/api/accounts', { ...payload, id })
      await fetchAccounts()
    }
    catch (e) {
      console.error('更新账号失败', e)
      throw e
    }
  }

  return {
    accounts,
    currentAccountId,
    currentAccount,
    loading,
    logs,
    codeHealth,
    codeHealthLoaded,
    fetchAccounts,
    selectAccount,
    startAccount,
    stopAccount,
    deleteAccount,
    fetchLogs,
    addAccount,
    updateAccount,
    refreshWxCodes,
    fetchCodeHealth,
    autoFixCode,
    setCurrentAccount,
    syncAccountAvatar,
  }
})
