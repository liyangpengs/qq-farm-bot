import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export interface CommerceItemDto {
  id: number
  count: number
  name: string
  image: string
  rarity: number
}

export interface PurchaseLimitDto {
  type: number
  bought: number
  max: number
  remaining: number | null
}

export interface MallGoodsDto {
  id: number
  name: string
  type: number
  rewards: CommerceItemDto[]
  price: CommerceItemDto & { balance: number | null }
  originalPrice?: number | null
  isFree: boolean
  limit: PurchaseLimitDto | null
  isLimited: boolean
  discountText: string
  isDiscounted: boolean
  discountEndTime: number
  available: boolean
  purchasable: boolean
  purchaseStatus?: 'available' | 'sold_out' | 'owned' | 'ad_required' | 'share_required' | 'svip_required' | 'unavailable'
  unavailableReason?: string
}

export interface MallCatalogDto {
  shopId?: number
  membership?: { isSvip: boolean, remainingDays: number } | null
  slotType: number
  subSlotType: number
  serverTime: number
  refreshCountdown: number
  currencies: Array<CommerceItemDto & { balanceKnown: boolean }>
  goods: MallGoodsDto[]
}

export interface MysteryShopDto {
  active: boolean
  serverTime: number
  activeTime?: number
  expireTime?: number
  npc: null | {
    id: number
    reward: CommerceItemDto
    price: CommerceItemDto & { balance: number | null }
    originalPrice: number
    unitPrice: number
    unitOriginalPrice: number
    discountPercent: number
  }
}

export const useCommerceStore = defineStore('commerce', () => {
  const mall = ref<MallCatalogDto | null>(null)
  const mystery = ref<MysteryShopDto | null>(null)
  const mallLoading = ref(false)
  const mysteryLoading = ref(false)
  const mysteryPurchasing = ref(false)
  const purchasingGoodsId = ref<number | null>(null)
  const error = ref('')
  const notice = ref('')
  let requestVersion = 0
  let mallAccountId = ''
  let mysteryAccountId = ''

  function isCurrent(version: number, accountId: string) {
    return version === requestVersion && String(localStorage.getItem('current_account_id') || '') === accountId
  }

  function clearMessages() {
    error.value = ''
    notice.value = ''
  }

  function reset() {
    requestVersion++
    mall.value = null
    mystery.value = null
    mallAccountId = ''
    mysteryAccountId = ''
    mallLoading.value = false
    mysteryLoading.value = false
    purchasingGoodsId.value = null
    mysteryPurchasing.value = false
    clearMessages()
  }

  async function mergeDiamondBalance(accountId: string, catalog: MallCatalogDto) {
    const diamond = catalog.currencies.find(currency => currency.id === 1004)
    if (!diamond)
      return

    try {
      const response = await api.get('/api/diamond', {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        return
      const balance = Number(response.data.data?.diamond)
      if (!Number.isFinite(balance) || balance < 0)
        return

      catalog.currencies = catalog.currencies.map(currency => currency.id === 1004
        ? { ...currency, count: balance, balanceKnown: true }
        : currency)
      catalog.goods = catalog.goods.map(goods => goods.price.id === 1004
        ? { ...goods, price: { ...goods.price, balance } }
        : goods)
    }
    catch {
      // Keep the catalog usable if the optional balance refresh is unavailable.
    }
  }

  async function fetchMall(accountId: string, slotType = 1, propsShop = false) {
    const id = String(accountId || '').trim()
    if (!id) {
      reset()
      return
    }
    const version = ++requestVersion
    if (mallAccountId !== id || mall.value?.slotType !== slotType || !!mall.value?.shopId !== propsShop)
      mall.value = null
    mallAccountId = id
    mallLoading.value = true
    mysteryLoading.value = false
    clearMessages()
    try {
      const response = await api.get(propsShop ? '/api/props-shop' : '/api/game-mall', {
        headers: { 'x-account-id': id },
        params: propsShop ? undefined : { slotType, subSlotType: 1 },
        skipErrorToast: true,
      } as any)
      if (!isCurrent(version, id))
        return
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '商城加载失败'))
      const catalog = response.data.data as MallCatalogDto
      await mergeDiamondBalance(id, catalog)
      if (!isCurrent(version, id))
        return
      mall.value = catalog
    }
    catch (cause: any) {
      if (!isCurrent(version, id))
        return
      error.value = getApiErrorMessage(cause, '商城加载失败')
    }
    finally {
      if (isCurrent(version, id))
        mallLoading.value = false
    }
  }

  async function purchaseMall(accountId: string, goods: MallGoodsDto, count: number) {
    const id = String(accountId || '').trim()
    if (!id || purchasingGoodsId.value !== null)
      return false
    const slotType = mall.value?.slotType || 1
    const propsShop = mall.value?.shopId === 4
    const version = requestVersion
    purchasingGoodsId.value = goods.id
    clearMessages()
    try {
      const response = await api.post(propsShop ? '/api/props-shop/purchase' : '/api/game-mall/purchase', {
        goodsId: goods.id,
        expectedPrice: { id: goods.price.id, count: goods.price.count, rewards: goods.rewards.map(item => ({ id: item.id, count: item.count })) },
        ...(propsShop ? { expectedOffer: { price: { id: goods.price.id, count: goods.price.count }, rewards: goods.rewards.map(item => ({ id: item.id, count: item.count })) } } : {}),
        slotType,
        count,
      }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '购买失败'))
      if (String(localStorage.getItem('current_account_id') || '') !== id)
        return false
      const catalog = response.data.data.catalog as MallCatalogDto | null
      if (catalog)
        await mergeDiamondBalance(id, catalog)
      if (String(localStorage.getItem('current_account_id') || '') !== id)
        return false
      if (version === requestVersion)
        mall.value = catalog
      const rewards = (response.data.data.purchase?.rewards || [])
        .map((item: CommerceItemDto) => `${item.name} x${item.count}`)
        .join('、')
      notice.value = (rewards ? `购买成功：${rewards}` : '购买成功') + (!catalog ? '；请刷新商城确认最新状态' : '')
      return true
    }
    catch (cause: any) {
      if (String(localStorage.getItem('current_account_id') || '') === id)
        error.value = getApiErrorMessage(cause, '购买失败')
      return false
    }
    finally {
      purchasingGoodsId.value = null
    }
  }

  async function fetchMystery(accountId: string) {
    const id = String(accountId || '').trim()
    if (!id) {
      reset()
      return
    }
    const version = ++requestVersion
    if (mysteryAccountId !== id)
      mystery.value = null
    mysteryAccountId = id
    mysteryLoading.value = true
    mallLoading.value = false
    clearMessages()
    try {
      const response = await api.get('/api/mystery-shop', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!isCurrent(version, id))
        return
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '神秘商人加载失败'))
      mystery.value = response.data.data
    }
    catch (cause: any) {
      if (!isCurrent(version, id))
        return
      error.value = getApiErrorMessage(cause, '神秘商人加载失败')
    }
    finally {
      if (isCurrent(version, id))
        mysteryLoading.value = false
    }
  }

  async function purchaseMystery(accountId: string, npcId: number) {
    const id = String(accountId || '').trim()
    if (!id || mysteryPurchasing.value)
      return false
    mysteryPurchasing.value = true
    clearMessages()
    try {
      const response = await api.post('/api/mystery-shop/purchase', { npcId }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!response.data?.ok)
        throw new Error(getApiErrorMessage(response.data, '购买失败'))
      if (String(localStorage.getItem('current_account_id') || '') !== id)
        return false
      mystery.value = response.data.data.shop
      const purchase = response.data.data.purchase as { reward?: CommerceItemDto, price?: CommerceItemDto } | undefined
      const reward = purchase?.reward
      const price = purchase?.price
      if (reward && price)
        notice.value = `购买成功：获得 ${reward.name} x${reward.count}，花费 ${price.count.toLocaleString()} ${price.name}`
      else if (reward)
        notice.value = `购买成功：获得 ${reward.name} x${reward.count}`
      else
        notice.value = '购买成功'
      return true
    }
    catch (cause: any) {
      if (String(localStorage.getItem('current_account_id') || '') === id)
        error.value = getApiErrorMessage(cause, '购买失败')
      return false
    }
    finally {
      mysteryPurchasing.value = false
    }
  }

  return {
    mall,
    mystery,
    mallLoading,
    mysteryLoading,
    mysteryPurchasing,
    purchasingGoodsId,
    error,
    notice,
    reset,
    clearMessages,
    fetchMall,
    purchaseMall,
    fetchMystery,
    purchaseMystery,
  }
})
