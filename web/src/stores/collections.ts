import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export interface CollectionReward { itemId: number, name: string, count: string, image: string }
export interface CollectionBuff { id: number, name: string, value: number, description: string }
export interface CollectionItem {
  id: number
  name: string
  description: string
  image: string
  starLevel: number
  maxStarLevel: number
  ownCount: string
  activated: boolean
  isNew: boolean
  score: number
  displayed: boolean
  wished: boolean
  requirements: string[]
  nextStarCosts: CollectionReward[]
  unlocked: boolean
  canUpgrade: boolean
}
export interface CollectionSeries {
  id: number
  name: string
  rarity: number
  rarityName: string
  description: string
  requirements: string[]
  mutationRules: Array<{ name: string, probability: number, guarantee: number }>
  items: CollectionItem[]
  activatedCount: number
  totalCount: number
}
export interface CollectionSnapshot {
  category: number
  score: number
  claimedScore: number
  activatedCount: number
  totalCount: number
  nextRewardScore: number | null
  currentBuffs: CollectionBuff[]
  milestones: Array<{ level: number, score: number, claimed: boolean, reached: boolean, rewards: CollectionReward[], buffs: CollectionBuff[] }>
  series: CollectionSeries[]
  display: { itemId: string, pedestalId: string } | null
  pedestals: Array<{ id: number, name: string, image: string, owned: boolean }>
  updatedAt: number
}

export const useCollectionsStore = defineStore('collections', () => {
  const data = ref<CollectionSnapshot | null>(null)
  const loading = ref(false)
  const error = ref('')
  const pending = ref('')
  let revision = 0

  async function fetch(accountId: string) {
    const request = ++revision
    loading.value = true
    error.value = ''
    try {
      const response = await api.get('/api/collections', {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (request !== revision)
        return
      if (!response.data?.ok)
        throw new Error(response.data?.error || '藏品读取失败')
      data.value = response.data.data
    }
    catch (cause) {
      if (request === revision)
        error.value = getApiErrorMessage(cause, '藏品读取失败')
    }
    finally {
      if (request === revision)
        loading.value = false
    }
  }

  function reset() {
    revision++
    data.value = null
    loading.value = false
    error.value = ''
    pending.value = ''
  }

  async function operate(accountId: string, action: 'upgrade' | 'claim' | 'display', input: Record<string, unknown> = {}) {
    if (pending.value)
      return { ok: false, error: '藏品操作正在处理中' }
    const request = ++revision
    pending.value = action
    loading.value = false
    try {
      const response = await api.post(`/api/collections/${action}`, input, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (request !== revision)
        return { ok: false, stale: true }
      if (!response.data?.ok)
        throw new Error(response.data?.error || '藏品操作失败')
      data.value = response.data.data.snapshot
      return { ok: true, data: response.data.data }
    }
    catch (cause) {
      if (request !== revision)
        return { ok: false, stale: true }
      return { ok: false, error: getApiErrorMessage(cause, '藏品操作失败') }
    }
    finally {
      if (request === revision)
        pending.value = ''
    }
  }
  return { data, loading, error, pending, fetch, reset, operate }
})
