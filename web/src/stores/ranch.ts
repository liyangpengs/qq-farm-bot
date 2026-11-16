import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export type RanchView = 'animals' | 'facilities' | 'shop' | 'market' | 'bag' | 'tasks' | 'illustrated' | 'friends' | 'activities' | 'cans'
export interface RanchItem { id: number, name: string, count: string, image: string }
export interface RanchQuote {
  action: string
  label: string
  costs: Array<{ resourceKey: string, amount: string }>
  costItems: RanchItem[]
  rewards: RanchItem[]
  expected: { signature: string }
  skipped: boolean
  count: number
  message?: string
}

export const useRanchStore = defineStore('ranch', () => {
  const state = ref<any>(null)
  const loading = ref(false)
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const receivedAt = ref(0)
  let generation = 0
  let owner = ''
  // 记录最近一次读取的页面参数，操作确认后按原视图刷新。
  let lastQuery: { accountId: string, view: RanchView, shopId?: number, hostGid?: string } | null = null
  const current = (id: string, version: number) => id === owner && version === generation
    && String(localStorage.getItem('current_account_id') || '') === id

  function reset(accountId = '') {
    generation++
    owner = accountId
    lastQuery = null
    state.value = null
    loading.value = false
    busy.value = false
    error.value = ''
    notice.value = ''
  }

  async function load(accountId: string, view: RanchView, shopId?: number, hostGid?: string) {
    if (owner !== accountId)
      reset(accountId)
    const version = ++generation
    lastQuery = { accountId, view, shopId, hostGid }
    loading.value = true
    error.value = ''
    try {
      const response = await api.get('/api/ranch', { params: { view, shopId, hostGid }, headers: { 'x-account-id': accountId }, timeout: 45000, skipErrorToast: true } as any)
      if (!response.data?.ok)
        throw new Error(response.data?.error || '牧场数据读取失败')
      if (current(accountId, version)) {
        state.value = response.data.data
        receivedAt.value = Date.now()
      }
    }
    catch (cause) {
      if (current(accountId, version))
        error.value = getApiErrorMessage(cause, '牧场数据读取失败')
    }
    finally {
      if (current(accountId, version))
        loading.value = false
    }
  }

  async function reload(accountId: string) {
    const query = lastQuery
    if (query && query.accountId === accountId)
      await load(query.accountId, query.view, query.shopId, query.hostGid)
  }

  async function quote(accountId: string, action: string, input: Record<string, unknown>): Promise<RanchQuote | null> {
    if (busy.value || loading.value || owner !== accountId)
      return null
    const version = generation
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      const response = await api.post(`/api/ranch/${action}/quote`, input, { headers: { 'x-account-id': accountId }, timeout: 45000, skipErrorToast: true } as any)
      if (!response.data?.ok)
        throw new Error(response.data?.error || '操作条件读取失败')
      return current(accountId, version) ? response.data.data : null
    }
    catch (cause) {
      if (current(accountId, version))
        error.value = getApiErrorMessage(cause, '操作条件读取失败')
      return null
    }
    finally {
      if (current(accountId, version))
        busy.value = false
    }
  }

  /** quiet：后台上报类操作只确认结果，不弹出完成提示。 */
  async function execute(accountId: string, action: string, input: Record<string, unknown>, expected: RanchQuote['expected'], options: { quiet?: boolean } = {}) {
    if (busy.value || owner !== accountId)
      return false
    const version = generation
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      const response = await api.post(`/api/ranch/${action}`, { ...input, expected }, { headers: { 'x-account-id': accountId }, timeout: 45000, skipErrorToast: true } as any)
      if (!response.data?.ok)
        throw new Error(response.data?.error || '牧场操作未完成')
      if (!current(accountId, version))
        return false
      const result = response.data.data
      if (result.snapshot) {
        state.value = { ...state.value, ...result.snapshot }
        receivedAt.value = Date.now()
      }
      if (!options.quiet)
        notice.value = result.notice || (result.status === 'skipped' ? '当前没有可操作项目' : '操作完成')
      return true
    }
    catch (cause) {
      if (current(accountId, version))
        error.value = getApiErrorMessage(cause, '牧场操作未完成，请刷新核对')
      return false
    }
    finally {
      if (current(accountId, version))
        busy.value = false
    }
  }

  return { state, loading, busy, error, notice, receivedAt, load, reload, quote, execute, reset }
})
