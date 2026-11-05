<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NCheckbox } from 'naive-ui/es/checkbox'
import { NDropdown } from 'naive-ui/es/dropdown'
import { NInput } from 'naive-ui/es/input'
import { NSelect } from 'naive-ui/es/select'
import { NSwitch } from 'naive-ui/es/switch'
import { computed, onMounted, ref, watch } from 'vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import BookOverview from '@/components/illustrated/BookOverview.vue'
import { affordableCount } from '@/utils/purchase-count'
import MilkTeaWork from './MilkTeaWork.vue'

const { state, page, busy } = defineProps<{ state: any, page: string, busy: boolean }>()
const emit = defineEmits<{ navigate: [page: string], operation: [action: string, input: any], confirmation: [value: any], reload: [input: any] }>()
const name = ref('')
const hireDisabled = ref(false)
const durationId = ref(1)
const receivedAt = ref(Date.now())
const tick = ref(Date.now())
useIntervalFn(() => tick.value = Date.now(), 1000)
const now = computed(() => Number(state?.serverTime || 0) + (tick.value - receivedAt.value) / 1000)
const craftableFruits = computed<any[]>(() => (state?.fruits || []).filter((fruit: any) => !fruit.locked && Number(fruit.count) > 0 && state?.recipes?.some((recipe: any) => recipe.unlocked && recipe.fruitId === fruit.id)))
const rankPage = ref(1)
const logDate = ref('')
const rulesOpen = ref(false)
const selectedFruitUids = ref<string[]>([])
const candidates = computed<any[]>(() => [...(state?.hire?.friends || []), ...(state?.hire?.robots || [])])
const levelConfig = computed(() => state?.levels.find((v: any) => v.level === Number(state.summary.level)))
const freeSlot = computed(() => Array.from({ length: Number(levelConfig.value?.employee_slot_count || 0) }, (_, index) => index)
  .find(index => !(state?.shop?.slots || []).some((slot: any) => Number(slot.slot_index || 0) === index && Number(slot.end_at) > now.value)))
const canWork = computed(() => state?.active && !state?.settling)
const opened = computed(() => Number(state?.summary.shop_open_at) > 0)
// 店铺、兑换、工作三个页签是主页面，其余页面都在弹窗里显示，弹窗自带标题
const inDialog = computed(() => !['shop', 'exchange', 'work'].includes(page))
const nextLevel = computed(() => state?.levels.find((v: any) => v.level === Number(state.summary.level) + 1))
const revenuePercent = computed(() => {
  const next = Number(state?.shop?.next_level_revenue || 0)
  return next ? Math.min(100, Number(state.summary.total_revenue) / next * 100) : 100
})
const revenueText = computed(() => {
  const next = Number(state?.shop?.next_level_revenue || 0)
  return next ? `${Number(state.summary.total_revenue).toLocaleString()} / ${next.toLocaleString()}` : Number(state?.summary.total_revenue || 0).toLocaleString()
})
const pendingCups = computed(() => Object.entries(state?.shop?.pending_cups_by_recipe || {})
  .map(([id, cups]) => ({ id, cups: Number(cups), name: state.recipes?.find((v: any) => String(v.recipe_id) === id)?.recipe_name || `奶茶 #${id}` }))
  .filter(entry => entry.cups > 0))
const cashierText = computed(() => {
  const minutes = Math.floor(Number(state?.shop?.cashier_elapsed_sec || 0) / 60)
  const hours = Math.floor(minutes / 60)
  return `已累计 ${hours ? `${hours} 小时 ` : ''}${minutes % 60} 分 · 上限 ${Number(state?.shop?.cashier_capacity_sec || 0) / 3600} 小时`
})
const durationOptions = computed(() => (state?.durations || []).map((duration: any) => ({ label: `${duration.duration_sec / 3600} 小时`, value: duration.duration_id })))
const fundReady = computed(() => !!state?.fund?.tiers.some((v: any) => v.state === 2))
// 低频入口收进“更多”菜单；升级、成长基金、雇佣、收益与制作留在页面上
const moreOptions = [
  { key: 'settings', label: '店铺设置' },
  { key: 'logs', label: '营业记录' },
  { key: 'rank', label: '排行榜' },
]
/** 按当前等级的员工位逐个列出：在岗的显示员工，其余为空位。 */
const staff = computed<any[]>(() => Array.from({ length: Number(levelConfig.value?.employee_slot_count || 0) }, (_, index) =>
  (state?.shop?.slots || []).find((slot: any) => Number(slot.slot_index || 0) === index && Number(slot.end_at) > now.value) || null))
/** 道具格角标空间有限，万以上用“万”缩写，完整数量在 title 里。 */
function countText(value: any) {
  const count = Number(value) || 0
  return count >= 10000 ? `${Number((count / 10000).toFixed(count >= 100000 ? 0 : 1))}万` : String(count)
}
function itemImage(id: number | string) {
  return `/game-config/seed_images_named/seed_images/${id}.png`
}
function date(value: any) {
  return Number(value) > 0 ? new Date(Number(value) * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'
}
function remaining(value: any) {
  const seconds = Math.max(0, Math.ceil(Number(value) - now.value))
  if (!seconds)
    return '已结束'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `剩余 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}
function rewardsText(values: any[]) {
  return (values || []).map(v => `${v.name} ×${v.count}`).join('、')
}
function limitLabel(period: string) {
  return ({ daily: '每日限购', weekly: '每周限购', monthly: '每月限购', permanent: '永久限购' } as Record<string, string>)[period] || '限购'
}
function fruitsOf(recipe: any) {
  return (state?.fruits || []).filter((v: any) => v.id === recipe.fruitId)
}
function recipeStock(recipe: any) {
  if (!recipe.unlocked)
    return ''
  return recipe.is_advanced ? `库存 ${state.shop.drink_cups?.[recipe.recipe_id] || 0}` : '不限量'
}
function fundTierLabel(tier: any) {
  if (tier.state === 3)
    return '已领取'
  if (!state.fund.unlocked)
    return '未解锁'
  return tier.state === 2 ? '可领取' : '未达成'
}
function toggleFruit(uid: string, checked: boolean) {
  selectedFruitUids.value = checked ? [...selectedFruitUids.value, uid] : selectedFruitUids.value.filter(value => value !== uid)
}
function switchPage(value: string) {
  emit('navigate', value)
}
function select(action: string, title: string, input: any = {}, costs?: any[], rewards?: any[], max?: number) {
  emit('confirmation', { action, title, input, costs, rewards, quantity: max !== undefined, max })
}
function exchangeMax(goods: any) {
  const byBalance = affordableCount((goods?.costs || []).map((cost: any) => ({
    id: cost.id,
    count: Number(cost.count),
    balance: Number(state?.balances?.[cost.id] ?? Number.NaN),
  })))
  return Math.min(9999, goods?.remaining ?? 9999, byBalance)
}
function request(action = '', input: any = {}) {
  if (action)
    emit('operation', action, input)
  else emit('reload', { durationId: durationId.value, pageNumber: rankPage.value, day: logDate.value ? Math.floor(new Date(`${logDate.value}T00:00:00+08:00`).getTime() / 1000) : 0 })
}
function changeDuration(value: number) {
  durationId.value = value
  request()
}
function changeRankPage(step: number) {
  rankPage.value += step
  request()
}
function craft(all = false) {
  if (busy || !canWork.value)
    return
  const fruits = craftableFruits.value.filter(v => all || selectedFruitUids.value.includes(v.uid))
  if (!fruits.length)
    return
  select('craft', '确认制作', { fruits: fruits.map((v: any) => ({ uid: v.uid, count: v.count })) }, fruits)
}
function hire(candidate: any) {
  if (freeSlot.value === undefined || busy)
    return
  select('hire', '确认雇佣', { targetGid: candidate.friend.gid, durationId: durationId.value }, [{ id: 1041, name: '奶茶券', count: Number(state.hire.wage_total) }])
}
function boost() {
  const itemId = Number(state.shop.sales_item_id)
  select('boost', '一键爆单', {}, [{ id: itemId, name: '宣传喇叭', count: 1 }], [], Math.min(9999, state.balances[itemId]))
}
watch(() => state, () => {
  receivedAt.value = Date.now()
  tick.value = receivedAt.value
  name.value = state?.summary.shop_name || state?.recommendedNames?.[0] || ''
  hireDisabled.value = !!state?.summary.hire_disabled
  selectedFruitUids.value = []
}, { immediate: true })
// 升级 / 基金弹窗首次打开时，把下一级或可领取的档位滚到可视区域；之后的刷新保持用户自己的滚动位置
const listElement = ref<HTMLElement | null>(null)
onMounted(() => {
  const list = listElement.value
  const target = list?.querySelector<HTMLElement>('.is-next')
  if (list && target && target.offsetTop + target.offsetHeight > list.clientHeight)
    list.scrollTop = target.offsetTop - 8
})
</script>

<template>
  <div class="tea-content" :class="inDialog ? 'tea-content--dialog' : 'tea-content--page'">
    <!-- 尚未开店：任何页面都先引导开店 -->
    <section v-if="!opened" class="tea-card tea-open">
      <div class="tea-open__intro">
        <span class="tea-open__icon" aria-hidden="true"><span class="i-carbon-cafe" /></span>
        <div>
          <h3>开一家奶茶店</h3>
          <p>起一个店名就能开始营业，店名最多 8 个字，之后可在店铺设置里修改。</p>
        </div>
      </div>
      <div class="tea-open__form">
        <NInput v-model:value="name" :maxlength="8" show-count placeholder="输入店名" aria-label="店名" :disabled="busy" />
        <div v-if="state.recommendedNames?.length" class="tea-open__names" aria-label="推荐店名">
          <button v-for="suggestion in state.recommendedNames" :key="suggestion" type="button" class="tea-pick" :class="{ 'is-selected': name === suggestion }" :aria-pressed="name === suggestion" @click="name = suggestion">
            {{ suggestion }}
          </button>
        </div>
        <NButton type="primary" size="large" :loading="busy" :disabled="busy || !canWork || !name" @click="select('create', '开始营业', { name })">
          开始营业
        </NButton>
      </div>
    </section>

    <!-- 我的店铺 -->
    <div v-else-if="page === 'shop' && state.shop" class="tea-shop">
      <BookOverview
        class="tea-shop__overview"
        :title="state.summary.shop_name"
        icon="i-carbon-store"
        :badge-value="state.summary.level"
        badge-label="店铺等级"
        :caption="`每小时热卖 ${state.shop.effective_cups_per_hour} 杯`"
        :progress-text="revenueText"
        :percent="revenuePercent"
        :hint="state.shop.next_level_revenue ? '升级所需营业额' : '店铺已满级'"
      >
        <template #actions>
          <NButton :type="state.summary.can_upgrade ? 'primary' : 'default'" :secondary="!state.summary.can_upgrade" :disabled="busy" @click="switchPage('upgrade')">
            {{ state.summary.can_upgrade ? '可以升级' : '店铺升级' }}
          </NButton>
          <NButton secondary :disabled="busy" @click="switchPage('fund')">
            成长基金
          </NButton>
          <NDropdown trigger="click" placement="bottom-end" :options="moreOptions" :disabled="busy" @select="switchPage">
            <NButton secondary circle class="tea-more" :disabled="busy" title="更多店铺功能" aria-label="更多店铺功能">
              <template #icon>
                <span class="i-carbon-overflow-menu-horizontal" />
              </template>
            </NButton>
          </NDropdown>
        </template>
      </BookOverview>

      <!-- 日常操作：收益与制作。宽屏固定在右侧，窄屏紧跟概览 -->
      <aside class="tea-shop__ops">
        <section class="tea-card tea-cashier" aria-labelledby="tea-cashier-title">
          <header class="tea-card__head">
            <h3 id="tea-cashier-title">
              收银台
            </h3>
            <span>{{ cashierText }}</span>
          </header>
          <ul v-if="pendingCups.length" class="tea-cashier__cups">
            <li v-for="entry in pendingCups" :key="entry.id">
              <span>{{ entry.name }}</span><b>{{ entry.cups }} 杯</b>
            </li>
          </ul>
          <p v-else class="tea-empty">
            收银台暂时没有新收益
          </p>
          <div class="tea-cashier__total">
            <h4>合计收益</h4>
            <ul class="tea-items tea-cashier__rewards">
              <li v-for="reward in state.shop.pending_rewards" :key="reward.id" class="tea-item" :title="`${reward.name} ×${reward.count}`">
                <span class="tea-item__well"><CommerceItemImage :src="reward.image" :alt="reward.name" /></span>
                <span class="tea-cashier__reward-details">
                  <span class="tea-item__name">{{ reward.name }}</span>
                  <b class="tea-cashier__amount">×{{ Number(reward.count).toLocaleString() }}</b>
                </span>
              </li>
            </ul>
          </div>
          <div class="tea-cashier__actions">
            <NButton secondary :disabled="busy || !canWork || !(state.balances[state.shop.sales_item_id] > 0)" @click="boost">
              <template #icon>
                <img class="tea-btn-icon" :src="itemImage(state.shop.sales_item_id)" alt="">
              </template>
              一键爆单
            </NButton>
            <NButton type="primary" :loading="busy" :disabled="busy || !state.shop.pending_rewards.some((v: any) => v.count > 0)" @click="request('claim')">
              领取收益
            </NButton>
          </div>
        </section>

        <NButton type="primary" size="large" block class="tea-make" :disabled="busy" @click="switchPage('workshop')">
          <template #icon>
            <span class="i-carbon-cafe" />
          </template>
          制作奶茶
        </NButton>
      </aside>

      <section class="tea-card tea-staff tea-shop__staff" aria-labelledby="tea-staff-title">
        <header class="tea-card__head">
          <h3 id="tea-staff-title">
            员工<small>{{ staff.filter(v => v).length }} / {{ staff.length }}</small>
          </h3>
          <NButton size="small" :type="freeSlot !== undefined ? 'primary' : 'default'" :secondary="freeSlot === undefined" :disabled="busy" @click="switchPage('hireList')">
            {{ freeSlot !== undefined ? '雇佣好友' : '查看' }}
          </NButton>
        </header>
        <ul class="tea-staff__slots">
          <li v-for="(slot, index) in staff" :key="index" class="tea-staff__slot" :class="{ 'is-empty': !slot }">
            <template v-if="slot">
              <span class="tea-staff__avatar" aria-hidden="true">{{ String(slot.employee?.name || '员').slice(0, 1) }}</span>
              <span class="tea-staff__who"><strong>{{ slot.employee?.name || '员工' }}</strong><small>{{ slot.talent_name }}</small></span>
              <b class="tea-staff__time">{{ remaining(slot.end_at) }}</b>
            </template>
            <template v-else>
              <span class="tea-staff__avatar" aria-hidden="true"><span class="i-carbon-add" /></span>
              <span class="tea-staff__who"><strong>空位</strong><small>雇佣好友帮忙卖奶茶</small></span>
            </template>
          </li>
        </ul>
      </section>

      <section class="tea-section tea-shop__shelf" aria-labelledby="tea-shelf-title">
        <h3 id="tea-shelf-title" class="tea-section__title">
          奶茶货架<small>{{ state.recipes.filter((v: any) => v.unlocked).length }} / {{ state.recipes.length }} 已解锁</small>
        </h3>
        <ul class="tea-shelf">
          <li v-for="recipe in state.recipes" :key="recipe.recipe_id" class="tea-cup" :class="{ 'is-locked': !recipe.unlocked, 'is-advanced': recipe.is_advanced }" :title="recipe.description">
            <span class="tea-cup__well"><img :src="recipe.image" alt="" width="56" height="56"></span>
            <strong>{{ recipe.recipe_name }}</strong>
            <span class="tea-cup__price">
              <span><img :src="itemImage(1041)" alt="奶茶券">{{ recipe.token_price || 0 }}</span>
              <span v-if="Number(recipe.coin_price)">金币 {{ Number(recipe.coin_price).toLocaleString() }}</span>
            </span>
            <span class="tea-cup__stock">
              <template v-if="recipe.unlocked">{{ recipeStock(recipe) }}</template>
              <template v-else><span class="i-carbon-locked" aria-hidden="true" />未解锁</template>
            </span>
          </li>
        </ul>
      </section>
    </div>

    <!-- 兑换商店 -->
    <section v-else-if="page === 'exchange'" class="tea-section" aria-labelledby="tea-goods-title">
      <h3 id="tea-goods-title" class="tea-section__title">
        兑换商品<small>{{ state.goods.length }}</small>
      </h3>
      <ul class="tea-goods">
        <li v-for="goods in state.goods" :key="goods.id" class="tea-card tea-goods-card" :class="{ 'is-off': !goods.available, 'is-set': goods.rewards.length > 1 }">
          <strong class="tea-goods-card__name">{{ goods.name || goods.rewards[0]?.name }}</strong>
          <ul class="tea-items tea-items--center" :class="{ 'tea-items--sm': goods.rewards.length > 1 }">
            <li v-for="reward in goods.rewards" :key="reward.id" class="tea-item" :title="`${reward.name} ×${reward.count}`">
              <span class="tea-item__well"><CommerceItemImage :src="reward.image" :alt="reward.name" /></span>
            </li>
          </ul>
          <span v-if="goods.remaining !== null" class="tea-goods-card__meta">{{ limitLabel(goods.limitPeriod) }} {{ goods.remaining }}/{{ goods.purchaseLimit }}</span>
          <span v-for="condition in goods.conditions.filter((value: any) => !value.satisfied)" :key="condition.type" class="tea-goods-card__meta is-warning">需店铺等级 {{ condition.target }}（当前 {{ condition.current }}）</span>
          <NButton class="tea-goods-card__buy" :type="goods.available ? 'primary' : 'default'" :secondary="!goods.available" block :disabled="busy || !state.active || !goods.available" @click="select('exchange', goods.name || goods.rewards[0]?.name, { goodsId: goods.id }, goods.costs, goods.rewards, exchangeMax(goods))">
            <template v-if="goods.remaining === 0">
              已售罄
            </template>
            <span v-else class="tea-price">
              <span v-for="cost in goods.costs" :key="cost.id"><img :src="cost.image" :alt="cost.name">{{ Number(cost.count).toLocaleString() }}</span>
            </span>
          </NButton>
        </li>
      </ul>
    </section>

    <!-- 我的工作 / 工作事项 -->
    <MilkTeaWork v-else-if="['work', 'workItems'].includes(page) && state.work" :state="state" :busy="busy" :selection-only="page === 'workItems'" @navigate="switchPage" @operation="request" @confirmation="emit('confirmation', $event)" />

    <!-- 店铺设置 -->
    <div v-else-if="page === 'settings'" class="tea-panel tea-panel--form">
      <section class="tea-field">
        <h4>店铺改名</h4>
        <div class="tea-field__row">
          <NInput v-model:value="name" :maxlength="8" show-count aria-label="店铺改名" :disabled="busy" />
          <NButton type="primary" :disabled="busy || !canWork || !name || name === state.summary.shop_name || Number(state.summary.rename_cd_until_at) > state.serverTime" @click="select('rename', '店铺改名', { name })">
            改名
          </NButton>
        </div>
        <p v-if="Number(state.summary.rename_cd_until_at) > state.serverTime" class="tea-note">
          下次可改名：{{ date(state.summary.rename_cd_until_at) }}
        </p>
      </section>
      <section class="tea-field">
        <h4>我的打工设置</h4>
        <div class="tea-switch-row">
          <div>
            <strong id="milk-hire-mode-label">躺平模式</strong>
            <p class="tea-note">
              开启后好友无法雇佣你
            </p>
          </div>
          <NSwitch v-model:value="hireDisabled" :disabled="busy" aria-labelledby="milk-hire-mode-label" />
        </div>
      </section>
      <footer class="tea-panel__foot">
        <NButton type="primary" :loading="busy" :disabled="busy || !state.active || hireDisabled === !!state.summary.hire_disabled" @click="request('hireSetting', { disabled: hireDisabled })">
          保存设置
        </NButton>
      </footer>
    </div>

    <!-- 店铺升级 -->
    <div v-else-if="page === 'upgrade' && state.shop" class="tea-panel">
      <div class="tea-panel__bar">
        <div class="tea-meter">
          <div class="tea-meter__text">
            <span>营业额</span><b>{{ revenueText }}</b>
          </div>
          <div class="tea-meter__track" role="progressbar" aria-label="升级所需营业额" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(revenuePercent)" :aria-valuetext="revenueText">
            <span :style="{ width: `${revenuePercent}%` }" />
          </div>
        </div>
        <span class="tea-tag">当前 {{ state.summary.level }} 级</span>
      </div>
      <div ref="listElement" class="tea-panel__list custom-scrollbar" role="region" aria-label="店铺等级" tabindex="0">
        <article v-for="level in state.levels" :key="level.level" class="tea-row tea-row--level" :class="{ 'is-next': level.level === Number(state.summary.level) + 1, 'is-done': level.level <= Number(state.summary.level) }">
          <div class="tea-row__head">
            <strong>{{ level.level }} 级</strong><span>营业额 {{ level.revenue_required.toLocaleString() }}</span>
          </div>
          <div class="tea-row__body">
            <dl class="tea-metrics">
              <div><dt>热卖值</dt><dd>{{ level.base_popularity }} 杯/小时</dd></div>
              <div><dt>高级奶茶售价</dt><dd>+{{ level.advanced_price_percent / 100 }}%</dd></div>
              <div><dt>员工</dt><dd>{{ level.employee_slot_count }}</dd></div>
            </dl>
            <div v-if="level.recipes?.length" class="tea-chips">
              <span v-for="recipe in level.recipes" :key="recipe">{{ recipe }}</span>
            </div>
          </div>
          <ul v-if="level.rewards.length" class="tea-items tea-items--sm tea-row__rewards">
            <li v-for="reward in level.rewards" :key="reward.id" class="tea-item" :title="`${reward.name} ×${reward.count}`">
              <span class="tea-item__well"><CommerceItemImage :src="reward.image" :alt="reward.name" /><b>{{ countText(reward.count) }}</b></span>
              <span class="tea-item__name">{{ reward.name }}</span>
            </li>
          </ul>
        </article>
      </div>
      <footer v-if="nextLevel" class="tea-panel__foot">
        <NButton type="primary" size="large" :loading="busy" :disabled="busy || !state.active || !state.summary.can_upgrade" @click="select('upgrade', '店铺升级', { expectedLevel: Number(state.summary.level) }, [], nextLevel.rewards)">
          升级到 {{ nextLevel.level }} 级
        </NButton>
      </footer>
    </div>

    <!-- 奶茶工坊 -->
    <div v-else-if="page === 'workshop'" class="tea-panel">
      <div class="tea-panel__bar">
        <p class="tea-note tea-panel__hint">
          勾选果实后确认制作，会消耗所选的整组果实。
        </p>
        <NButton secondary :disabled="busy || !canWork || !craftableFruits.length" @click="craft(true)">
          全部制作
        </NButton>
        <NButton type="primary" :disabled="busy || !canWork || !selectedFruitUids.length" @click="craft(false)">
          {{ selectedFruitUids.length ? `制作所选（${selectedFruitUids.length}）` : '制作所选' }}
        </NButton>
      </div>
      <div class="tea-panel__list custom-scrollbar" role="region" aria-label="奶茶配方" tabindex="0">
        <article v-for="recipe in state.recipes" :key="recipe.recipe_id" class="tea-row tea-row--recipe" :class="{ 'is-done': !recipe.unlocked }">
          <div class="tea-recipe">
            <span class="tea-cup__well"><img :src="recipe.image" alt="" width="48" height="48"></span>
            <div class="tea-recipe__text">
              <strong>{{ recipe.recipe_name }}</strong>
              <p class="tea-note">
                {{ recipe.description }}
              </p>
            </div>
            <span class="tea-tag" :class="{ 'is-muted': !recipe.unlocked }">{{ recipe.unlocked ? `库存 ${recipe.stock_cups === '-1' ? '不限量' : recipe.stock_cups || 0}` : '未解锁' }}</span>
          </div>
          <ul v-if="fruitsOf(recipe).length" class="tea-fruits">
            <li v-for="fruit in fruitsOf(recipe)" :key="fruit.uid" class="tea-fruit" :class="{ 'is-checked': selectedFruitUids.includes(fruit.uid) }">
              <NCheckbox :checked="selectedFruitUids.includes(fruit.uid)" :disabled="busy || fruit.locked || !canWork" @update:checked="toggleFruit(fruit.uid, $event)">
                <span class="tea-fruit__label">
                  <CommerceItemImage :src="fruit.image" :alt="fruit.name" size="sm" />
                  <span>{{ fruit.name }} <b>×{{ fruit.count }}</b></span>
                  <span v-if="fruit.locked" class="tea-tag is-muted">已锁定</span>
                  <span v-if="fruit.mutations.length" class="tea-note">变异 {{ fruit.mutations.join('、') }}</span>
                </span>
              </NCheckbox>
            </li>
          </ul>
        </article>
      </div>
    </div>

    <!-- 好友雇佣 -->
    <div v-else-if="page === 'hireList' && state.hire" class="tea-panel">
      <div class="tea-panel__bar">
        <label class="tea-inline-field">
          <span>雇佣时长</span>
          <NSelect :value="durationId" :options="durationOptions" :disabled="busy" size="small" class="tea-inline-field__select" @update:value="changeDuration" />
        </label>
        <span class="tea-cost"><img :src="itemImage(1041)" alt="奶茶券">工资 <b>{{ state.hire.wage_total }}</b></span>
      </div>
      <div class="tea-panel__list custom-scrollbar" role="region" aria-label="员工列表" tabindex="0">
        <h4 class="tea-list-title">
          在岗员工<small>{{ state.shop.slots.length }}</small>
        </h4>
        <ul class="tea-lines">
          <li v-for="slot in state.shop.slots" :key="slot.slot_index" class="tea-line">
            <div class="tea-line__main">
              <strong>{{ slot.employee?.name }}</strong><span class="tea-tag">{{ slot.talent_name }}</span>
            </div>
            <div class="tea-time">
              <b>{{ remaining(slot.end_at) }}</b><time>{{ date(slot.end_at) }}</time>
            </div>
          </li>
        </ul>
        <p v-if="!state.shop.slots.length" class="tea-empty">
          还没有雇佣员工
        </p>
        <h4 class="tea-list-title">
          可雇佣<small>{{ candidates.length }}</small>
        </h4>
        <ul class="tea-lines">
          <li v-for="candidate in candidates" :key="candidate.friend.gid" class="tea-line">
            <div class="tea-line__main">
              <strong>{{ candidate.friend.name }}</strong><span class="tea-note">{{ candidate.talent_name }}</span>
            </div>
            <div v-if="Number(candidate.state_until_at) > 0" class="tea-time">
              <b>{{ remaining(candidate.state_until_at) }}</b><time>{{ date(candidate.state_until_at) }}</time>
            </div>
            <NButton size="small" type="primary" :disabled="busy || !canWork || Number(candidate.state || 0) !== 0 || Number(candidate.rehire_available_at || 0) > now || freeSlot === undefined" @click="hire(candidate)">
              雇佣
            </NButton>
          </li>
        </ul>
      </div>
    </div>

    <!-- 成长基金 -->
    <div v-else-if="page === 'fund'" class="tea-panel">
      <div class="tea-panel__bar">
        <p class="tea-note tea-panel__hint">
          {{ state.fund.unlocked ? '店铺等级达标后即可领取对应档位。' : '解锁后，店铺每升到指定等级都能领取一档奖励。' }}
        </p>
        <NButton v-if="!state.fund.unlocked" type="primary" :disabled="busy || !state.active" @click="select('unlock', '解锁成长基金', {}, state.fund.costs)">
          {{ rewardsText(state.fund.costs) }} 解锁
        </NButton>
        <NButton v-else type="primary" :loading="busy" :disabled="busy || !state.active || !fundReady" @click="request('fundClaim')">
          领取奖励
        </NButton>
      </div>
      <div ref="listElement" class="tea-panel__list custom-scrollbar" role="region" aria-label="成长基金奖励" tabindex="0">
        <article v-for="tier in state.fund.tiers" :key="tier.id" class="tea-row tea-row--fund" :class="{ 'is-next': state.fund.unlocked && tier.state === 2, 'is-done': tier.state === 3 }">
          <div class="tea-row__head">
            <strong v-for="condition in tier.conditions" :key="condition.type">店铺等级 {{ condition.target }}</strong>
            <span class="tea-tag" :class="{ 'is-muted': tier.state !== 2 || !state.fund.unlocked }">{{ fundTierLabel(tier) }}</span>
          </div>
          <ul class="tea-items tea-items--sm tea-row__rewards">
            <li v-for="reward in tier.rewards" :key="reward.id" class="tea-item" :title="`${reward.name} ×${reward.count}`">
              <span class="tea-item__well"><CommerceItemImage :src="reward.image" :alt="reward.name" /><b>{{ countText(reward.count) }}</b></span>
              <span class="tea-item__name">{{ reward.name }}</span>
            </li>
          </ul>
        </article>
      </div>
    </div>

    <!-- 营业记录 -->
    <div v-else-if="page === 'logs' && state.logs" class="tea-panel">
      <div class="tea-panel__bar">
        <label class="tea-inline-field">
          <span>日期</span>
          <input v-model="logDate" class="tea-date" type="date" :disabled="busy" aria-label="选择日期" @change="request()">
        </label>
      </div>
      <div class="tea-panel__list custom-scrollbar" role="region" aria-label="营业记录" tabindex="0">
        <dl class="tea-stats">
          <div><dt>奶茶券</dt><dd>{{ state.logs.token || 0 }}</dd></div>
          <div><dt>金币</dt><dd>{{ state.logs.coin || 0 }}</dd></div>
          <div><dt>售出奶茶</dt><dd>{{ state.logs.cups || 0 }} 杯</dd></div>
        </dl>
        <h4 class="tea-list-title">
          雇佣记录<small>{{ state.logs.hires?.length || 0 }}</small>
        </h4>
        <ul class="tea-lines">
          <li v-for="hireRecord in state.logs.hires" :key="hireRecord.shift_id" class="tea-line">
            <div class="tea-line__main tea-line__main--stack">
              <strong>{{ hireRecord.friend?.name }}</strong><time class="tea-note">{{ date(hireRecord.hire_at) }}</time>
            </div>
            <span class="tea-tag">{{ hireRecord.talent_name }}</span>
            <span class="tea-line__value">工资 <b>{{ hireRecord.wages?.final_wage || 0 }}</b></span>
          </li>
        </ul>
        <p v-if="!state.logs.hires?.length" class="tea-empty">
          当天没有雇佣记录
        </p>
      </div>
    </div>

    <!-- 排行榜 -->
    <div v-else-if="page === 'rank' && state.rank" class="tea-panel">
      <div class="tea-panel__list custom-scrollbar" role="region" aria-label="排行榜" tabindex="0">
        <ol class="tea-lines">
          <li v-for="entry in state.rank.ranks" :key="entry.owner?.gid" class="tea-line">
            <b class="tea-rank" :class="{ 'is-top': Number(entry.rank) <= 3 }">{{ entry.rank }}</b>
            <div class="tea-line__main tea-line__main--stack">
              <strong>{{ entry.shop_name }}</strong><span class="tea-note">{{ entry.owner?.name }}</span>
            </div>
            <span class="tea-line__value">营业额 <b>{{ Number(entry.total_revenue).toLocaleString() }}</b></span>
          </li>
        </ol>
        <p v-if="!state.rank.ranks?.length" class="tea-empty">
          暂无排行数据
        </p>
      </div>
      <footer class="tea-panel__foot">
        <NButton secondary :disabled="busy || rankPage <= 1" @click="changeRankPage(-1)">
          上一页
        </NButton>
        <span class="tea-note">第 {{ rankPage }} 页</span>
        <NButton secondary :disabled="busy || !state.rank.has_more" @click="changeRankPage(1)">
          下一页
        </NButton>
      </footer>
    </div>

    <!-- 活动说明：三个主页面底部，可折叠 -->
    <section v-if="!inDialog && state.rules.length" class="tea-section">
      <button type="button" class="tea-section__title tea-section__toggle" :aria-expanded="rulesOpen" aria-controls="tea-rules" @click="rulesOpen = !rulesOpen">
        活动说明
        <span class="tea-section__chevron i-carbon-chevron-down" :class="{ 'is-open': rulesOpen }" aria-hidden="true" />
      </button>
      <div v-if="rulesOpen" id="tea-rules" class="tea-card tea-rules">
        <p v-for="(line, index) in state.rules" :key="index" :class="{ 'is-title': /^【.+】$/.test(line.trim()) }">
          {{ line.trim().replace(/^【(.+)】$/, '$1') }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 主页面不设最大宽度，宽度交给外层布局（与其他页面一致）；弹窗页撑满卡片内容区。 */
.tea-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  color: var(--ui-ink);
}

.tea-content--page {
  padding: 16px 0 32px;
  container: tea-content / inline-size;
}

.tea-content--dialog {
  min-height: 0;
  flex: 1;
  container: tea-dialog / inline-size;
}

h3,
h4,
p {
  margin: 0;
}

/* —— 通用积木 —— */
.tea-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
}

.tea-section {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.tea-section__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.tea-section__title small,
.tea-list-title small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
  font-variant-numeric: tabular-nums;
}

.tea-section__toggle {
  align-self: flex-start;
  align-items: center;
  padding: 4px 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 14px;
  font-weight: var(--fw-650);
  cursor: pointer;
}

.tea-section__toggle:hover {
  color: var(--ui-primary);
}

.tea-section__chevron {
  color: var(--ui-subtle);
  transition: transform var(--spring-drag-duration) var(--spring-drag);
}

.tea-section__chevron.is-open {
  transform: rotate(180deg);
}

.tea-note {
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
}

.tea-empty {
  padding: 16px 0;
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}

.tea-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  font-weight: var(--fw-600);
  line-height: 20px;
  white-space: nowrap;
}

.tea-tag.is-muted {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.tea-btn-icon {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

/* 道具格：图片井 + 右下角数量 + 单行名称 */
.tea-items {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-items--center {
  justify-content: center;
}

.tea-item {
  display: flex;
  width: 72px;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.tea-item__well {
  position: relative;
  display: grid;
  width: 60px;
  height: 60px;
  place-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.tea-item__well :deep(.item-image) {
  width: 82%;
  height: 82%;
  border: 0;
  background: transparent;
}

.tea-item__well b {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 0 5px;
  border-radius: 999px;
  color: #fff;
  background: rgba(24, 32, 27, 0.62);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tea-item__name {
  max-width: 100%;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-items--sm .tea-item {
  width: 64px;
}

.tea-items--sm .tea-item__well {
  width: 48px;
  height: 48px;
  border-radius: 10px;
}

.tea-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tea-chips span {
  padding: 1px 9px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
}

.tea-pick {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-solid);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.tea-pick:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
}

.tea-pick.is-selected {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.tea-section__toggle:focus-visible,
.tea-pick:focus-visible,
.tea-panel__list:focus-visible,
.tea-date:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
  border-radius: 8px;
}

.tea-panel__list:focus-visible {
  outline-offset: -2px;
}

/* —— 开店 —— */
.tea-open {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: 20px 32px;
  padding: 24px;
}

.tea-content--dialog .tea-open {
  grid-template-columns: minmax(0, 1fr);
  padding: 0;
  border: 0;
  background: transparent;
}

.tea-open__intro {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.tea-open__intro h3 {
  font-size: 16px;
  font-weight: var(--fw-650);
}

.tea-open__intro p {
  margin-top: 4px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.6;
}

.tea-open__icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  place-items: center;
  border-radius: 12px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 22px;
}

.tea-open__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tea-open__names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* —— 我的店铺 —— */
.tea-shop {
  display: grid;
  grid-template-areas:
    'overview'
    'ops'
    'staff'
    'shelf';
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.tea-shop__overview {
  grid-area: overview;
}

.tea-shop__ops {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  grid-area: ops;
}

.tea-shop__staff {
  grid-area: staff;
}

.tea-shop__shelf {
  grid-area: shelf;
}

.tea-shop .tea-more {
  flex: 0 0 auto;
}

.tea-more :deep(.n-button__icon) {
  font-size: 18px;
}

.tea-shelf {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-cup {
  display: grid;
  grid-template-areas:
    'well name stock'
    'well price price';
  grid-template-columns: 52px minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.tea-cup__well {
  display: grid;
  width: 52px;
  height: 52px;
  flex: none;
  place-items: center;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.tea-cup > .tea-cup__well {
  grid-area: well;
}

.tea-cup__well img {
  width: 82%;
  height: 82%;
  object-fit: contain;
}

.tea-cup strong {
  min-width: 0;
  overflow: hidden;
  grid-area: name;
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-cup__price {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 10px;
  grid-area: price;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tea-cup__price > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.tea-cup__price img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.tea-cup__stock {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  grid-area: stock;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
  white-space: nowrap;
}

.tea-cup.is-locked .tea-cup__well img {
  filter: grayscale(1);
  opacity: 0.4;
}

.tea-cup.is-locked strong {
  color: var(--ui-muted);
}

.tea-cup.is-locked .tea-cup__stock {
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
}

.tea-cashier {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 20px;
}

.tea-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
}

.tea-card__head h3 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 15px;
  font-weight: var(--fw-650);
}

.tea-card__head h3 small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
  font-variant-numeric: tabular-nums;
}

.tea-card__head > span {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 员工位：在岗显示名字与剩余时间，空位用虚线框提示可雇佣 */
.tea-staff {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 18px;
}

.tea-staff__slots {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-staff__slot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.tea-staff__slot.is-empty {
  border: 1px dashed var(--ui-border-strong);
  background: transparent;
}

.tea-staff__avatar {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.tea-staff__slot.is-empty .tea-staff__avatar {
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
}

.tea-staff__who {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.tea-staff__who strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: var(--fw-600);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-staff__who small {
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-staff__slot.is-empty strong {
  color: var(--ui-muted);
}

.tea-staff__time {
  flex: none;
  color: var(--ui-ink);
  font-size: 12px;
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.tea-cashier__cups {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-cashier__cups li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  font-size: 13px;
}

.tea-cashier__cups li + li {
  border-top: 1px dashed var(--ui-border);
}

.tea-cashier__cups b {
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.tea-cashier__total {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--ui-border);
}

.tea-cashier__total h4 {
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.tea-cashier__rewards {
  gap: 12px 24px;
}

.tea-cashier__rewards .tea-item {
  width: auto;
  max-width: 100%;
  flex-direction: row;
  gap: 10px;
}

.tea-cashier__rewards .tea-item__well {
  width: 44px;
  height: 44px;
  flex: none;
}

.tea-cashier__reward-details {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.tea-cashier__amount {
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tea-cashier__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.tea-make :deep(.n-button__icon) {
  font-size: 20px;
}

/* —— 兑换商店 —— */
.tea-goods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-goods-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 14px 14px;
  text-align: center;
}

.tea-goods-card__name {
  max-width: 100%;
  overflow: hidden;
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-goods-card__meta {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tea-goods-card__meta.is-warning {
  color: var(--ui-warning);
}

.tea-goods-card__buy {
  margin-top: auto;
}

.tea-goods-card.is-set .tea-items {
  flex-wrap: nowrap;
  gap: 6px;
}

.tea-goods-card.is-set .tea-item {
  width: auto;
}

.tea-goods-card.is-off .tea-item__well {
  filter: grayscale(0.6);
}

.tea-price {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 2px 8px;
  font-variant-numeric: tabular-nums;
}

.tea-price > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.tea-price img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

/* —— 活动说明 —— */
.tea-rules {
  padding: 16px 24px;
  column-width: 420px;
  column-gap: 40px;
}

.tea-rules p {
  margin: 0 0 6px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-line;
}

.tea-rules p.is-title {
  margin-top: 12px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  break-after: avoid;
}

.tea-rules p.is-title:first-child {
  margin-top: 0;
}

/* —— 弹窗页：工具栏 + 滚动列表 + 底部按钮 —— */
.tea-panel {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
}

.tea-panel--form {
  gap: 20px;
  overflow: auto;
}

.tea-panel__bar {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.tea-panel__hint {
  min-width: 180px;
  flex: 1;
}

.tea-panel__list {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  margin-inline: -4px;
  padding: 2px 4px 4px;
}

.tea-panel__list > .tea-row + .tea-row {
  margin-top: 8px;
}

.tea-panel__foot {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-top: 4px;
}

.tea-panel--form .tea-panel__foot {
  justify-content: flex-end;
}

.tea-field {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tea-field h4,
.tea-list-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-650);
}

.tea-list-title {
  margin: 14px 0 6px;
}

.tea-list-title:first-child {
  margin-top: 0;
}

.tea-field__row {
  display: flex;
  gap: 8px;
}

.tea-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.tea-switch-row strong {
  font-size: 14px;
  font-weight: var(--fw-600);
}

.tea-inline-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ui-muted);
  font-size: 13px;
}

.tea-inline-field__select {
  width: 120px;
}

.tea-date {
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control, 8px);
  color: var(--ui-ink);
  background: var(--ui-surface-solid);
  font: inherit;
  font-size: 13px;
  color-scheme: light dark;
}

.tea-cost {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--ui-muted);
  font-size: 13px;
}

.tea-cost img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.tea-cost b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.tea-meter {
  display: flex;
  min-width: 200px;
  flex: 1;
  flex-direction: column;
  gap: 6px;
}

.tea-meter__text {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-muted);
  font-size: 12px;
}

.tea-meter__text b {
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.tea-meter__track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.tea-meter__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ui-primary);
  transition: width var(--spring-drag-duration) var(--spring-drag);
}

/* 列表行卡片：窄屏上下堆叠，宽弹窗见末尾容器查询 */
.tea-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.tea-row.is-next {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  background: var(--ui-primary-soft);
}

.tea-row.is-done {
  opacity: 0.55;
}

.tea-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
}

.tea-row__head strong {
  font-size: 15px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.tea-row__head > span:not(.tea-tag) {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tea-row__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.tea-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0;
  font-size: 12px;
}

.tea-metrics div {
  display: flex;
  gap: 4px;
}

.tea-metrics dt {
  color: var(--ui-muted);
}

.tea-metrics dd {
  margin: 0;
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.tea-recipe {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.tea-recipe .tea-cup__well {
  width: 56px;
  height: 56px;
  border-radius: 12px;
}

.tea-recipe__text strong {
  font-size: 14px;
  font-weight: var(--fw-650);
}

.tea-fruits {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-fruit {
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--ui-surface-soft);
}

.tea-fruit.is-checked {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  background: var(--ui-primary-soft);
}

.tea-fruit :deep(.n-checkbox) {
  width: 100%;
  align-items: center;
}

.tea-fruit__label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 13px;
}

.tea-fruit__label b {
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.tea-lines {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tea-line {
  display: flex;
  align-items: center;
  gap: 10px 12px;
  padding: 10px 2px;
  font-size: 13px;
}

.tea-line + .tea-line {
  border-top: 1px solid var(--ui-border);
}

.tea-line__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.tea-line__main--stack {
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
}

.tea-line__main strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: var(--fw-600);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tea-line__value {
  color: var(--ui-muted);
  white-space: nowrap;
}

.tea-line__value b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.tea-time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-variant-numeric: tabular-nums;
}

.tea-time b {
  font-weight: var(--fw-600);
}

.tea-time time {
  color: var(--ui-subtle);
  font-size: 11px;
}

.tea-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 4px;
}

.tea-stats div {
  padding: 12px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
  text-align: center;
}

.tea-stats dt {
  color: var(--ui-muted);
  font-size: 12px;
}

.tea-stats dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
  font-size: 18px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.tea-rank {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tea-rank.is-top {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

/* 宽屏主页面：店铺左右分栏，收银台吸顶，领取与制作始终在视线内 */
@container tea-content (min-width: 1080px) {
  .tea-shop {
    grid-template-areas:
      'overview ops'
      'staff ops'
      'shelf ops';
    grid-template-columns: minmax(0, 1fr) 380px;
    grid-template-rows: auto auto 1fr;
    gap: 16px 20px;
  }

  .tea-shop__ops {
    position: sticky;
    top: 0;
  }
}

/* 宽弹窗：列表一项一行，固定列对齐 */
@container tea-dialog (min-width: 760px) {
  .tea-row--level,
  .tea-row--fund {
    display: grid;
    align-items: center;
    gap: 16px;
  }

  .tea-row--level {
    grid-template-columns: 120px minmax(0, 1fr) auto;
  }

  .tea-row--fund {
    grid-template-columns: 140px minmax(0, 1fr);
  }

  .tea-row--level .tea-row__head,
  .tea-row--fund .tea-row__head {
    flex-direction: column;
    align-items: flex-start;
  }

  .tea-row--level .tea-row__rewards {
    flex-wrap: nowrap;
    justify-content: flex-end;
  }

  .tea-row--recipe {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    gap: 16px;
  }
}

@media (max-width: 720px) {
  .tea-open {
    grid-template-columns: minmax(0, 1fr);
    padding: 18px;
  }
}

@media (max-width: 520px) {
  .tea-content--page {
    padding: 12px 0 28px;
    gap: 14px;
  }

  .tea-shelf {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }

  .tea-cup {
    grid-template-columns: 44px minmax(0, 1fr) auto;
    padding: 10px 12px;
  }

  .tea-shop .tea-cup__well {
    width: 44px;
    height: 44px;
  }

  .tea-cashier {
    padding: 16px;
  }

  .tea-goods {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .tea-goods-card.is-set {
    grid-column: 1 / -1;
  }

  .tea-recipe {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .tea-recipe .tea-cup__well {
    width: 48px;
    height: 48px;
  }

  .tea-recipe > .tea-tag {
    grid-column: 2;
    justify-self: start;
  }

  .tea-rules {
    padding: 14px 16px;
  }

  .tea-stats dd {
    font-size: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tea-section__chevron,
  .tea-meter__track span {
    transition: none;
  }
}
</style>
