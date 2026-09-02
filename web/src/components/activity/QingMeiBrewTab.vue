<script setup lang="ts">
import type { QingMeiActivityDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  activity: QingMeiActivityDto | null
  pendingSeed: boolean
  pendingStart: boolean
  pendingContinue: boolean
  pendingSell: boolean
}>()

const emit = defineEmits<{
  claimSeed: []
  start: [ingredients: Array<{ uid: string, count: number }>]
  continue: []
  settle: []
}>()

const selectedUids = ref<Set<string>>(new Set())
const ingredientCounts = ref<Record<string, number>>({})
const ingredients = computed(() => props.activity?.ingredients || [])
const selectedIngredients = computed(() => ingredients.value
  .filter(item => selectedUids.value.has(item.uid))
  .map(item => ({ uid: item.uid, count: ingredientCounts.value[item.uid] || 1 })))
const allSelected = computed(() => ingredients.value.length > 0 && selectedUids.value.size === ingredients.value.length)
const selectedTotal = computed(() => selectedIngredients.value.reduce((sum, item) => sum + item.count, 0))
const busy = computed(() => props.pendingSeed || props.pendingStart || props.pendingContinue || props.pendingSell)
const quotes = computed(() => (props.activity?.quoteTotals || []).map((total, index) => ({
  index: index + 1,
  unitPrice: props.activity?.quotePrices[index] || '0',
  total,
})))

function mutantTypeLabel(item: { mutantTypeNames?: string[], mutantTypes?: string[] }) {
  if (item.mutantTypeNames?.length)
    return item.mutantTypeNames.join('+')
  if (item.mutantTypes?.length)
    return item.mutantTypes.join('+')
  return ''
}

watch(ingredients, (items) => {
  const availableUids = new Set(items.map(item => item.uid))
  selectedUids.value = new Set([...selectedUids.value].filter(uid => availableUids.has(uid)))
  const nextCounts: Record<string, number> = {}
  for (const item of items)
    nextCounts[item.uid] = Math.max(1, Math.min(ingredientCounts.value[item.uid] || Number(item.count) || 1, Number(item.count) || 1))
  ingredientCounts.value = nextCounts
}, { immediate: true })

function toggleIngredient(uid: string) {
  const next = new Set(selectedUids.value)
  if (next.has(uid))
    next.delete(uid)
  else next.add(uid)
  selectedUids.value = next
}

function toggleAll() {
  selectedUids.value = allSelected.value ? new Set() : new Set(ingredients.value.map(item => item.uid))
}

function setCount(uid: string, value: unknown) {
  const item = ingredients.value.find(entry => entry.uid === uid)
  const maximum = Math.max(1, Number(item?.count || 1))
  ingredientCounts.value = { ...ingredientCounts.value, [uid]: Math.max(1, Math.min(Math.trunc(Number(value) || 1), maximum)) }
}

function itemCount(uid: string) {
  return ingredientCounts.value[uid] || 1
}
</script>

<template>
  <div class="qingmei-page">
    <header class="qingmei-hero">
      <span class="qingmei-kicker">限时酿造</span>
      <h1>{{ activity?.name || '青酿换万金' }}</h1>
      <p>投入青梅，逐轮查看报价，在合适的时机出售。</p>
    </header>

    <section v-if="activity" class="qingmei-panel balance-panel">
      <div class="ingredient">
        <img v-if="activity.ingredient.image" :src="activity.ingredient.image" alt="青梅">
        <div>
          <span>可用青梅</span>
          <strong>{{ activity.balanceKnown ? activity.balance : '--' }}</strong>
        </div>
      </div>
      <button
        type="button"
        class="seed-button"
        :disabled="busy || activity.dailySeed?.claimed"
        @click="emit('claimSeed')"
      >
        {{ activity.dailySeed?.claimed ? '今日已领取' : '领取今日青梅种子' }}
      </button>
    </section>

    <section v-if="activity" class="qingmei-panel brew-panel">
      <div class="section-heading">
        <div>
          <span>本轮酿造</span>
          <strong>{{ activity.currentRound ? `第 ${activity.currentRound}/${activity.maxRounds} 轮` : '尚未开始' }}</strong>
        </div>
        <span class="base-price">保底单价 {{ activity.guaranteedPrice || activity.basePrice || '0' }}</span>
      </div>

      <div v-if="!activity.started" class="brew-setup">
        <div class="setup-heading">
          <span class="setup-label">选择酿造原料</span><button type="button" :disabled="busy || ingredients.length === 0" @click="toggleAll">
            {{ allSelected ? '取消全选' : '全选' }}
          </button>
        </div>
        <div class="ingredient-list">
          <div v-for="item in ingredients" :key="item.key" class="ingredient-choice" :class="{ selected: selectedUids.has(item.uid) }">
            <button type="button" class="ingredient-toggle" :disabled="busy" :aria-pressed="selectedUids.has(item.uid)" @click="toggleIngredient(item.uid)">
              <img v-if="item.image" :src="item.image" alt="">
              <span><strong>{{ item.name || '青梅果实' }}</strong><small>UID {{ item.uid }} · 背包拥有 x{{ item.count }}<template v-if="mutantTypeLabel(item)"> · 变异 {{ mutantTypeLabel(item) }}</template></small></span>
              <span class="selection-mark"><span v-if="selectedUids.has(item.uid)" class="i-carbon-checkmark" /></span>
            </button>
            <div class="count-control">
              <button type="button" aria-label="减少数量" :disabled="busy || !selectedUids.has(item.uid) || itemCount(item.uid) <= 1" @click="setCount(item.uid, itemCount(item.uid) - 1)">
                <span class="i-carbon-subtract" />
              </button>
              <input :value="itemCount(item.uid)" type="number" inputmode="numeric" min="1" :max="item.count" :disabled="busy || !selectedUids.has(item.uid)" @input="setCount(item.uid, ($event.target as HTMLInputElement).value)">
              <button type="button" aria-label="增加数量" :disabled="busy || !selectedUids.has(item.uid) || itemCount(item.uid) >= Number(item.count)" @click="setCount(item.uid, itemCount(item.uid) + 1)">
                <span class="i-carbon-add" />
              </button>
              <button type="button" class="maximum-button" :disabled="busy || !selectedUids.has(item.uid) || itemCount(item.uid) >= Number(item.count)" @click="setCount(item.uid, item.count)">
                全部
              </button>
            </div>
          </div>
        </div>
        <div class="start-controls">
          <span>已选 {{ selectedIngredients.length }} 组，共 {{ selectedTotal }} 个</span>
          <button type="button" :disabled="busy || selectedIngredients.length === 0 || !activity.actions.start.enabled" @click="emit('start', selectedIngredients)">
            开始酿造
          </button>
        </div>
      </div>

      <template v-else>
        <div class="quote-grid">
          <div
            v-for="quote in quotes"
            :key="quote.index"
            class="quote"
          >
            <span>第 {{ quote.index }} 轮</span>
            <strong>{{ Number(quote.total).toLocaleString() }}</strong>
            <small>单价 {{ quote.unitPrice }}</small>
          </div>
          <div v-for="index in Math.max(0, activity.maxRounds - quotes.length)" :key="`pending-${index}`" class="quote pending">
            <span>第 {{ quotes.length + index }} 轮</span>
            <strong>待酿造</strong>
          </div>
        </div>
        <div class="brew-actions">
          <button type="button" class="continue-button" :disabled="busy || !activity.actions.continue.enabled" @click="emit('continue')">
            继续酿造
          </button>
          <button type="button" class="sell-button" :disabled="busy || !activity.actions.settle.enabled" @click="emit('settle')">
            <div class="i-carbon-share" />
            分享出售（1.5倍）
          </button>
        </div>
        <p v-if="quotes.length === 0" class="first-quote-hint">
          青梅已投入，点击继续酿造生成首轮报价。
        </p>
      </template>
    </section>

    <section v-if="activity?.rules.paragraphs.length" class="qingmei-rules">
      <h2>{{ activity.rules.title || '活动说明' }}</h2>
      <p v-for="line in activity.rules.paragraphs" :key="line">
        {{ line }}
      </p>
    </section>

    <div v-else-if="!activity" class="qingmei-empty">
      当前账号暂未发现青酿活动
    </div>
  </div>
</template>

<style scoped>
.qingmei-page {
  min-height: 100%;
  padding: 24px 14px 100px;
  color: #203a32;
  background: linear-gradient(
    145deg,
    rgba(225, 241, 235, 0.96),
    rgba(246, 248, 247, 0.98) 48%,
    rgba(235, 239, 247, 0.96)
  );
}
.qingmei-hero {
  margin: 0 auto 14px;
  padding: 18px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 10px 26px rgba(38, 68, 57, 0.07);
}
.qingmei-kicker {
  display: block;
  color: #5c7b6c;
  font-size: 11px;
  font-weight: 700;
}
.qingmei-hero h1 {
  margin: 2px 0 5px;
  color: #2b493f;
  font-size: 30px;
  line-height: 1.1;
  letter-spacing: 0;
}
.qingmei-hero p {
  margin: 0;
  color: #647a70;
  font-size: 12px;
}
.qingmei-panel {
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 10px 26px rgba(38, 68, 57, 0.07);
}
.balance-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ingredient {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ingredient img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}
.ingredient div,
.section-heading div {
  display: flex;
  flex-direction: column;
}
.ingredient span,
.section-heading span {
  color: #718276;
  font-size: 11px;
}
.ingredient strong {
  font-size: 22px;
}
.seed-button,
.start-controls button,
.brew-actions button {
  min-height: 38px;
  padding: 0 13px;
  border: 0;
  border-radius: 10px;
  color: #fff;
  background: #2e8a66;
  font-weight: 700;
  cursor: pointer;
}
.seed-button:disabled,
.start-controls button:disabled,
.brew-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 13px;
}
.section-heading strong {
  margin-top: 2px;
  font-size: 18px;
}
.base-price {
  padding: 4px 7px;
  border-radius: 4px;
  color: #8d633f !important;
  background: #fff8df;
  border: 1px solid #ead9ad;
}
.brew-setup {
  display: grid;
  gap: 11px;
}
.setup-heading,
.start-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.setup-label,
.start-controls > span {
  color: #64766b;
  font-size: 11px;
}
.setup-heading button {
  border: 0;
  color: #2e8a66;
  background: transparent;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.setup-heading button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ingredient-list {
  display: grid;
  gap: 8px;
}
.ingredient-choice {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(49, 82, 70, 0.14);
  border-radius: 10px;
  color: #315244;
  background: rgba(255, 255, 255, 0.56);
}
.ingredient-choice.selected {
  border-color: rgba(46, 138, 102, 0.55);
  box-shadow: inset 0 0 0 1px rgba(46, 138, 102, 0.35);
  background: rgba(230, 244, 237, 0.88);
}
.ingredient-toggle {
  width: 100%;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ingredient-toggle:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ingredient-toggle img {
  width: 46px;
  height: 46px;
  object-fit: contain;
}
.ingredient-toggle > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.ingredient-toggle strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ingredient-toggle small {
  margin-top: 3px;
  color: #708277;
  font-size: 11px;
}
.selection-mark {
  width: 22px;
  height: 22px;
  display: grid !important;
  place-items: center;
  border: 1px solid #91aa99;
  border-radius: 7px;
  color: white;
  background: white;
}
.ingredient-choice.selected .selection-mark {
  border-color: #2e8a66;
  background: #2e8a66;
}
.start-controls > button {
  min-width: 112px;
}
.count-control {
  display: grid;
  grid-template-columns: 38px minmax(52px, 1fr) 38px 50px;
  gap: 5px;
}
.count-control button,
.count-control input {
  height: 38px;
  border: 1px solid #9eb5a7;
  border-radius: 8px;
}
.count-control button {
  display: grid;
  place-items: center;
  padding: 0;
  color: #315244;
  background: rgba(236, 245, 240, 0.9);
}
.count-control button:disabled,
.count-control input:disabled {
  opacity: 0.45;
}
.count-control .maximum-button {
  font-size: 11px;
  font-weight: 700;
}
.count-control input {
  width: 100%;
  min-width: 0;
  padding: 0 6px;
  color: #203a32;
  background: rgba(255, 255, 255, 0.82);
  font-size: 15px;
  text-align: center;
}
.quote-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.quote {
  height: 88px;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(49, 82, 70, 0.14);
  border-radius: 10px;
  color: #436052;
  background: rgba(255, 255, 255, 0.56);
}
.quote span,
.quote small {
  font-size: 10px;
}
.quote strong {
  max-width: 100%;
  overflow: hidden;
  color: #8d633f;
  font-size: 16px;
  text-overflow: ellipsis;
}
.quote.pending {
  opacity: 0.58;
}
.quote.pending strong {
  color: #728079;
  font-size: 12px;
}
.brew-actions {
  display: grid;
  grid-template-columns: 1fr 1.35fr;
  gap: 8px;
  margin-top: 11px;
}
.continue-button {
  background: #3b9a73 !important;
}
.sell-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: #2e8a66 !important;
}
.first-quote-hint {
  margin: 9px 0 0;
  color: #667b6f;
  font-size: 11px;
  text-align: center;
}
.qingmei-rules {
  margin-top: 12px;
  padding: 16px 18px;
  border: 1px solid rgba(49, 82, 70, 0.1);
  border-radius: 14px;
  color: #647a70;
  background: rgba(255, 255, 255, 0.42);
  font-size: 11px;
  line-height: 1.65;
}
.qingmei-rules h2 {
  margin: 0 0 7px;
  color: #2b493f;
  font-size: 14px;
}
.qingmei-rules p {
  margin: 4px 0;
}
.qingmei-empty {
  padding: 80px 20px;
  text-align: center;
  color: #5e7569;
}
@media (max-width: 360px) {
  .balance-panel {
    align-items: stretch;
    flex-direction: column;
  }
  .seed-button {
    width: 100%;
  }
  .qingmei-hero h1 {
    font-size: 26px;
  }
}
</style>
