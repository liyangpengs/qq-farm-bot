import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { RanchItem, RanchQuote, RanchView } from '@/stores/ranch'
import { useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, inject, onBeforeUnmount, provide, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useToastStore } from '@/stores/toast'

export const RANCH_IMAGE = (id: number | string) => `/game-config/seed_images_named/seed_images/${id}.png`
/** 罐头桶在背包里按秒计量，展示时用对应罐头的图标。 */
export const BUCKETS = [
  { id: 7003, name: '普通罐头', image: RANCH_IMAGE(80021) },
  { id: 7004, name: '有机罐头', image: RANCH_IMAGE(80031) },
] as const

export interface RanchPending {
  accountId: string
  action: string
  input: Record<string, unknown>
  quote: RanchQuote
}

export interface RanchPurchaseTerms {
  costItems: RanchItem[]
  rewards: RanchItem[]
}

function itemTotals(items: RanchItem[]) {
  const totals = new Map<number, bigint>()
  for (const item of items)
    totals.set(item.id, (totals.get(item.id) ?? 0n) + BigInt(item.count))
  return [...totals].filter(([, count]) => count !== 0n).map(([id, count]) => `${id}:${count}`).sort().join('|')
}

export interface RanchActions {
  pending: Ref<RanchPending | null>
  /** 读取、报价或执行中，或确认框打开时，所有写入按钮都不可用。 */
  disabled: ComputedRef<boolean>
  request: (action: string, input?: Record<string, unknown>, acceptedTerms?: RanchPurchaseTerms) => Promise<void>
  requestDirect: (action: 'feed' | 'produce' | 'harvest' | 'clean', input?: Record<string, unknown>) => Promise<void>
  confirm: () => Promise<void>
  cancel: () => void
}

const actionsKey: InjectionKey<RanchActions> = Symbol('ranch-actions')

/** 商城在数量弹窗确认费用；两种入口均使用服务端报价和操作结果。 */
export function provideRanchActions(): RanchActions {
  const ranch = useRanchStore()
  const toast = useToastStore()
  const { currentAccountId } = storeToRefs(useAccountStore())
  const { loading, busy, notice } = storeToRefs(ranch)
  const pending = ref<RanchPending | null>(null)
  const disabled = computed(() => loading.value || busy.value || !!pending.value)

  async function execute(chosen: RanchPending) {
    const succeeded = await ranch.execute(chosen.accountId, chosen.action, chosen.input, chosen.quote.expected)
    if (pending.value === chosen)
      pending.value = null
    if (succeeded && chosen.accountId === String(currentAccountId.value || ''))
      await ranch.reload(chosen.accountId)
  }

  async function requestDirect(action: 'feed' | 'produce' | 'harvest' | 'clean', input: Record<string, unknown> = {}) {
    const accountId = String(currentAccountId.value || '')
    if (!accountId || disabled.value)
      return
    const result = await ranch.executeDirect(accountId, action, input)
    if (!result)
      return
    if (result.sceneRestored === false) {
      toast.error(result.notice || '牧场场景恢复未确认，请刷新核对操作结果')
      return
    }
    if (result.status === 'skipped') {
      toast.info(result.notice || '当前没有可操作项目')
    }
    else if (action === 'feed' && result.bucketRemainingSeconds !== undefined) {
      const can = input.bucketType === 1 ? '有机罐头' : '普通罐头'
      const remaining = Number(result.bucketRemainingSeconds)
      const duration = remaining > 0 && remaining < 3600 ? formatDuration(remaining) : formatHours(remaining)
      let message = `喂养完成，${can}剩余 ${duration}`
      if (input.produceAfterFeed)
        message += result.autoProduced ? `，已开始生产 ${result.autoProduced} 只` : '，当前没有可生产的动物'
      if (result.autoProductionNotice)
        toast.warning(`${message}。${result.autoProductionNotice}`)
      else
        toast.success(message)
    }
    else {
      const labels = { feed: '喂养完成', produce: '已开始生产', harvest: '收获完成', clean: '清理完成' }
      toast.success(result.notice || labels[action])
    }
    if (result.refreshRequired)
      await ranch.reload(accountId)
  }

  async function request(action: string, input: Record<string, unknown> = {}, acceptedTerms?: RanchPurchaseTerms) {
    const accountId = String(currentAccountId.value || '')
    if (!accountId || disabled.value)
      return
    const quote = await ranch.quote(accountId, action, input)
    if (!quote || accountId !== String(currentAccountId.value || ''))
      return
    if (quote.skipped) {
      toast.info('当前没有可操作项目')
      return
    }
    const chosen = { accountId, action, input, quote }
    if (!acceptedTerms) {
      pending.value = chosen
      return
    }
    if (itemTotals(quote.costItems) !== itemTotals(acceptedTerms.costItems) || itemTotals(quote.rewards) !== itemTotals(acceptedTerms.rewards)) {
      toast.error('商品价格或内容已变化，请重新选择')
      await ranch.reload(accountId)
      return
    }
    await execute(chosen)
  }

  async function confirm() {
    const chosen = pending.value
    if (!chosen || busy.value || chosen.accountId !== String(currentAccountId.value || ''))
      return
    await execute(chosen)
  }

  // 操作成功用轻提示告知；失败提示由当前面板的 RanchGate 统一展示。
  watch(notice, (message) => {
    if (!message)
      return
    toast.success(message)
    notice.value = ''
  })
  watch(currentAccountId, () => {
    pending.value = null
  })

  const actions: RanchActions = { pending, disabled, request, requestDirect, confirm, cancel: () => (pending.value = null) }
  provide(actionsKey, actions)
  return actions
}

export function useRanchActions(): RanchActions {
  const actions = inject(actionsKey)
  if (!actions)
    throw new Error('牧场操作需要在牧场页面内使用')
  return actions
}

/** 面板挂载后按视图读取牧场数据，账号或参数变化时重新读取。 */
export function useRanchLoader(view: RanchView, params: () => { shopId?: number, hostGid?: string } = () => ({})) {
  const ranch = useRanchStore()
  const { currentAccountId } = storeToRefs(useAccountStore())

  async function refresh() {
    const id = String(currentAccountId.value || '')
    if (!id)
      return
    const { shopId, hostGid } = params()
    await ranch.load(id, view, shopId, hostGid)
  }

  watch([currentAccountId, () => JSON.stringify(params())], ([id]) => {
    if (id)
      void refresh()
    else ranch.reset()
  }, { immediate: true })

  return { refresh }
}

/** 按服务器时间倒计时：回包携带 serverTime，本地只累计经过的时长。 */
export function useRanchClock() {
  const { state, receivedAt } = storeToRefs(useRanchStore())
  const now = useNow({ interval: 1000 })
  const serverNow = computed(() => {
    const local = now.value.getTime()
    return (state.value?.serverTime || local) + local - (receivedAt.value || local)
  })
  function remainingSeconds(time: number | string) {
    const value = Number(time)
    const ms = value < 100_000_000_000 ? value * 1000 : value
    return Math.max(0, Math.ceil((ms - serverNow.value) / 1000))
  }
  return { serverNow, remainingSeconds }
}

/** 设施固定顺序：窝（6）、棚（7）、牧草机（8）。服务器返回顺序不固定，列表统一按此排列。 */
const FACILITY_ORDER: Record<number, number> = { 6: 0, 7: 1, 8: 2 }
export function sortFacilities<T extends { moduleType?: number | string, id?: number | string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (FACILITY_ORDER[Number(a.moduleType)] ?? 9) - (FACILITY_ORDER[Number(b.moduleType)] ?? 9)
    || String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true }))
}

export function formatDuration(seconds: number | string) {
  const n = Math.max(0, Math.ceil(Number(seconds) || 0))
  const d = Math.floor(n / 86400)
  const h = Math.floor(n % 86400 / 3600)
  const m = Math.floor(n % 3600 / 60)
  const s = n % 60
  if (d > 0)
    return `${d}天${h}小时`
  if (h > 0)
    return `${h}小时${m}分`
  if (m > 0)
    return `${m}分${s}秒`
  return `${s}秒`
}

/** 罐头桶按秒存量折算成小时，与农场化肥桶的“27.8h”写法一致。 */
export function formatHours(seconds: number | string) {
  return `${((Number(seconds) || 0) / 3600).toFixed(1)}h`
}

/** 数量字段可能超出安全整数，按 BigInt 加千分位。 */
export function formatCount(value: unknown) {
  const text = String(value ?? '0')
  try {
    return BigInt(text).toLocaleString('zh-CN')
  }
  catch {
    const n = Number(text)
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : text
  }
}

export function useRanchUnmountReset() {
  const ranch = useRanchStore()
  onBeforeUnmount(() => ranch.reset())
}
