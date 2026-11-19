<script setup lang="ts">
import type { RanchItem } from '@/stores/ranch'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { formatCount, formatDuration, useRanchActions, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchAmountDialog from '@/components/ranch/RanchAmountDialog.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useRanchStore } from '@/stores/ranch'

/** 幼崽按适用设施分成窝、棚两类，窝在前，不混在一起。 */
type Category = 'all' | 'product' | 'coop' | 'shed' | 'can' | 'other'
const CATEGORIES: Array<{ value: Category, label: string, icon: string }> = [
  { value: 'all', label: '全部', icon: 'i-carbon-list-boxes' },
  { value: 'product', label: '产物', icon: 'i-carbon-wheat' },
  { value: 'coop', label: '窝幼崽', icon: 'i-carbon-home' },
  { value: 'shed', label: '棚幼崽', icon: 'i-carbon-building' },
  { value: 'can', label: '罐头', icon: 'i-carbon-flash' },
  { value: 'other', label: '其他', icon: 'i-carbon-box' },
]
const SHORT: Record<Exclude<Category, 'all'>, string> = { product: '产物', coop: '窝', shed: '棚', can: '罐头', other: '道具' }
const RANK: Record<Exclude<Category, 'all'>, number> = { product: 0, coop: 1, shed: 2, can: 3, other: 4 }
/** 设施类型：窝 6、棚 7，放养时只列出适用的设施。 */
const PEN_TYPE: Record<string, number> = { 窝: 6, 棚: 7 }

const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('bag')
const { disabled, request } = useRanchActions()

const items = computed<any[]>(() => state.value?.bag || [])
const pens = computed<any[]>(() => (state.value?.facilities || []).filter((f: any) => f.ranch && f.state !== 2))
const category = ref<Category>('all')
const failed = ref<Record<string, boolean>>({})

function categoryOf(item: any): Exclude<Category, 'all'> {
  if (item.can)
    return 'can'
  if (item.animalId)
    return item.husbandryType === '棚' ? 'shed' : 'coop'
  if (item.product || [106, 107].includes(Number(item.type)))
    return 'product'
  return 'other'
}
const counts = computed(() => {
  const result: Record<Category, number> = { all: items.value.length, product: 0, coop: 0, shed: 0, can: 0, other: 0 }
  for (const item of items.value)
    result[categoryOf(item)]++
  return result
})
/** 服务器返回的顺序不固定：按分类排列，幼崽高等级在前，其余按编号，刷新后位置不变。 */
const sorted = computed(() => [...items.value].sort((a, b) => RANK[categoryOf(a)] - RANK[categoryOf(b)]
  || (Number(b.animalId) || 0) - (Number(a.animalId) || 0)
  || Number(a.id) - Number(b.id)
  || String(a.uid).localeCompare(String(b.uid))))
const filtered = computed(() => category.value === 'all' ? sorted.value : sorted.value.filter(item => categoryOf(item) === category.value))
const canSellProducts = computed(() => items.value.some(item => item.canSell && [106, 107].includes(Number(item.type))))

interface BagAction {
  key: 'useCan' | 'place' | 'sell'
  label: string
  title: string
  submit: string
}

function actionsFor(item: any): BagAction[] {
  if (item.locked)
    return []
  const actions: BagAction[] = []
  if (item.can)
    actions.push({ key: 'useCan', label: '添加', title: '添加到罐头桶', submit: '添加到罐头桶' })
  else if (item.animalId)
    actions.push({ key: 'place', label: '放养', title: `放养${item.name}`, submit: '放养' })
  if (item.canSell)
    actions.push({ key: 'sell', label: '出售', title: `出售${item.name}`, submit: '下一步' })
  return actions
}

const active = ref<{ item: any, action: BagAction } | null>(null)
const destination = ref<string>('')
const activeAction = computed(() => active.value?.action)
const activeItem = computed(() => active.value?.item)
const activeMax = computed(() => {
  const item = activeItem.value
  if (!item)
    return 1
  const owned = Math.min(2147483647, Number(item.count) || 1)
  if (activeAction.value?.key !== 'place')
    return owned
  const pen = pens.value.find(f => f.id === destination.value)
  return pen ? Math.max(1, Math.min(owned, pen.ranch.capacity - pen.ranch.count)) : owned
})
const penOptions = computed(() => pens.value.filter(f => !activeItem.value?.husbandryType || Number(f.moduleType) === PEN_TYPE[activeItem.value.husbandryType]).map(f => ({
  label: `${f.name}（${f.ranch.count} / ${f.ranch.capacity}）`,
  value: f.id,
  disabled: f.ranch.count >= f.ranch.capacity,
})))

function open(item: any, action: BagAction) {
  active.value = { item, action }
  destination.value = penOptions.value.find(option => !option.disabled)?.value || ''
}
function submit(count: number) {
  const selection = active.value
  active.value = null
  if (selection) {
    const { item, action } = selection
    void request(action.key, { uid: item.uid, itemId: item.id, ranchId: action.key === 'place' ? destination.value : undefined, count })
  }
}
function caption(item: any) {
  if (!item)
    return ''
  if (item.can?.speed_up_secs)
    return `每个可加速 ${formatDuration(item.can.speed_up_secs)} · 库存 ${formatCount(item.count)}`
  const prices = item.sellPrices?.map((price: RanchItem) => `${formatCount(price.count)} ${price.name}`).join(' + ')
  return prices ? `单价 ${prices} · 库存 ${formatCount(item.count)}` : `库存 ${formatCount(item.count)}`
}
watch(category, () => failed.value = {})
</script>

<template>
  <div class="personal-panel">
    <div class="flex shrink-0 items-center justify-between gap-3">
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <span class="i-carbon-box" /> 牧场背包
      </h2>
      <div class="flex items-center gap-2">
        <span v-if="items.length" class="text-sm text-gray-500">共 {{ items.length }} 种物品</span>
        <NButton circle quaternary size="small" title="刷新背包" aria-label="刷新背包" :loading="loading" @click="refresh">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </div>

    <RanchGate @retry="refresh">
      <EmptyState v-if="!items.length" title="牧场背包是空的" description="在牧场商店购买幼崽或罐头后会出现在这里" icon="i-carbon-box" />

      <div v-else class="personal-panel__card bag-card farm-card rounded-2xl">
        <div class="bag-toolbar panel-sticky">
          <div class="bag-categories" role="group" aria-label="背包分类">
            <NButton
              v-for="cat in CATEGORIES"
              :key="cat.value"
              size="small"
              :type="category === cat.value ? 'primary' : 'default'"
              :secondary="category !== cat.value"
              :aria-pressed="category === cat.value"
              @click="category = cat.value"
            >
              <span :class="cat.icon" class="mr-1.5" />{{ cat.label }}<span class="ml-1 text-xs opacity-70">({{ counts[cat.value] }})</span>
            </NButton>
          </div>
          <NButton size="small" type="warning" secondary :disabled="disabled || !canSellProducts" @click="request('sell', { all: true })">
            <span class="i-carbon-shopping-cart-arrow-down mr-1" />出售全部产物
          </NButton>
        </div>

        <EmptyState v-if="!filtered.length" bare title="这个分类暂无物品" icon="i-carbon-box" />
        <div v-else class="bag-grid">
          <article v-for="item in filtered" :key="item.uid" class="bag-item">
            <div class="bag-item__thumb">
              <img v-if="item.image && !failed[item.uid]" :src="item.image" :alt="item.name" loading="lazy" @error="failed[item.uid] = true">
              <span v-else class="bag-item__fallback">{{ (item.name || '物').slice(0, 1) }}</span>
              <span v-if="item.locked" class="bag-item__lock" title="已锁定"><span class="i-carbon-locked" /></span>
            </div>
            <strong class="bag-item__name" :title="item.name">{{ item.name }}</strong>
            <div class="bag-item__meta">
              <span class="bag-type" :class="`bag-type--${categoryOf(item)}`">{{ SHORT[categoryOf(item)] }}</span>
              <span v-if="item.giantCub" class="is-giant">巨大</span>
              <span v-if="item.product?.weightX10">{{ (item.product.weightX10 / 100).toFixed(2).replace(/\.?0+$/, '') }}kg</span>
              <span v-if="item.sellPrices?.[0]" title="单价">{{ formatCount(item.sellPrices[0].count) }}{{ item.sellPrices[0].name }}</span>
              <span v-if="item.locked" class="is-locked">已锁定</span>
            </div>
            <footer class="bag-item__foot">
              <span class="bag-item__qty"><small>×</small>{{ formatCount(item.count) }}</span>
              <div class="bag-item__actions">
                <NButton
                  v-for="action in actionsFor(item)"
                  :key="action.key"
                  attr-type="button"
                  size="tiny"
                  :type="action.key === 'sell' ? 'default' : 'primary'"
                  secondary
                  :disabled="disabled"
                  :aria-label="action.title"
                  :title="action.title"
                  @click="open(item, action)"
                >
                  {{ action.label }}
                </NButton>
              </div>
            </footer>
          </article>
        </div>
      </div>
    </RanchGate>

    <RanchAmountDialog
      :show="!!active"
      :title="activeAction?.title || ''"
      :name="activeItem?.name || ''"
      :image="activeItem?.image"
      :caption="caption(activeItem)"
      :max="activeMax"
      :ready="activeAction?.key !== 'place' || !!destination"
      :submit-text="activeAction?.submit"
      @close="active = null"
      @submit="submit"
    >
      <BaseSelect v-if="activeAction?.key === 'place'" v-model="destination" label="放养到" :options="penOptions" placeholder="选择窝或棚" />
      <p v-if="activeAction?.key === 'place' && !penOptions.some(option => !option.disabled)" class="bag-hint">
        {{ activeItem?.husbandryType || '窝和棚' }}已住满，先收获或升级设施。
      </p>
    </RanchAmountDialog>
  </div>
</template>

<style scoped>
.bag-card {
  --bag-pad: 16px;
  padding: var(--bag-pad);
}

@media (min-width: 640px) {
  .bag-card {
    --bag-pad: 20px;
  }
}

.bag-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: calc(-1 * var(--bag-pad)) calc(-1 * var(--bag-pad)) 14px;
  padding: 12px var(--bag-pad);
  border-radius: var(--ui-radius-card) var(--ui-radius-card) 0 0;
  background: var(--ui-table-head);
  box-shadow: 0 1px 0 var(--ui-border);
}

.bag-categories {
  display: flex;
  min-width: 0;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}

.bag-categories :deep(.n-button) {
  flex: none;
}

.bag-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  grid-auto-rows: 1fr;
  gap: 14px;
}

.bag-item {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px 12px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
  text-align: center;
}

.bag-item__thumb {
  position: relative;
  display: grid;
  width: 72px;
  height: 72px;
  margin-bottom: 8px;
  place-items: center;
  border-radius: 18px;
  background: var(--ui-surface-soft);
}

.bag-item__thumb img {
  max-width: 56px;
  max-height: 56px;
  object-fit: contain;
}

.bag-item__fallback {
  color: var(--ui-subtle);
  font-size: 24px;
  font-weight: var(--fw-700);
}

.bag-item__lock {
  position: absolute;
  top: -6px;
  left: -6px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 999px;
  color: #fff;
  background: var(--ui-warning-fill);
  box-shadow: 0 0 0 2px var(--ui-surface-strong);
  font-size: 12px;
}

.bag-item__name {
  width: 100%;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bag-item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px 8px;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

.bag-item__meta .is-giant {
  color: #b07a0c;
  font-weight: var(--fw-650);
}

.bag-item__meta .is-locked {
  color: var(--ui-warning);
  font-weight: var(--fw-600);
}

.bag-type {
  padding: 0 6px;
  border-radius: 5px;
  font-weight: var(--fw-600);
}

.bag-type--product {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.bag-type--coop {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.bag-type--shed {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.bag-type--can {
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
}

.bag-type--other {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.bag-item__foot {
  display: flex;
  width: 100%;
  min-height: 34px;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px dashed var(--ui-border);
}

.bag-item__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  margin-inline-start: auto;
}

.bag-item__qty {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 16px;
  font-weight: var(--fw-700);
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.bag-item__qty small {
  margin-right: 1px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.bag-hint {
  margin: 0;
  color: var(--ui-warning);
  font-size: 12px;
}

@media (max-width: 520px) {
  .bag-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
}
</style>
