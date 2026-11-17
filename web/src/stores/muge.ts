import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

export interface MugeReward { id: number, count: number, name: string, image: string }
export interface MugeTier { id: string, threshold: number, status: number, rewards: MugeReward[] }
export interface MugeState {
  activityId: string
  title: string
  serverTime: number
  startTime: number
  endTime: number
  active: boolean
  rules: string[]
  celebration: { total: number, tiers: MugeTier[] } | null
  friends: { count: number, tiers: MugeTier[] } | null
  handbook: { points: number, tiers: MugeTier[], tasks: Array<{ id: string, description: string, progress: number, target: number, status: number, unlockDay: number, points: number, rewards: MugeReward[] }> } | null
  personality: { answers: Record<string, number>, personalityId: number, settleCount: number, image: string, shareRewardClaimed: boolean } | null
  questions: Array<{ id: number, title: string, options: Array<{ value: number, text: string, label: string }> }>
}
export type MugeAction = 'claimCelebration' | 'claimFriends' | 'claimTask' | 'claimHandbook' | 'saveAnswers' | 'settle' | 'claimShare'

/** 两个空间复用同一份账号进度；切换账号后丢弃旧请求的回包。 */
export const useMugeStore = defineStore('muge', () => {
  const account = useAccountStore()
  const toast = useToastStore()
  const state = ref<MugeState | null>(null)
  const busy = ref(false)
  const error = ref('')
  const needsRefresh = ref(false)
  let sequence = 0

  watch(() => account.currentAccountId, () => {
    sequence++
    state.value = null
    busy.value = false
    error.value = ''
    needsRefresh.value = false
  }, { flush: 'sync' })

  async function request(action?: MugeAction, input: Record<string, unknown> = {}) {
    const id = String(account.currentAccountId || '')
    if (!id || busy.value || (action && needsRefresh.value))
      return false
    const version = ++sequence
    busy.value = true
    error.value = ''
    try {
      const url = `/api/activities/muge${action ? `/${action}` : ''}`
      const options = { headers: { 'x-account-id': id }, skipErrorToast: true } as any
      const response = action ? await api.post(url, input, options) : await api.get(url, options)
      if (version !== sequence)
        return false
      if (!response.data?.ok)
        throw new Error(response.data?.error || '活动请求失败')
      const result = response.data.data
      state.value = action ? result.activity : result
      needsRefresh.value = action ? result.refreshRequired === true : false
      if (action && action !== 'saveAnswers') {
        const text = (result.rewards || []).map((reward: MugeReward) => `${reward.name} ×${reward.count}`).join('、')
        toast.success(text || (action === 'settle' ? '牧场人格已生成' : '操作已完成'))
      }
      if (needsRefresh.value)
        error.value = '操作已确认，请刷新获取最新进度'
      return true
    }
    catch (cause: any) {
      if (version === sequence) {
        error.value = cause?.message || '读取失败，请刷新重试'
        needsRefresh.value = !!action
      }
      return false
    }
    finally {
      if (version === sequence)
        busy.value = false
    }
  }
  return { state, busy, error, needsRefresh, request }
})
