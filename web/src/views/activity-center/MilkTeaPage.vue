<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
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
const detailElement = ref<HTMLElement | null>(null)
const confirmElement = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
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
  return `${date(mainState.value.startTime)} — ${date(mainState.value.endTime)}`
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
function rewardsText(values: any[]) {
  return (values || []).map(v => `${v.name} ×${v.count}`).join('、')
}
function select(value: any) {
  count.value = 1
  dialog.value = value
}
function setCount(value: number) {
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
    if (panel.value)
      panelState.value = next
    else mainState.value = next
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
    panel.value = null
    mainPage.value = target
    mainState.value = null
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
function reload(input: any = {}) {
  filters = { ...filters, ...input }
  void request()
}
function confirm() {
  if (!dialog.value || busy.value || insufficient.value)
    return
  void request(dialog.value.action, { ...dialog.value.input, count: count.value, expectedCosts: dialog.value.costs })
}
watch([panel, dialog], async ([nextPanel, nextDialog], [oldPanel, oldDialog]) => {
  if ((nextPanel || nextDialog) && !oldPanel && !oldDialog)
    returnFocus = document.activeElement as HTMLElement
  await nextTick()
  if (nextDialog)
    confirmElement.value?.focus()
  else if (nextPanel)
    detailElement.value?.focus()
  else if (returnFocus?.isConnected)
    returnFocus.focus()
})
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab')
    return
  const container = event.currentTarget as HTMLElement
  const targets = [...container.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length)
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (!first || (event.shiftKey && (document.activeElement === first || document.activeElement === container)) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }
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
  <ActivityShell class="milk-shell" theme="day">
    <div class="tea-page" :inert="!!(panel || dialog)">
      <ActivityHeader title="奶茶热销中" :remaining="periodText" :loading="busy" show-refresh @back="$emit('back')" @refresh="request()" />
      <div class="tea-toolbar">
        <nav class="tea-tabs" aria-label="奶茶活动页面">
          <button v-for="[key, label] in tabs" :key="key" :disabled="busy" :class="{ selected: mainPage === key }" @click="navigate(key)">
            {{ label }}
          </button>
        </nav>
        <div v-if="mainWallet.length" class="tea-wallet" aria-label="活动道具余额">
          <span v-for="item in mainWallet" :key="item.id" class="tea-wallet__chip" :title="item.name">
            <img :src="item.image" :alt="item.name"><b>{{ item.count.toLocaleString() }}</b>
          </span>
        </div>
      </div>
      <main class="tea-scroll">
        <MilkTeaContent v-if="mainState" :key="mainPage" :state="mainState" :page="mainPage" :busy="busy" @navigate="navigate" @operation="request" @confirmation="select" @reload="reload" />
        <div v-else class="empty">
          <span>{{ !currentAccountId ? '请先选择账号' : busy ? '正在加载…' : '暂未获取到活动数据' }}</span><button v-if="currentAccountId && !busy" @click="request()">
            重新加载
          </button>
        </div>
      </main>
    </div>
    <Teleport to="body">
      <div v-if="panel" class="tea-mask" @click.self="closePanel">
        <section ref="detailElement" class="tea-detail" :class="{ 'tea-detail--wide': widePanels.includes(panel) }" role="dialog" aria-modal="true" :aria-label="panelTitles[panel]" :inert="!!dialog" tabindex="-1" @keydown="trapFocus" @keydown.esc="closePanel">
          <header>
            <h2>{{ panelTitles[panel] }}</h2>
            <div v-if="panelWallet.length" class="tea-wallet tea-wallet--dialog" aria-label="活动道具余额">
              <span v-for="item in panelWallet" :key="item.id" class="tea-wallet__chip" :title="item.name">
                <img :src="item.image" :alt="item.name"><b>{{ item.count.toLocaleString() }}</b>
              </span>
            </div>
            <button class="close" aria-label="关闭" :disabled="busy" @click="closePanel">
              <span class="i-carbon-close" />
            </button>
          </header>
          <div class="detail-scroll">
            <MilkTeaContent v-if="panelState" :key="panel" :state="panelState" :page="panel" :busy="busy" @navigate="navigate" @operation="request" @confirmation="select" @reload="reload" /><div v-else class="empty">
              <span>{{ busy ? '正在加载…' : '暂未获取到活动数据' }}</span><button v-if="!busy" @click="request()">
                重新加载
              </button>
            </div>
          </div>
        </section>
      </div>
      <div v-if="dialog" class="tea-mask confirmation" @click.self="!busy && (dialog = null)">
        <section ref="confirmElement" class="tea-dialog" role="dialog" aria-modal="true" :aria-label="dialog.title" tabindex="-1" @keydown="trapFocus" @keydown.esc="!busy && (dialog = null)">
          <header>
            <h2>{{ dialog.title }}</h2><button class="close" aria-label="关闭" :disabled="busy" @click="dialog = null">
              <span class="i-carbon-close" />
            </button>
          </header>
          <div class="confirmation-body">
            <p v-if="dialog.description">
              {{ dialog.description }}
            </p>
            <div v-if="dialog.rewards?.length" class="reward-list">
              <span v-for="reward in dialog.rewards" :key="reward.id"><CommerceItemImage :src="reward.image" :alt="reward.name" size="sm" />{{ reward.name }} ×{{ reward.count * count }}</span>
            </div>
            <div v-if="dialog.quantity" class="quantity">
              <button :disabled="busy || count <= 1" @click="setCount(count - 1)">
                −
              </button><input :value="count" aria-label="数量" inputmode="numeric" :disabled="busy" @input="setCount(Number(($event.target as HTMLInputElement).value))"><button :disabled="busy || count >= (dialog.max || 1)" @click="setCount(count + 1)">
                +
              </button><button :disabled="busy" @click="setCount(dialog.max || 1)">
                最大
              </button>
            </div>
            <p v-if="dialog.input.name">
              {{ dialog.input.name }}
            </p>
            <div v-if="boostEstimate" class="estimate">
              <strong>预计收益 · {{ boostEstimate.cups }}杯</strong><span>奶茶券 ×{{ boostEstimate.token }}</span><span v-if="boostEstimate.coin">金币 ×{{ boostEstimate.coin }}</span>
            </div>
            <div v-for="cost in dialog.costs" :key="String(cost.id) + (cost.uid || '')" class="row">
              <span>{{ cost.name }}</span><strong>×{{ cost.count * count }}</strong>
            </div><p v-if="insufficient" class="error">
              数量不足
            </p>
          </div>
          <footer>
            <button :disabled="busy" @click="dialog = null">
              取消
            </button><button class="primary" :disabled="busy || insufficient" @click="confirm">
              {{ busy ? '处理中…' : '确认' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </ActivityShell>
</template>

<style scoped>
.activity-shell.milk-shell {
  flex: 1 1 0;
  height: auto;
  min-height: 0;
}
.tea-page {
  --wood: #9a6438;
  --wood-dark: #5e3a1f;
  --paper: #fbf3e2;
  --paper-hi: #fffaf0;
  --ink: #4b301b;
  --muted: #7d5c40;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--ink);
  background: linear-gradient(180deg, #f7ecdc 0%, #efdfc8 100%);
  container-type: inline-size;
}
.tea-page :deep(.activity-header) {
  position: relative;
  inset: auto;
  flex-shrink: 0;
}
.tea-toolbar {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  gap: 10px;
  width: min(684px, calc(100% - 36px));
  margin: 14px auto 4px;
}
.tea-tabs {
  display: flex;
  gap: 6px;
  padding: 5px;
  border: 3px solid var(--wood);
  border-radius: 16px;
  background: #e7d0aa;
  box-shadow: inset 0 2px 0 rgba(94, 58, 31, 0.15);
}
.tea-tabs button {
  flex: 1;
  min-height: 40px;
  border: 0;
  border-radius: 11px;
  color: var(--muted);
  background: transparent;
  font-weight: var(--fw-800);
}
.tea-tabs button.selected {
  border: 2px solid var(--wood-dark);
  color: #5a3214;
  background: linear-gradient(180deg, #ffe58e, #ffc847);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.6),
    0 2px 0 var(--wood-dark);
}
.tea-tabs button:disabled:not(.selected) {
  opacity: 0.55;
  cursor: wait;
}
.tea-wallet {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.tea-wallet__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 14px 2px 3px;
  border: 2px solid rgba(94, 58, 31, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.tea-wallet__chip img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
/* PC 宽屏：页签和余额并排，与下方内容同宽 */
@container (min-width: 960px) {
  .tea-toolbar {
    width: min(1192px, calc(100% - 48px));
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .tea-tabs {
    width: 460px;
    flex: none;
  }
}
.tea-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(94, 58, 31, 0.3) transparent;
}
button,
input {
  font: inherit;
}
button {
  cursor: pointer;
}
.empty {
  display: grid;
  place-items: center;
  gap: 16px;
  padding: 60px 20px;
  color: var(--muted);
  font-size: 15px;
}
.empty button,
.tea-dialog footer button,
.quantity button {
  min-height: 40px;
  padding: 0 18px;
  border: 2px solid var(--wood-dark);
  border-radius: 12px;
  color: var(--ink);
  background: linear-gradient(180deg, var(--paper-hi), #f1e1c2);
  box-shadow: 0 3px 0 var(--wood-dark);
  font-weight: var(--fw-800);
}
button.primary {
  color: #5a3214;
  background: linear-gradient(180deg, #ffe58e, #ffc847);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.6),
    0 3px 0 var(--wood-dark);
}
.tea-dialog footer button:disabled,
.quantity button:disabled {
  border-color: #8a8178;
  color: #776e64;
  background: linear-gradient(180deg, #ded8ce, #c4bcb1);
  box-shadow: 0 3px 0 #8a8178;
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible {
  outline: 3px solid #f0a33a;
  outline-offset: 2px;
}

/* 弹窗：羊皮纸 + 红色书签关闭 */
.tea-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 18px;
  color: #4b301b;
  background: rgba(40, 24, 12, 0.55);
}
.confirmation {
  z-index: 1010;
}
.tea-detail,
.tea-dialog {
  --wood: #9a6438;
  --wood-dark: #5e3a1f;
  --paper: #fbf3e2;
  --paper-hi: #fffaf0;
  --ink: #4b301b;
  --muted: #7d5c40;
  position: relative;
  width: min(640px, 100%);
  max-height: min(88dvh, 1000px);
  border: 5px solid #8a5a35;
  border-radius: 22px;
  background: var(--paper);
  box-shadow:
    inset 0 0 0 3px #f3ddb0,
    0 6px 0 var(--wood-dark),
    0 24px 60px rgba(30, 15, 5, 0.45);
}
.tea-detail {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  container-type: inline-size;
}
.tea-detail--wide {
  width: min(920px, 100%);
}
.detail-scroll {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.detail-scroll > .empty {
  min-height: 0;
  overflow: auto;
}
.tea-detail > header,
.tea-dialog > header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  padding: 18px 64px 6px;
}
.tea-detail > header {
  flex-direction: column;
  gap: 8px;
}
.tea-wallet--dialog {
  justify-content: center;
  gap: 6px;
}
.tea-wallet--dialog .tea-wallet__chip {
  padding-right: 11px;
  font-size: 13px;
}
.tea-wallet--dialog img {
  width: 22px;
  height: 22px;
}
@media (max-height: 560px) {
  .activity-shell.milk-shell {
    min-height: 400px;
    flex-shrink: 0;
  }
}
/* 宽弹窗：余额放到标题左侧同一行，列表多出一行可视高度 */
@container (min-width: 700px) {
  .tea-detail > header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    padding: 18px 24px 6px;
  }
  .tea-detail > header > h2 {
    grid-row: 1;
    grid-column: 2;
  }
  .tea-wallet--dialog {
    grid-row: 1;
    grid-column: 1;
    justify-content: flex-start;
  }
}
h2 {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 4px 28px;
  border-radius: 8px;
  background: rgba(214, 190, 150, 0.55);
  font-size: 20px;
  font-weight: var(--fw-900);
  text-align: center;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.close {
  position: absolute;
  top: -6px;
  right: 18px;
  width: 46px;
  height: 56px;
  display: grid;
  place-items: center;
  padding: 0 0 8px;
  border: 0;
  border-radius: 4px 4px 0 0;
  color: #fff;
  background: linear-gradient(180deg, #e2645a, #c8443b);
  box-shadow: 0 3px 0 rgba(90, 20, 15, 0.45);
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 84%, 0 100%);
}
.close span {
  width: 26px;
  height: 26px;
}
.close:disabled {
  filter: grayscale(0.7);
  cursor: not-allowed;
}
.tea-dialog {
  display: flex;
  flex-direction: column;
  width: min(440px, 100%);
  padding: 0 22px 22px;
  overflow: hidden;
}
.tea-dialog > header {
  margin-inline: -22px;
  padding: 18px 64px 10px;
}
.confirmation-body {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.tea-dialog footer {
  display: flex;
  flex-shrink: 0;
  justify-content: center;
  gap: 14px;
  margin-top: 20px;
}
.tea-dialog footer button {
  min-width: 120px;
  min-height: 46px;
  font-size: 16px;
}
.confirmation-body > p {
  margin: 10px 0;
  text-align: center;
  font-weight: var(--fw-700);
}
.quantity {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}
.quantity button {
  flex-shrink: 0;
  padding: 0 14px;
  white-space: nowrap;
}
.quantity input {
  flex: 1;
  width: 0;
  min-width: 0;
  border: 2px solid #c9a97c;
  border-radius: 10px;
  color: inherit;
  background: var(--paper-hi);
  text-align: center;
  font-weight: var(--fw-800);
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1.5px dashed rgba(94, 58, 31, 0.25);
  font-size: 15px;
}
.reward-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 12px 0;
}
.reward-list > span {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px 3px 3px;
  border: 2px solid #e6cfa6;
  border-radius: 12px;
  background: var(--paper-hi);
  font-size: 13px;
  font-weight: var(--fw-700);
}
.estimate {
  display: grid;
  gap: 6px;
  margin: 14px 0;
  padding: 12px 14px;
  border: 2px dashed rgba(94, 58, 31, 0.3);
  border-radius: 12px;
  font-size: 14px;
}
.error {
  margin-top: 12px;
  color: #be4141;
  font-weight: var(--fw-700);
  text-align: center;
}
@media (max-width: 600px) {
  .tea-toolbar {
    width: calc(100% - 20px);
    margin-top: 10px;
    gap: 8px;
  }
  .tea-tabs button {
    font-size: 14px;
  }
  .tea-mask {
    padding: 12px;
  }
  .tea-detail > header {
    padding: 16px 58px 4px;
  }
  h2 {
    padding: 3px 12px;
    font-size: 18px;
  }
  .tea-dialog {
    padding: 0 16px 18px;
  }
  .tea-dialog > header {
    margin-inline: -16px;
    padding: 16px 64px 10px;
  }
  .tea-dialog footer button {
    min-width: 0;
    flex: 1;
  }
}
</style>
