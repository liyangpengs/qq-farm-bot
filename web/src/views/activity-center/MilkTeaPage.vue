<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import MilkTeaContent from './MilkTeaContent.vue'

defineEmits<{ back: [] }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const mainPage = ref('shop')
const panel = ref<string | null>(null)
const mainState = ref<any>(null)
const panelState = ref<any>(null)
const activeState = computed(() => panel.value ? panelState.value : mainState.value)
const busy = ref(false)
const dialog = ref<any>(null)
const count = ref(1)
let sequence = 0
let filters: any = {}
const tabs: Array<[string, string]> = [['shop', '我的店铺'], ['exchange', '兑换商店'], ['work', '我的工作']]
const panelTitles: Record<string, string> = { settings: '店铺设置', upgrade: '店铺升级', fund: '成长基金', workshop: '奶茶工坊', hireList: '好友雇佣', logs: '营业记录', rank: '排行榜', workItems: '工作事项' }
// 列表型弹窗在宽屏下加宽，每一项横向展开成一行
const widePanels = ['upgrade', 'workshop', 'fund']
const mainWallet = computed(() => walletOf(mainState.value))
const panelWallet = computed(() => walletOf(panelState.value))
const periodText = computed(() => {
  if (!mainState.value)
    return ''
  if (mainState.value.settling)
    return '结算期'
  const date = (value: number) => new Date(value * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' })
  return `${date(mainState.value.startTime)} – ${date(mainState.value.endTime)}`
})
const daysLeft = computed(() => {
  if (!mainState.value?.active || mainState.value.settling || !mainState.value.endTime)
    return ''
  const left = Math.ceil((mainState.value.endTime * 1000 - Date.now()) / 86400000)
  return left <= 0 ? '今天结束' : `还剩 ${left} 天`
})
const insufficient = computed(() => (dialog.value?.costs || []).some((item: any) => Number(item.count) * count.value > Number(activeState.value?.balances?.[item.id] || 0)))
const boostEstimate = computed(() => {
  const shop = activeState.value?.shop
  if (!shop || dialog.value?.action !== 'boost')
    return null
  let remaining = Number(shop.boost_cups_per_use || 0) * count.value
  let token = 0
  let coin = 0
  for (const recipe of [...(activeState.value.recipes || [])].filter(v => v.unlocked).sort((a, b) => Number(!!b.is_advanced) - Number(!!a.is_advanced) || Number(b.token_price) - Number(a.token_price) || Number(a.recipe_id) - Number(b.recipe_id))) {
    const cups = Math.min(remaining, recipe.is_advanced ? Number(shop.drink_cups?.[recipe.recipe_id] || 0) : remaining)
    token += Number(recipe.boostTokenPrice || 0) * cups
    coin += Number(shop.boost_coin_price?.[recipe.recipe_id] || 0) * cups
    remaining -= cups
  }
  return { cups: Number(shop.boost_cups_per_use || 0) * count.value - remaining, token, coin }
})

function walletOf(value: any) {
  if (!value)
    return []
  return [
    { id: 1041, name: '奶茶券' },
    { id: 1042, name: '宣传喇叭' },
    ...(value.balances?.[1004] !== undefined ? [{ id: 1004, name: '钻石' }] : []),
  ].map(item => ({ ...item, count: Number(value.balances?.[item.id] || 0), image: `/game-config/seed_images_named/seed_images/${item.id}.png` }))
}
function itemImage(id: number | string) {
  return `/game-config/seed_images_named/seed_images/${id}.png`
}
/** 消耗行显示当前持有量；余额里没有的道具（如果实）不显示。 */
function holding(cost: any): number | null {
  const value = activeState.value?.balances?.[cost.id]
  return value === undefined ? null : Number(value)
}
function hideImage(event: Event) {
  (event.target as HTMLImageElement).style.visibility = 'hidden'
}
function rewardsText(values: any[]) {
  return (values || []).map(v => `${v.name} ×${v.count}`).join('、')
}
function select(value: any) {
  count.value = 1
  dialog.value = value
}
function setCount(value: number | null) {
  count.value = Math.max(1, Math.min(dialog.value?.max || 1, Math.floor(Number(value)) || 1))
}
async function request(action = '', input: any = {}) {
  const account = String(currentAccountId.value || '')
  if (!account || busy.value)
    return
  const target = panel.value === 'workItems' ? 'work' : panel.value || mainPage.value
  const version = ++sequence
  busy.value = true
  try {
    const options = { headers: { 'x-account-id': account }, skipErrorToast: true } as any
    const response = action ? await api.post(`/api/activities/milk-tea/${action}`, input, options) : await api.get('/api/activities/milk-tea', { ...options, params: { ...filters, page: target } })
    if (version !== sequence)
      return
    if (!response.data?.ok)
      throw new Error(response.data?.error || '活动请求失败')
    const data = response.data.data
    const next = action ? data.activity : data
    if (next && next.id !== '2026110101')
      throw new Error('活动回包不匹配')
    if (action) {
      dialog.value = null
      const message = rewardsText(data.rewards) || (action === 'craft' ? `制作成功：${Object.values(data.result.crafted_cups || {}).reduce((a: number, b) => a + Number(b), 0)}杯` : '操作成功')
      if (data.refreshRequired)
        toast.warning(`${message}。请刷新确认最新进度`)
      else toast.success(message)
    }
    if (panel.value) {
      panelState.value = next
    }
    else if (action || target !== 'exchange' || !mainState.value
      || JSON.stringify({ ...mainState.value, serverTime: 0 }) !== JSON.stringify({ ...next, serverTime: 0 })) {
      mainState.value = next
    }
  }
  catch (error: any) {
    if (version === sequence) {
      toast.error(error?.response?.data?.error || error?.message || '请求失败')
      if (action) {
        dialog.value = null
        if (panel.value)
          panelState.value = null
        else mainState.value = null
      }
    }
  }
  finally {
    if (version === sequence)
      busy.value = false
  }
}
function navigate(target: string) {
  if (busy.value)
    return
  filters = {}
  if (tabs.some(([key]) => key === target)) {
    if (target !== 'exchange' || mainPage.value !== target)
      mainState.value = null
    panel.value = null
    mainPage.value = target
  }
  else {
    panel.value = target
    panelState.value = null
  }
  void request()
}
function closePanel() {
  if (busy.value)
    return
  panel.value = null
  panelState.value = null
  filters = {}
  void request()
}
function closeDialog() {
  if (!busy.value)
    dialog.value = null
}
function reload(input: any = {}) {
  filters = { ...filters, ...input }
  void request()
}
function confirm() {
  if (!dialog.value || busy.value || insufficient.value)
    return
  void request(dialog.value.action, { ...dialog.value.input, count: count.value, expectedCosts: dialog.value.costs })
}
watch(currentAccountId, () => {
  sequence++
  busy.value = false
  mainState.value = null
  panelState.value = null
  panel.value = null
  dialog.value = null
  mainPage.value = 'shop'
  filters = {}
  void request()
}, { immediate: true })
onUnmounted(() => sequence++)
</script>

<template>
  <section class="tea-page">
    <header class="tea-head">
      <div class="tea-head__lead">
        <NButton secondary circle title="返回活动列表" aria-label="返回活动列表" @click="$emit('back')">
          <template #icon>
            <span class="i-carbon-arrow-left" />
          </template>
        </NButton>
        <div class="tea-head__title">
          <h2>奶茶热销中</h2>
          <p v-if="mainState">
            <span class="i-carbon-calendar" aria-hidden="true" />{{ periodText }}
            <span v-if="daysLeft" class="tea-head__badge">{{ daysLeft }}</span>
            <span v-else-if="!mainState.active" class="tea-head__badge is-ended">已结束</span>
          </p>
        </div>
      </div>
      <NButton secondary circle :loading="busy" title="刷新活动数据" aria-label="刷新活动数据" @click="request()">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </header>

    <div class="tea-toolbar">
      <NTabs :value="mainPage" type="segment" class="tea-toolbar__tabs" aria-label="奶茶活动页面" @update:value="navigate">
        <NTab v-for="[key, label] in tabs" :key="key" :name="key" :disabled="busy">
          {{ label }}
        </NTab>
      </NTabs>
      <ul v-if="mainWallet.length" class="tea-wallet" aria-label="活动道具余额">
        <li v-for="item in mainWallet" :key="item.id" :title="item.name">
          <img :src="item.image" :alt="item.name"><b>{{ item.count.toLocaleString() }}</b>
        </li>
      </ul>
    </div>

    <main>
      <MilkTeaContent v-if="mainState" :key="mainPage" :state="mainState" :page="mainPage" :busy="busy" @navigate="navigate" @operation="request" @confirmation="select" @reload="reload" />
      <EmptyState
        v-else
        :title="!currentAccountId ? '请先选择账号' : busy ? '正在读取活动进度' : '暂未获取到活动数据'"
        :icon="busy ? 'i-svg-spinners-90-ring-with-bg' : 'i-carbon-cafe'"
      >
        <NButton v-if="currentAccountId && !busy" secondary @click="request()">
          重新加载
        </NButton>
      </EmptyState>
    </main>

    <NModal :show="!!panel" :mask-closable="!busy" :close-on-esc="!busy && !dialog" @update:show="!$event && closePanel()">
      <NCard
        class="tea-modal"
        :class="{ 'tea-modal--wide': panel && widePanels.includes(panel) }"
        :title="panel ? panelTitles[panel] : ''"
        :bordered="false"
        :closable="!busy"
        role="dialog"
        aria-modal="true"
        @close="closePanel"
      >
        <template v-if="panelWallet.length" #header-extra>
          <ul class="tea-wallet tea-wallet--compact" aria-label="活动道具余额">
            <li v-for="item in panelWallet" :key="item.id" :title="item.name">
              <img :src="item.image" :alt="item.name"><b>{{ item.count.toLocaleString() }}</b>
            </li>
          </ul>
        </template>
        <MilkTeaContent v-if="panelState && panel" :key="panel" :state="panelState" :page="panel" :busy="busy" @navigate="navigate" @operation="request" @confirmation="select" @reload="reload" />
        <EmptyState
          v-else
          :title="busy ? '正在加载' : '暂未获取到活动数据'"
          :icon="busy ? 'i-svg-spinners-90-ring-with-bg' : 'i-carbon-cafe'"
        >
          <NButton v-if="!busy" secondary @click="request()">
            重新加载
          </NButton>
        </EmptyState>
      </NCard>
    </NModal>

    <NModal :show="!!dialog" :mask-closable="!busy" :close-on-esc="!busy" @update:show="!$event && closeDialog()">
      <NCard class="tea-confirm" :title="dialog?.title" :bordered="false" :closable="!busy" role="dialog" aria-modal="true" @close="closeDialog">
        <div v-if="dialog" class="tea-confirm__body">
          <p v-if="dialog.description" class="tea-confirm__lead">
            {{ dialog.description }}
          </p>
          <p v-if="dialog.input?.name" class="tea-confirm__lead">
            {{ dialog.input.name }}
          </p>
          <section v-if="dialog.rewards?.length" class="tea-ledger" aria-label="将获得">
            <h4>将获得</h4>
            <ul>
              <li v-for="reward in dialog.rewards" :key="reward.id">
                <img :src="reward.image || itemImage(reward.id)" alt="" @error="hideImage">
                <span class="tea-ledger__name">{{ reward.name }}</span>
                <b>×{{ (reward.count * count).toLocaleString() }}</b>
              </li>
            </ul>
          </section>
          <div v-if="dialog.quantity" class="tea-confirm__quantity">
            <span>数量</span>
            <NInputNumber :value="count" :min="1" :max="dialog.max || 1" :disabled="busy" aria-label="数量" @update:value="setCount" />
            <NButton secondary :disabled="busy || count >= (dialog.max || 1)" @click="setCount(dialog.max || 1)">
              最大
            </NButton>
          </div>
          <div v-if="boostEstimate" class="tea-confirm__estimate">
            <strong>预计售出 {{ boostEstimate.cups }} 杯</strong>
            <span>奶茶券 ×{{ boostEstimate.token }}</span>
            <span v-if="boostEstimate.coin">金币 ×{{ boostEstimate.coin }}</span>
          </div>
          <section v-if="dialog.costs?.length" class="tea-ledger" aria-label="将消耗">
            <h4>将消耗</h4>
            <ul>
              <li v-for="cost in dialog.costs" :key="String(cost.id) + (cost.uid || '')" :class="{ 'is-short': holding(cost) !== null && Number(cost.count) * count > holding(cost)! }">
                <img :src="cost.image || itemImage(cost.id)" alt="" @error="hideImage">
                <span class="tea-ledger__name">{{ cost.name }}</span>
                <small v-if="holding(cost) !== null">持有 {{ holding(cost)!.toLocaleString() }}</small>
                <b>×{{ (cost.count * count).toLocaleString() }}</b>
              </li>
            </ul>
          </section>
          <p v-if="insufficient" class="tea-confirm__error" role="alert">
            <span class="i-carbon-warning-alt" aria-hidden="true" />道具数量不足
          </p>
        </div>
        <template #footer>
          <div class="tea-confirm__actions">
            <NButton :disabled="busy" @click="closeDialog">
              取消
            </NButton>
            <NButton type="primary" :loading="busy" :disabled="busy || insufficient" @click="confirm">
              确认
            </NButton>
          </div>
        </template>
      </NCard>
    </NModal>
  </section>
</template>

<style scoped>
.tea-page {
  display: flex;
  flex-direction: column;
  container: tea-page / inline-size;
}

.tea-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 14px 4px 12px;
  border-bottom: 1px solid var(--ui-border);
}

.tea-head__lead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.tea-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
}

.tea-toolbar__tabs {
  width: 360px;
}

.tea-head__title {
  min-width: 0;
  flex: 1;
}

.tea-head__title h2 {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-head__title p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tea-head__badge {
  padding: 0 7px;
  border-radius: 999px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.tea-head__badge.is-ended {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.tea-wallet {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-wallet li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 2px 3px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tea-wallet img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.tea-wallet b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.tea-wallet--compact {
  gap: 6px;
}

.tea-wallet--compact li {
  padding-right: 10px;
  font-size: 12px;
}

.tea-wallet--compact img {
  width: 20px;
  height: 20px;
}

/* 列表弹窗：卡片限高，内容区由 MilkTeaContent 内部的列表滚动，标题与底部按钮常驻。 */
.tea-modal {
  display: flex;
  width: min(640px, calc(100vw - 32px));
  max-height: min(88dvh, 960px);
  flex-direction: column;
  overflow: hidden;
}

.tea-modal--wide {
  width: min(960px, calc(100vw - 32px));
}

.tea-modal :deep(.n-card-header) {
  flex-wrap: wrap;
  gap: 8px 12px;
}

.tea-modal :deep(.n-card-header__extra) {
  order: 3;
  flex-basis: 100%;
}

.tea-modal :deep(.n-card-content) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

/* 确认弹窗：卡片限高在视口内，标题与底部按钮常驻，中间清单单独滚动（与 .tea-modal 同一套做法）。 */
.tea-confirm {
  display: flex;
  width: min(440px, calc(100vw - 32px));
  max-height: min(88vh, 960px);
  max-height: min(88dvh, 960px);
  flex-direction: column;
  overflow: hidden;
}

.tea-confirm :deep(.n-card-header),
.tea-confirm :deep(.n-card__footer) {
  flex: none;
}

.tea-confirm :deep(.n-card-content) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

.tea-confirm__body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.tea-confirm__lead {
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  line-height: 1.6;
}

.tea-confirm__quantity {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  color: var(--ui-muted);
  font-size: 13px;
}

.tea-confirm__estimate {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 12px 14px;
  border-radius: 12px;
  color: var(--ui-muted);
  background: var(--ui-primary-soft);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tea-confirm__estimate strong {
  flex-basis: 100%;
  color: var(--ui-primary);
  font-size: 14px;
  font-weight: var(--fw-650);
}

/* 确认清单：获得与消耗同一种行样式，图标不加框，数量右对齐 */
.tea-ledger h4 {
  margin: 0 0 6px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.tea-ledger ul {
  margin: 0;
  padding: 2px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
  list-style: none;
}

.tea-ledger li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  font-size: 14px;
}

.tea-ledger li + li {
  border-top: 1px solid var(--ui-border);
}

.tea-ledger img {
  width: 28px;
  height: 28px;
  flex: none;
  object-fit: contain;
}

.tea-ledger__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-ledger small {
  flex: none;
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tea-ledger b {
  flex: none;
  min-width: 56px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.tea-ledger li.is-short small,
.tea-ledger li.is-short b {
  color: var(--ui-danger);
}

.tea-confirm__error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ui-danger);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.tea-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@container tea-page (max-width: 600px) {
  .tea-toolbar__tabs {
    width: 100%;
  }
}

@media (max-width: 520px) {
  .tea-confirm__actions > :deep(.n-button) {
    flex: 1;
  }
}
</style>
