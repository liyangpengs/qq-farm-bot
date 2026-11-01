<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
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
const selectedFruitUids = ref<string[]>([])
const candidates = computed<any[]>(() => [...(state?.hire?.friends || []), ...(state?.hire?.robots || [])])
const levelConfig = computed(() => state?.levels.find((v: any) => v.level === Number(state.summary.level)))
const freeSlot = computed(() => Array.from({ length: Number(levelConfig.value?.employee_slot_count || 0) }, (_, index) => index)
  .find(index => !(state?.shop?.slots || []).some((slot: any) => Number(slot.slot_index || 0) === index && Number(slot.end_at) > now.value)))
const canWork = computed(() => state?.active && !state?.settling)
// 店铺、兑换、工作三个页签是主页面，其余页面都在弹窗里显示，弹窗自带标题
const inDialog = computed(() => !['shop', 'exchange', 'work'].includes(page))
const inListDialog = computed(() => Number(state?.summary.shop_open_at) > 0 && ['upgrade', 'workshop', 'hireList', 'fund', 'logs', 'rank', 'workItems'].includes(page))
const nextLevel = computed(() => state?.levels.find((v: any) => v.level === Number(state.summary.level) + 1))
const revenuePercent = computed(() => {
  const next = Number(state?.shop?.next_level_revenue || 0)
  return next ? Math.min(100, Number(state.summary.total_revenue) / next * 100) : 100
})
const pendingCups = computed(() => Object.entries(state?.shop?.pending_cups_by_recipe || {})
  .map(([id, cups]) => ({ id, cups: Number(cups), name: state.recipes?.find((v: any) => String(v.recipe_id) === id)?.recipe_name || `奶茶 #${id}` }))
  .filter(entry => entry.cups > 0))
const cashierText = computed(() => {
  const minutes = Math.floor(Number(state?.shop?.cashier_elapsed_sec || 0) / 60)
  const hours = Math.floor(minutes / 60)
  return `累计收益 ${hours ? `${hours}小时` : ''}${minutes % 60}分（上限${Number(state?.shop?.cashier_capacity_sec || 0) / 3600}小时）`
})
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
function fruitsOf(recipe: any) {
  return (state?.fruits || []).filter((v: any) => v.id === recipe.fruitId)
}
function recipeStock(recipe: any) {
  if (!recipe.unlocked)
    return ''
  return recipe.is_advanced ? `${state.shop.drink_cups?.[recipe.recipe_id] || 0}` : '不限量'
}
function switchPage(value: string) {
  emit('navigate', value)
}
function select(action: string, title: string, input: any = {}, costs?: any[], rewards?: any[], max?: number) {
  emit('confirmation', { action, title, input, costs, rewards, quantity: max !== undefined, max })
}
function request(action = '', input: any = {}) {
  if (action)
    emit('operation', action, input)
  else emit('reload', { durationId: durationId.value, pageNumber: rankPage.value, day: logDate.value ? Math.floor(new Date(`${logDate.value}T00:00:00+08:00`).getTime() / 1000) : 0 })
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
  const target = list?.querySelector<HTMLElement>('.sheet--next')
  if (list && target && target.offsetTop + target.offsetHeight > list.clientHeight)
    list.scrollTop = target.offsetTop - 8
})
</script>

<template>
  <div class="tea-content" :class="{ 'tea-content--dialog': inDialog, 'tea-content--list': inListDialog }">
    <section v-if="!Number(state.summary.shop_open_at)" class="paper">
      <h2 class="divider">
        开始营业
      </h2>
      <label class="field">店名 <input v-model="name" maxlength="8"></label>
      <div class="actions">
        <button v-for="suggestion in state.recommendedNames" :key="suggestion" class="chip-btn" :class="{ selected: name === suggestion }" @click="name = suggestion">
          {{ suggestion }}
        </button>
      </div>
      <div class="actions actions--center">
        <button class="primary big" :disabled="busy || !canWork" @click="select('create', '开始营业', { name })">
          开始营业
        </button>
      </div>
    </section>

    <div v-else-if="page === 'shop' && state.shop" class="shop-layout">
      <div class="shop-main">
        <section class="signboard">
          <div class="signboard__level">
            <b>{{ state.summary.level }}</b><small>店铺等级</small>
          </div>
          <div class="signboard__main">
            <h2>{{ state.summary.shop_name }}</h2>
            <span>营业额：<img :src="itemImage(1041)" alt="">{{ Number(state.summary.total_revenue).toLocaleString() }}</span>
          </div>
          <button class="signboard__upgrade" :disabled="busy" @click="switchPage('upgrade')">
            <span class="i-carbon-store" />店铺升级
            <i v-if="state.summary.can_upgrade" class="signboard__badge">可升级</i>
          </button>
        </section>
        <div class="revenue">
          <div class="revenue__track" role="progressbar" :aria-valuenow="Number(state.summary.total_revenue)" aria-valuemin="0" :aria-valuemax="Number(state.shop.next_level_revenue) || Number(state.summary.total_revenue)" aria-label="升级所需营业额">
            <span :style="{ width: `${revenuePercent}%` }" />
          </div>
          <small>{{ state.shop.next_level_revenue ? `升级还需营业额 ${Number(state.summary.total_revenue).toLocaleString()} / ${Number(state.shop.next_level_revenue).toLocaleString()}` : '店铺已满级' }}</small>
        </div>

        <section class="shelf">
          <div class="shelf__row">
            <article v-for="recipe in state.recipes" :key="recipe.recipe_id" class="cup" :class="{ 'cup--locked': !recipe.unlocked }" :title="recipe.description">
              <img :src="recipe.image" alt="" width="56" height="56">
              <strong>{{ recipe.recipe_name }}</strong>
              <small>奶茶券 {{ recipe.token_price || 0 }}<template v-if="Number(recipe.coin_price)"> · 金币 {{ Number(recipe.coin_price).toLocaleString() }}</template></small>
              <span class="cup__stock">
                <template v-if="recipe.unlocked">{{ recipeStock(recipe) }}</template>
                <span v-else class="i-carbon-locked" aria-label="未解锁" />
              </span>
            </article>
          </div>
          <p class="shelf__ribbon">
            正在热卖：每小时{{ state.shop.effective_cups_per_hour }}杯
          </p>
        </section>

        <nav class="quick" aria-label="店铺功能">
          <button :disabled="busy" @click="switchPage('settings')">
            <span class="quick__icon"><span class="i-carbon-settings" /></span>店铺设置
          </button>
          <button :disabled="busy" @click="switchPage('hireList')">
            <span class="quick__icon"><span class="i-carbon-user-follow" /></span>好友雇佣
          </button>
          <button :disabled="busy" @click="switchPage('fund')">
            <span class="quick__icon"><span class="i-carbon-piggy-bank" /></span>成长基金
          </button>
          <button :disabled="busy" @click="switchPage('logs')">
            <span class="quick__icon"><span class="i-carbon-catalog" /></span>营业记录
          </button>
          <button :disabled="busy" @click="switchPage('rank')">
            <span class="quick__icon"><span class="i-carbon-chart-bar" /></span>排行榜
          </button>
        </nav>
      </div>

      <aside class="shop-side">
        <section class="receipt">
          <h2 class="receipt__title">
            累计收益
          </h2>
          <div class="receipt__body">
            <p class="dark-bar">
              {{ cashierText }}
            </p>
            <div v-for="entry in pendingCups" :key="entry.id" class="receipt__line">
              <span>{{ entry.name }}</span><span>{{ entry.cups }}杯</span>
            </div>
            <p v-if="!pendingCups.length" class="hint">
              收银台暂时没有新收益
            </p>
            <h3 class="divider">
              合计收益
            </h3>
            <div class="item-row">
              <div v-for="reward in state.shop.pending_rewards" :key="reward.id" class="item">
                <span class="item__name">{{ reward.name }}</span>
                <span class="item-box"><CommerceItemImage :src="reward.image" :alt="reward.name" /><b>{{ reward.count }}</b></span>
              </div>
            </div>
            <div class="actions actions--center">
              <button class="green" :disabled="busy || !canWork || !(state.balances[state.shop.sales_item_id] > 0)" @click="select('boost', '一键爆单', {}, [{ id: Number(state.shop.sales_item_id), name: '宣传喇叭', count: 1 }], [], Math.min(9999, state.balances[state.shop.sales_item_id]))">
                <img :src="itemImage(state.shop.sales_item_id)" alt="">一键爆单
              </button>
              <button class="primary" :disabled="busy || !state.shop.pending_rewards.some((v: any) => v.count > 0)" @click="request('claim')">
                领取收益
              </button>
            </div>
          </div>
        </section>

        <div class="make">
          <button class="make__btn" :disabled="busy" @click="switchPage('workshop')">
            <span class="i-carbon-cafe" />制作奶茶
          </button>
        </div>
      </aside>
    </div>

    <section v-else-if="page === 'settings'" class="paper">
      <h2>店铺设置</h2>
      <h3 class="divider">
        店铺改名
      </h3>
      <div class="actions">
        <input v-model="name" class="grow" maxlength="8" aria-label="店铺改名"><button class="primary" :disabled="busy || !canWork || name === state.summary.shop_name || Number(state.summary.rename_cd_until_at) > state.serverTime" @click="select('rename', '店铺改名', { name })">
          确认改名
        </button>
      </div>
      <small v-if="Number(state.summary.rename_cd_until_at) > state.serverTime">下次可改名：{{ date(state.summary.rename_cd_until_at) }}</small>
      <h3 class="divider">
        我的打工设置
      </h3>
      <div class="row toggle">
        <span id="milk-hire-mode-label" class="toggle__label">躺平模式 · 开启后，好友无法雇佣你</span>
        <button class="toggle__switch" type="button" role="switch" aria-labelledby="milk-hire-mode-label" :aria-checked="hireDisabled" :disabled="busy" @click="hireDisabled = !hireDisabled" />
      </div>
      <div class="actions actions--center">
        <button class="primary" :disabled="busy || !state.active || hireDisabled === !!state.summary.hire_disabled" @click="request('hireSetting', { disabled: hireDisabled })">
          保存设置
        </button>
      </div>
    </section>

    <section v-else-if="page === 'upgrade' && state.shop" class="paper paper--list">
      <div class="section-head">
        <h2>店铺升级</h2>
        <div class="upgrade-progress">
          <div class="upgrade-progress__text">
            <strong>营业额</strong><b class="big-num">{{ Number(state.summary.total_revenue).toLocaleString() }}<small> / {{ state.shop.next_level_revenue ? Number(state.shop.next_level_revenue).toLocaleString() : '—' }}</small></b>
          </div>
          <div class="revenue__track">
            <span :style="{ width: `${revenuePercent}%` }" />
          </div>
        </div>
        <b class="tag">当前 {{ state.summary.level }} 级</b>
      </div>
      <div ref="listElement" class="panel-list" role="region" aria-label="店铺等级" tabindex="0">
        <article v-for="level in state.levels" :key="level.level" class="sheet row-sheet row-sheet--level" :class="{ 'sheet--next': level.level === Number(state.summary.level) + 1, 'sheet--done': level.level <= Number(state.summary.level) }">
          <div class="row-sheet__head">
            <h3>{{ level.level }}级</h3><span class="muted">营业额 {{ level.revenue_required.toLocaleString() }}</span>
          </div>
          <div class="row-sheet__body">
            <div class="metrics">
              <span>热卖值 <b>{{ level.base_popularity }}杯/小时</b></span><span>高级奶茶售价 <b>+{{ level.advanced_price_percent / 100 }}%</b></span><span>员工 <b>{{ level.employee_slot_count }}</b></span>
            </div>
            <div class="tags">
              <span v-for="recipe in level.recipes" :key="recipe">{{ recipe }}</span>
            </div>
          </div>
          <div v-if="level.rewards.length" class="item-row row-sheet__rewards">
            <div v-for="reward in level.rewards" :key="reward.id" class="item" :title="`${reward.name} ×${reward.count}`">
              <span class="item-box item-box--sm"><CommerceItemImage :src="reward.image" :alt="reward.name" /><b>{{ reward.count }}</b></span>
              <span class="item__name">{{ reward.name }}</span>
            </div>
          </div>
        </article>
      </div>
      <div v-if="nextLevel" class="actions actions--center panel-footer">
        <button class="primary big" :disabled="busy || !state.active || !state.summary.can_upgrade" @click="select('upgrade', '店铺升级', { expectedLevel: Number(state.summary.level) }, [], nextLevel.rewards)">
          立即升级
        </button>
      </div>
    </section>

    <section v-else-if="page === 'workshop'" class="paper paper--list">
      <div class="section-head">
        <h2>奶茶工坊</h2>
        <p class="hint hint--left hint--inline">
          勾选果实后点击确认制作，会消耗所选的整组果实。
        </p>
        <button class="primary" :disabled="busy || !canWork || !craftableFruits.length" @click="craft(true)">
          一键制作
        </button>
        <button class="primary" :disabled="busy || !canWork || !selectedFruitUids.length" @click="craft(false)">
          {{ selectedFruitUids.length ? `确认制作（${selectedFruitUids.length}）` : '确认制作' }}
        </button>
      </div>
      <div class="panel-list" role="region" aria-label="奶茶配方" tabindex="0">
        <article v-for="recipe in state.recipes" :key="recipe.recipe_id" class="sheet row-sheet row-sheet--recipe" :class="{ 'sheet--done': !recipe.unlocked }">
          <div class="recipe-line">
            <img :src="recipe.image" alt="" width="52" height="52"><div><strong>{{ recipe.recipe_name }}</strong><small>{{ recipe.description }}</small></div><span class="tag">{{ recipe.unlocked ? `库存 ${recipe.stock_cups === '-1' ? '不限量' : recipe.stock_cups || 0}` : '未解锁' }}</span>
          </div>
          <div v-if="fruitsOf(recipe).length" class="row-sheet__fruits">
            <label v-for="fruit in fruitsOf(recipe)" :key="fruit.uid" class="fruit"><input v-model="selectedFruitUids" type="checkbox" :value="fruit.uid" :disabled="busy || fruit.locked || !canWork"><CommerceItemImage :src="fruit.image" :alt="fruit.name" size="sm" /><span>{{ fruit.name }} ×{{ fruit.count }}</span><span v-if="fruit.locked" class="tag">已锁定</span><span v-if="fruit.mutations.length" class="muted">变异 {{ fruit.mutations.join('、') }}</span></label>
          </div>
        </article>
      </div>
    </section>

    <section v-else-if="page === 'hireList' && state.hire" class="paper paper--list">
      <h2>好友雇佣</h2>
      <div class="actions">
        <label class="field">雇佣时长 <select v-model="durationId" :disabled="busy" @change="request()"><option v-for="duration in state.durations" :key="duration.duration_id" :value="duration.duration_id">{{ duration.duration_sec / 3600 }}小时</option></select></label><span class="wallet__chip"><img :src="itemImage(1041)" alt="奶茶券"><b>{{ state.hire.wage_total }}</b></span>
      </div>
      <div class="panel-list" role="region" aria-label="员工列表" tabindex="0">
        <h3 class="divider">
          在岗员工
        </h3>
        <div v-for="slot in state.shop.slots" :key="slot.slot_index" class="row">
          <strong>{{ slot.employee?.name }}</strong><span class="tag">{{ slot.talent_name }}</span><div class="employee-time">
            <time class="muted">{{ date(slot.end_at) }}</time><strong>{{ remaining(slot.end_at) }}</strong>
          </div>
        </div>
        <h3 class="divider">
          可雇佣
        </h3>
        <div v-for="candidate in candidates" :key="candidate.friend.gid" class="row">
          <div><strong>{{ candidate.friend.name }}</strong><small>{{ candidate.talent_name }}</small></div><div v-if="Number(candidate.state_until_at) > 0" class="employee-time">
            <time class="muted">{{ date(candidate.state_until_at) }}</time><strong>{{ remaining(candidate.state_until_at) }}</strong>
          </div><button class="primary" :disabled="busy || !canWork || Number(candidate.state || 0) !== 0 || Number(candidate.rehire_available_at || 0) > now || freeSlot === undefined" @click="hire(candidate)">
            雇佣
          </button>
        </div>
      </div>
    </section>

    <section v-else-if="page === 'exchange'" class="paper">
      <h2 class="divider">
        兑换商店
      </h2>
      <div class="goods">
        <article v-for="goods in state.goods" :key="goods.id" class="goods-card" :class="{ 'goods-card--off': !goods.available, 'goods-card--set': goods.rewards.length > 1 }">
          <strong>{{ goods.name || goods.rewards[0]?.name }}</strong>
          <div class="item-row" :class="{ 'item-row--set': goods.rewards.length > 1 }">
            <span v-for="reward in goods.rewards" :key="reward.id" class="item-box" :title="reward.name"><CommerceItemImage :src="reward.image" :alt="reward.name" /><b>{{ reward.count }}</b></span>
          </div>
          <small v-if="goods.remaining !== null">剩余 {{ goods.remaining }}</small>
          <small v-for="condition in goods.conditions" :key="condition.type">需店铺等级 {{ condition.target }}（当前 {{ condition.current }}）</small>
          <button class="primary price" :disabled="busy || !state.active || !goods.available" @click="select('exchange', goods.name || goods.rewards[0]?.name, { goodsId: goods.id }, goods.costs, goods.rewards, Math.min(9999, goods.remaining ?? 9999))">
            <template v-if="goods.remaining === 0">
              已售罄
            </template>
            <template v-else>
              <span v-for="cost in goods.costs" :key="cost.id" class="price__cost"><img :src="cost.image" :alt="cost.name">{{ Number(cost.count).toLocaleString() }}</span>
            </template>
          </button>
        </article>
      </div>
    </section>

    <section v-else-if="page === 'fund'" class="paper paper--list">
      <div class="section-head">
        <h2>成长基金</h2><button v-if="!state.fund.unlocked" class="primary" :disabled="busy || !state.active" @click="select('unlock', '解锁成长基金', {}, state.fund.costs)">
          {{ rewardsText(state.fund.costs) }} 解锁
        </button><button v-else class="primary" :disabled="busy || !state.active || !state.fund.tiers.some((v: any) => v.state === 2)" @click="request('fundClaim')">
          领取
        </button>
      </div>
      <div ref="listElement" class="panel-list" role="region" aria-label="成长基金奖励" tabindex="0">
        <article v-for="tier in state.fund.tiers" :key="tier.id" class="sheet row-sheet row-sheet--fund" :class="{ 'sheet--next': state.fund.unlocked && tier.state === 2, 'sheet--done': tier.state === 3 }">
          <div class="row-sheet__head">
            <strong v-for="condition in tier.conditions" :key="condition.type">店铺等级 {{ condition.target }}</strong><span class="tag">{{ tier.state === 3 ? '已领取' : !state.fund.unlocked ? '未解锁' : tier.state === 2 ? '可领取' : '未达成' }}</span>
          </div>
          <div class="item-row row-sheet__rewards">
            <div v-for="reward in tier.rewards" :key="reward.id" class="item" :title="`${reward.name} ×${reward.count}`">
              <span class="item-box item-box--sm"><CommerceItemImage :src="reward.image" :alt="reward.name" /><b>{{ reward.count }}</b></span>
              <span class="item__name">{{ reward.name }}</span>
            </div>
          </div>
        </article>
      </div>
    </section>

    <MilkTeaWork v-else-if="['work', 'workItems'].includes(page) && state.work" :state="state" :busy="busy" :selection-only="page === 'workItems'" @navigate="switchPage" @operation="request" @confirmation="emit('confirmation', $event)" />

    <section v-else-if="page === 'logs' && state.logs" class="paper paper--list">
      <div class="section-head">
        <h2>营业记录</h2><input v-model="logDate" type="date" :disabled="busy" aria-label="选择日期" @change="request()">
      </div>
      <div class="panel-list" role="region" aria-label="雇佣记录" tabindex="0">
        <div class="metrics metrics--boxes">
          <span>奶茶券 <b>{{ state.logs.token || 0 }}</b></span><span>金币 <b>{{ state.logs.coin || 0 }}</b></span><span>奶茶 <b>{{ state.logs.cups || 0 }}杯</b></span>
        </div>
        <h3 class="divider">
          雇佣记录
        </h3>
        <div v-for="hireRecord in state.logs.hires" :key="hireRecord.shift_id" class="row">
          <div><strong>{{ hireRecord.friend?.name }}</strong><small>{{ date(hireRecord.hire_at) }}</small></div><span class="tag">{{ hireRecord.talent_name }}</span><span>工资 {{ hireRecord.wages?.final_wage || 0 }}</span>
        </div>
        <p v-if="!state.logs.hires?.length" class="hint">
          当天没有雇佣记录
        </p>
      </div>
    </section>

    <section v-else-if="page === 'rank' && state.rank" class="paper paper--list">
      <h2>排行榜</h2>
      <div class="panel-list" role="region" aria-label="排行榜" tabindex="0">
        <div v-for="entry in state.rank.ranks" :key="entry.owner?.gid" class="row rank-row">
          <b class="rank-no" :class="{ 'rank-no--top': Number(entry.rank) <= 3 }">{{ entry.rank }}</b><div><strong>{{ entry.shop_name }}</strong><small>{{ entry.owner?.name }}</small></div><span>营业额 <b>{{ Number(entry.total_revenue).toLocaleString() }}</b></span>
        </div>
      </div>
      <div class="actions actions--center panel-footer">
        <button :disabled="busy || rankPage <= 1" @click="rankPage--; request()">
          上一页
        </button><span class="tag">第 {{ rankPage }} 页</span><button :disabled="busy || !state.rank.has_more" @click="rankPage++; request()">
          下一页
        </button>
      </div>
    </section>

    <details v-if="['shop', 'exchange', 'work'].includes(page) && state.rules.length" class="paper rules">
      <summary>活动说明</summary>
      <p v-for="(line, index) in state.rules" :key="index" class="official-rule" :class="{ 'official-rule--title': /^【.+】$/.test(line.trim()) }">
        {{ line.trim().replace(/^【(.+)】$/, '$1') }}
      </p>
    </details>
  </div>
</template>

<style scoped>
.tea-content {
  --wood: #9a6438;
  --wood-dark: #5e3a1f;
  --paper: #fbf3e2;
  --paper-hi: #fffaf0;
  --edge: #e6cfa6;
  --ink: #4b301b;
  --muted: #7d5c40;
  --slate: #46403b;
  max-width: 720px;
  margin: 0 auto;
  padding: 18px 18px 40px;
  display: grid;
  gap: 18px;
  color: var(--ink);
}
.tea-content--dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: none;
  min-height: 0;
  overflow: auto;
  padding: 16px 22px 24px;
}
.tea-content--list {
  overflow: hidden;
}
.paper--list {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.paper--list > :not(.panel-list) {
  flex-shrink: 0;
}
.panel-list {
  position: relative;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(94, 58, 31, 0.3) transparent;
  padding: 4px 4px 6px;
}
.panel-list:focus-visible {
  outline: 2px solid #f0a33a;
  outline-offset: -2px;
}
.panel-footer {
  padding-top: 4px;
}
h2,
h3,
p {
  margin: 0;
  letter-spacing: 0;
}
h2 {
  font-size: 18px;
  font-weight: var(--fw-900);
}
h3 {
  font-size: 15px;
  font-weight: var(--fw-800);
}
small {
  display: block;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.muted {
  color: var(--muted);
  font-size: 13px;
}
.hint {
  padding: 10px 0;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.hint--left {
  padding-top: 0;
  text-align: left;
}
.hint--inline {
  min-width: 0;
  flex: 1;
  padding: 0;
}

/* 按钮与输入 */
button,
input,
select {
  font: inherit;
}
button {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 16px;
  border: 2px solid var(--wood-dark);
  border-radius: 12px;
  color: var(--ink);
  background: linear-gradient(180deg, var(--paper-hi), #f1e1c2);
  box-shadow:
    inset 0 -3px 0 rgba(160, 110, 60, 0.18),
    0 3px 0 var(--wood-dark);
  font-weight: var(--fw-800);
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.08s ease;
}
button img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}
button.primary {
  color: #5a3214;
  background: linear-gradient(180deg, #ffe58e, #ffc847);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.6),
    inset 0 -3px 0 rgba(214, 128, 26, 0.4),
    0 3px 0 var(--wood-dark);
}
button.green {
  color: #44400e;
  background: linear-gradient(180deg, #e6ee98, #c6d65d);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.6),
    inset 0 -3px 0 rgba(120, 140, 30, 0.35),
    0 3px 0 var(--wood-dark);
}
button.big {
  min-width: min(260px, 100%);
  min-height: 48px;
  font-size: 17px;
}
button:active:not(:disabled) {
  box-shadow: 0 1px 0 var(--wood-dark);
  transform: translateY(2px);
}
button:disabled {
  border-color: #8a8178;
  color: #776e64;
  background: linear-gradient(180deg, #ded8ce, #c4bcb1);
  box-shadow: 0 3px 0 #8a8178;
  cursor: not-allowed;
}
button:disabled img {
  filter: grayscale(1);
  opacity: 0.6;
}
button:focus-visible,
summary:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 3px solid #f0a33a;
  outline-offset: 2px;
}
.chip-btn {
  min-height: 32px;
  padding: 0 12px;
  border-width: 1.5px;
  border-color: #c9a97c;
  font-size: 13px;
  box-shadow: none;
}
.chip-btn.selected {
  border-color: var(--wood-dark);
  background: linear-gradient(180deg, #ffe58e, #ffc847);
}
input:not([type='checkbox']),
select {
  min-height: 38px;
  max-width: 100%;
  padding: 6px 10px;
  border: 2px solid #c9a97c;
  border-radius: 10px;
  color: var(--ink);
  background: var(--paper-hi);
}
input[type='checkbox'] {
  width: 18px;
  height: 18px;
  accent-color: #e8892a;
}
.grow {
  flex: 1;
  min-width: 0;
}
.field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: var(--fw-700);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 14px 0 4px;
}
.actions--center {
  justify-content: center;
}

/* 余额 */
.wallet__chip {
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
.wallet__chip img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}

/* 纸面卡片 */
.paper {
  padding: 20px 22px 22px;
  border: 4px solid var(--wood);
  border-radius: 20px;
  background: var(--paper);
  box-shadow:
    inset 0 0 0 3px #f3ddb0,
    0 5px 0 var(--wood-dark),
    0 14px 22px -12px rgba(70, 40, 15, 0.4);
}
.tea-content--dialog .paper {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.tea-content--dialog .paper > h2:first-child,
.tea-content--dialog .paper > .section-head:first-child > h2 {
  display: none;
}
.tea-content--dialog .paper > .section-head:first-child {
  justify-content: flex-end;
}
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 10px;
  font-size: 15px;
  font-weight: var(--fw-900);
  text-align: center;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-top: 2px dashed rgba(94, 58, 31, 0.4);
}
.paper > .divider:first-child {
  margin-top: 0;
}
.section-head,
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 12px;
}
.section-head {
  margin-bottom: 12px;
}
.row {
  padding: 12px 2px;
  border-bottom: 1.5px dashed rgba(94, 58, 31, 0.2);
  font-size: 14px;
}
.row:last-of-type {
  border-bottom: 0;
}
.row--plain {
  border: 0;
  padding-bottom: 6px;
}
.toggle {
  flex-wrap: nowrap;
  gap: 8px;
}
.toggle__label {
  min-width: 0;
  color: var(--ink);
  font-size: 14px;
  white-space: nowrap;
}
.toggle__switch {
  position: relative;
  width: 42px;
  height: 26px;
  min-height: 0;
  flex: none;
  padding: 0;
  border: 2px solid var(--wood);
  border-radius: 999px;
  background: #ddcbae;
  box-shadow: inset 0 1px 3px rgba(94, 58, 31, 0.15);
}
.toggle__switch::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--paper-hi);
  box-shadow: 0 1px 2px rgba(94, 58, 31, 0.3);
  transition: transform 0.15s ease;
}
.toggle__switch[aria-checked='true'] {
  background: #e8a13b;
}
.toggle__switch[aria-checked='true']::before {
  transform: translateX(16px);
}
.toggle__switch:active:not(:disabled) {
  transform: none;
}
.toggle__switch:disabled {
  opacity: 0.6;
}
.tag {
  padding: 2px 10px;
  border-radius: 999px;
  color: #fff3dc;
  background: rgba(58, 38, 24, 0.75);
  font-size: 12px;
  font-weight: var(--fw-700);
  white-space: nowrap;
}
.employee-time {
  display: grid;
  gap: 4px;
  min-width: 0;
  margin-left: auto;
  text-align: right;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.tags span {
  padding: 2px 10px;
  border: 1.5px solid var(--edge);
  border-radius: 999px;
  background: var(--paper-hi);
  font-size: 12px;
}
.upgrade-progress {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 6px;
}
.upgrade-progress__text {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
}
.big-num {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.big-num small {
  display: inline;
  font-size: 14px;
}
.sheet {
  margin-top: 12px;
  padding: 14px 16px;
  border: 2px solid var(--edge);
  border-radius: 14px;
  background: var(--paper-hi);
}
.sheet--next {
  border-color: #e0891f;
  box-shadow: 0 0 0 3px rgba(255, 190, 70, 0.35);
}
.sheet--done {
  opacity: 0.6;
}
.sheet .section-head {
  margin-bottom: 6px;
}
.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  font-size: 13px;
  color: var(--muted);
}
.metrics b {
  margin-left: 4px;
  color: var(--ink);
  font-size: 14px;
}
.metrics--boxes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 112px), 1fr));
  gap: 10px;
}
.metrics--boxes span {
  padding: 10px;
  border: 2px solid var(--edge);
  border-radius: 12px;
  background: var(--paper-hi);
  text-align: center;
}
.metrics--boxes b {
  display: block;
  margin: 4px 0 0;
  font-size: 20px;
  overflow-wrap: anywhere;
}

/* 道具格 */
.item-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px 16px;
}
.item {
  min-width: 84px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
/* 名称统一单行，格子宽度随名称自适应，避免“有机化肥(1小时)”这类名称折行后高低不齐 */
.item__name {
  font-size: 12px;
  font-weight: var(--fw-700);
  line-height: 1.35;
  text-align: center;
  white-space: nowrap;
}
.item-box {
  position: relative;
  width: 76px;
  height: 76px;
  display: grid;
  flex: none;
  place-items: center;
  border: 3px solid #8d7c6c;
  border-radius: 14px;
  background: linear-gradient(180deg, var(--paper-hi), #f1e3c5);
  box-shadow: inset 0 0 0 2px #fffaf0;
}
.item-box :deep(.item-image) {
  width: 82%;
  height: 82%;
  border: 0;
  background: transparent;
}
.item-box b {
  position: absolute;
  right: 5px;
  bottom: 1px;
  color: #fff;
  font-size: 13px;
  font-weight: var(--fw-900);
  font-variant-numeric: tabular-nums;
  text-shadow:
    1.5px 0 0 var(--wood-dark),
    -1.5px 0 0 var(--wood-dark),
    0 1.5px 0 var(--wood-dark),
    0 -1.5px 0 var(--wood-dark);
}
.item-box--sm {
  width: 60px;
  height: 60px;
  border-width: 2.5px;
  border-radius: 12px;
}
.item-box--sm b {
  font-size: 12px;
}

/* 店铺 / 工作页布局：窄屏单列，宽屏见文件末尾的容器查询 */
.shop-layout,
.shop-main,
.shop-side {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 18px;
}

/* 招牌 */
.signboard {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border: 4px solid #b47d4c;
  border-radius: 20px;
  color: #fff6e6;
  background: linear-gradient(180deg, #514a44, var(--slate));
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.08),
    0 5px 0 var(--wood-dark),
    0 14px 22px -12px rgba(40, 25, 10, 0.5);
}
.signboard__level {
  width: 70px;
  height: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 3px solid rgba(255, 255, 255, 0.85);
  border-bottom-color: transparent;
  border-radius: 50% 50% 12px 12px;
}
.signboard__level b {
  font-size: 26px;
  line-height: 1;
}
.signboard__level small {
  margin-top: 2px;
  color: #f1e4cf;
  font-size: 11px;
  font-weight: var(--fw-700);
}
.signboard__main {
  min-width: 0;
  text-align: center;
}
.signboard__main h2 {
  overflow: hidden;
  font-size: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.signboard__main span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  color: #f1e4cf;
  font-size: 13px;
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.signboard__main img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}
.signboard__upgrade {
  min-height: 64px;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px;
  border-color: #3a2a1d;
  color: #fff6e6;
  background: linear-gradient(180deg, #b77a4b, #91572d);
  box-shadow:
    inset 0 2px 0 rgba(255, 220, 170, 0.35),
    0 3px 0 #2c1f15;
  font-size: 12px;
}
.signboard__upgrade {
  position: relative;
}
.signboard__upgrade span {
  font-size: 22px;
}
.signboard__badge {
  position: absolute;
  top: -10px;
  right: -10px;
  padding: 1px 7px;
  border-radius: 999px;
  color: #fff;
  background: #e04b3c;
  box-shadow: 0 0 0 2px #fff6e6;
  font-size: 11px;
  font-style: normal;
  font-weight: var(--fw-900);
  white-space: nowrap;
}
.revenue {
  margin-top: -6px;
  padding: 0 8px;
}
.revenue__track {
  height: 14px;
  overflow: hidden;
  border: 2.5px solid var(--wood-dark);
  border-radius: 999px;
  background: #e8d9bd;
}
.revenue__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(180deg, #ffd35c, #f59a2b);
}
.revenue small {
  margin-top: 4px;
  font-weight: var(--fw-700);
  text-align: center;
}

/* 奶茶货架 */
.shelf {
  padding: 12px 12px 0;
  border: 4px solid var(--wood);
  border-radius: 18px;
  background: linear-gradient(180deg, #f4e2c2, #ead2a8);
  box-shadow: 0 5px 0 var(--wood-dark);
}
.shelf__row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 10px;
}
.cup {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 6px 30px;
  overflow: hidden;
  border: 2px solid #d7bb8c;
  border-radius: 14px;
  background: var(--paper-hi);
  text-align: center;
}
.cup img {
  object-fit: contain;
}
.cup strong {
  font-size: 13px;
}
.cup small {
  font-size: 11px;
  line-height: 1.35;
}
.cup__stock {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  place-items: center;
  padding: 3px 0;
  color: #fff6e6;
  background: rgba(94, 58, 31, 0.78);
  font-size: 12px;
  font-weight: var(--fw-800);
}
.cup--locked {
  background: #e9dcc4;
}
.cup--locked img {
  filter: grayscale(1);
  opacity: 0.4;
}
.shelf__ribbon {
  width: fit-content;
  margin: 12px auto 0;
  padding: 4px 22px;
  border-radius: 10px 10px 0 0;
  color: #fff3dc;
  background: var(--wood);
  font-size: 14px;
  font-weight: var(--fw-800);
}

/* 快捷入口 */
.quick {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}
.quick button {
  min-height: 0;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  border: 0;
  color: var(--ink);
  background: transparent;
  box-shadow: none;
  font-size: 13px;
}
.quick__icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border: 3px solid var(--wood);
  border-radius: 50%;
  color: var(--wood-dark);
  background: linear-gradient(180deg, #fff3d6, #f4d9a6);
  box-shadow: 0 3px 0 var(--wood-dark);
  font-size: 24px;
}
.quick button:disabled {
  background: transparent;
  box-shadow: none;
}
.quick button:active:not(:disabled) {
  box-shadow: none;
}

/* 收益小票 */
.receipt {
  overflow: hidden;
  border: 4px solid #8a5a35;
  border-radius: 20px;
  background: var(--paper);
  box-shadow:
    0 5px 0 var(--wood-dark),
    0 14px 22px -12px rgba(70, 40, 15, 0.4);
}
.receipt__title {
  padding: 10px;
  color: #fde3a4;
  background: linear-gradient(180deg, #9c6a43, #84552f);
  font-size: 20px;
  text-align: center;
  text-shadow: 0 2px 0 #4f3018;
}
.receipt__body {
  padding: 16px 22px 22px;
}
.dark-bar {
  width: fit-content;
  margin: 0 auto 8px;
  padding: 3px 16px;
  border-radius: 6px;
  color: #fff3dc;
  background: rgba(58, 38, 24, 0.78);
  font-size: 13px;
  font-weight: var(--fw-700);
}
.receipt__line {
  display: flex;
  justify-content: space-between;
  padding: 8px 6px;
  font-size: 15px;
}
.receipt .item-row {
  margin-top: 4px;
}
.receipt .actions {
  margin-top: 18px;
}
.receipt .actions button {
  min-width: 140px;
  min-height: 46px;
  font-size: 16px;
}

/* 制作奶茶 */
.make {
  display: flex;
  justify-content: center;
}
.make__btn {
  min-width: min(300px, 100%);
  min-height: 60px;
  gap: 8px;
  border: 4px solid #6b4a2e;
  border-radius: 16px;
  color: #4a2c12;
  background: linear-gradient(180deg, #ffe08a, #f7c149);
  box-shadow:
    inset 0 0 0 3px rgba(255, 255, 255, 0.4),
    0 5px 0 #4a3320;
  font-size: 24px;
  font-weight: var(--fw-900);
  letter-spacing: 0.06em;
}
.make__btn span {
  font-size: 26px;
}

/* 工坊 */
.recipe-line {
  display: flex;
  align-items: center;
  gap: 12px;
}
.recipe-line img {
  flex: none;
  object-fit: contain;
}
.recipe-line > div {
  min-width: 0;
  flex: 1;
}
.recipe-line strong {
  font-size: 15px;
}
.fruit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(230, 207, 166, 0.3);
  font-size: 13px;
  cursor: pointer;
}

/* 兑换 */
.goods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
}
.goods-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 10px 14px;
  border: 2px solid var(--edge);
  border-radius: 16px;
  background: var(--paper-hi);
  text-align: center;
}
.goods-card strong {
  font-size: 14px;
}
.goods-card small {
  margin-top: -4px;
}
/* 套装类商品：多件奖励用小格并排，避免把整行撑高 */
.item-row--set {
  max-width: 100%;
  gap: 6px;
}
.item-row--set .item-box {
  width: 46px;
  height: 46px;
  border-width: 2px;
  border-radius: 10px;
}
.item-row--set .item-box b {
  right: 3px;
  font-size: 11px;
}
.goods-card--off .item-box {
  filter: grayscale(0.6);
}
.price {
  width: 100%;
  margin-top: auto;
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
}
.price__cost {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

/* 排行 */
.rank-row > div {
  min-width: 0;
  flex: 1;
}
.rank-no {
  width: 32px;
  height: 32px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: var(--ink);
  background: #eadbc0;
}
.rank-no--top {
  color: #5a3214;
  background: linear-gradient(180deg, #ffe58e, #ffc847);
  box-shadow: 0 2px 0 var(--wood-dark);
}

/* 说明 */
.rules summary {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 15px;
  font-weight: var(--fw-900);
  list-style: none;
  cursor: pointer;
}
.rules summary::-webkit-details-marker {
  display: none;
}
.rules summary::before,
.rules summary::after {
  content: '';
  flex: 1;
  border-top: 2px dashed rgba(94, 58, 31, 0.4);
}
.rules[open] > summary {
  margin-bottom: 12px;
}
.official-rule {
  margin: 6px 0;
  font-size: 14px;
  line-height: 1.85;
  white-space: pre-line;
}
.official-rule--title {
  width: fit-content;
  margin: 14px auto 6px;
  padding: 2px 16px;
  border-radius: 6px;
  color: #fff3dc;
  background: rgba(58, 38, 24, 0.78);
  font-size: 13px;
  font-weight: var(--fw-700);
}

/* 弹窗列表：一项一行。窄屏上下堆叠，宽弹窗横向展开成固定列，各行对齐 */
.row-sheet__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 10px;
}
.row-sheet__head h3 {
  font-size: 16px;
}
.row-sheet__body {
  margin-top: 6px;
}
.row-sheet__rewards {
  justify-content: flex-start;
  margin-top: 12px;
  gap: 10px 8px;
}
/* 固定格宽，各行的道具格上下对齐；超长名称省略，悬停可看全名 */
.row-sheet__rewards .item {
  width: 92px;
  min-width: 0;
}
.row-sheet__rewards .item__name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-sheet__fruits {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}
.row-sheet__fruits .fruit {
  margin-top: 0;
}
@container (min-width: 700px) {
  .row-sheet--level,
  .row-sheet--fund,
  .row-sheet--recipe {
    display: grid;
    align-items: center;
    gap: 16px;
  }
  .row-sheet--level {
    grid-template-columns: 104px minmax(0, 1fr) 300px;
  }
  .row-sheet--fund {
    grid-template-columns: 112px minmax(0, 1fr);
  }
  .row-sheet--recipe {
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  }
  .row-sheet--level .row-sheet__head,
  .row-sheet--fund .row-sheet__head {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .row-sheet__body,
  .row-sheet__rewards,
  .row-sheet__fruits {
    margin-top: 0;
  }
  .row-sheet--level .row-sheet__rewards {
    flex-wrap: nowrap;
    justify-content: flex-end;
  }
}

/* PC 宽屏：内容放宽，店铺页左右分栏，收益和制作操作始终在视线内 */
@container (min-width: 960px) {
  .tea-content:not(.tea-content--dialog) {
    max-width: 1240px;
    padding: 18px 24px 40px;
    gap: 20px;
  }
  .shop-layout {
    grid-template-columns: minmax(0, 1fr) 360px;
    align-items: start;
    gap: 22px;
  }
  .shop-side .make__btn {
    width: 100%;
  }
  .goods {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  }
  @media (min-height: 760px) {
    .shop-side {
      position: sticky;
      top: 14px;
    }
  }
}

@media (max-width: 600px) {
  .tea-content {
    padding: 12px 10px 32px;
    gap: 14px;
  }
  .tea-content--dialog {
    padding: 12px 14px 20px;
  }
  .paper {
    padding: 16px 14px 18px;
    border-radius: 16px;
  }
  .signboard {
    gap: 10px;
    padding: 10px 12px;
  }
  .signboard__level {
    width: 56px;
    height: 52px;
  }
  .signboard__level b {
    font-size: 22px;
  }
  .signboard__main h2 {
    font-size: 17px;
  }
  .signboard__upgrade {
    min-height: 54px;
    padding: 4px 8px;
  }
  .signboard {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .signboard__level {
    grid-row: 1 / span 2;
  }
  .signboard__upgrade {
    min-height: 34px;
    flex-direction: row;
    grid-column: 2;
    justify-self: center;
  }
  .signboard__main span {
    flex-wrap: wrap;
    justify-content: center;
  }
  .recipe-line {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr);
    align-items: start;
    gap: 8px 12px;
  }
  .recipe-line > img {
    grid-row: 1 / span 2;
  }
  .recipe-line > .tag {
    grid-column: 2;
    justify-self: start;
  }
  .shelf__row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .quick__icon {
    width: 46px;
    height: 46px;
    font-size: 21px;
  }
  .quick button {
    font-size: 12px;
  }
  .receipt__body {
    padding: 14px 14px 18px;
  }
  .receipt .actions button {
    min-width: 0;
    flex: 1;
  }
  .make__btn {
    width: 100%;
  }
  .goods {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .goods-card--set {
    grid-column: 1 / -1;
  }
  .price {
    padding-inline: 4px;
    font-size: 12px;
  }
  .price img {
    width: 18px;
    height: 18px;
  }
  .item-box {
    width: 66px;
    height: 66px;
  }
  .metrics--boxes b {
    font-size: 17px;
  }
}
@media (max-width: 380px) {
  .toggle__switch {
    width: 36px;
  }
  .toggle__switch[aria-checked='true']::before {
    transform: translateX(10px);
  }
}
@media (max-width: 350px) {
  .toggle__label {
    font-size: 13px;
  }
}
@media (max-height: 560px) {
  .tea-content--dialog {
    gap: 8px;
    padding-block: 8px 12px;
  }
  .paper--list > .section-head {
    margin-bottom: 6px;
  }
  .panel-footer {
    margin-top: 8px;
  }
}
</style>
