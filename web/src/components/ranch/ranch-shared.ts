import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { RanchQuote, RanchView } from '@/stores/ranch'
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

export interface RanchActions {
  pending: Ref<RanchPending | null>
  /** 读取、报价或执行中，或确认框打开时，所有写入按钮都不可用。 */
  disabled: ComputedRef<boolean>
  request: (action: string, input?: Record<string, unknown>) => Promise<void>
  confirm: () => Promise<void>
  cancel: () => void
}

const actionsKey: InjectionKey<RanchActions> = Symbol('ranch-actions')

/** 牧场写入统一走“报价 → 确认 → 执行 → 按原视图刷新”，确认框由页面外壳渲染一次。 */
export function provideRanchActions(): RanchActions {
  const ranch = useRanchStore()
  const toast = useToastStore()
  const { currentAccountId } = storeToRefs(useAccountStore())
  const { loading, busy, notice } = storeToRefs(ranch)
  const pending = ref<RanchPending | null>(null)
  const disabled = computed(() => loading.value || busy.value || !!pending.value)

  async function request(action: string, input: Record<string, unknown> = {}) {
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
    pending.value = { accountId, action, input, quote }
  }

  async function confirm() {
    const chosen = pending.value
    if (!chosen || chosen.accountId !== String(currentAccountId.value || ''))
      return
    const succeeded = await ranch.execute(chosen.accountId, chosen.action, chosen.input, chosen.quote.expected)
    pending.value = null
    if (succeeded && chosen.accountId === String(currentAccountId.value || ''))
      await ranch.reload(chosen.accountId)
  }

  // 操作结果用轻提示告知；失败信息留在页面上，便于刷新核对。
  watch(notice, (message) => {
    if (!message)
      return
    toast.success(message)
    notice.value = ''
  })
  watch(currentAccountId, () => {
    pending.value = null
  })

  const actions: RanchActions = { pending, disabled, request, confirm, cancel: () => (pending.value = null) }
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
