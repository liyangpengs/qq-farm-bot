<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import CommerceShopBar from '@/components/commerce/CommerceShopBar.vue'
import { formatCount, useRanchActions, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchAmountDialog from '@/components/ranch/RanchAmountDialog.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useRanchStore } from '@/stores/ranch'

const props = defineProps<{ tab: 'shop' | 'market' | 'cans' }>()
const { state, loading } = storeToRefs(useRanchStore())
const { disabled, request } = useRanchActions()

const shopId = ref(5)
const canSlot = ref(6)
const shelf = ref<number | 'all'>('all')
const autoPlace = ref(false)
const { refresh } = useRanchLoader(props.tab, () => ({ shopId: props.tab === 'shop' ? shopId.value : props.tab === 'cans' ? canSlot.value : undefined }))

const ACTION = { shop: 'buy', market: 'exchange', cans: 'buyCan' } as const
const VERB = { shop: '购买', market: '兑换', cans: '购买' } as const

const segments = computed(() => {
  if (props.tab === 'shop')
    return [{ key: 5, label: '幼崽' }, { key: 6, label: '饲料' }]
  if (props.tab === 'cans')
    return [{ key: 6, label: '常驻商品' }, { key: 7, label: '限时商品' }]
  const shelves = [...(state.value?.market?.shelves || [])].sort((a: any, b: any) => a.sort - b.sort)
  return [{ key: 'all' as const, label: '全部' }, ...shelves.map((s: any) => ({ key: s.id as number, label: s.name }))]
})
const segment = computed(() => props.tab === 'shop' ? shopId.value : props.tab === 'cans' ? canSlot.value : shelf.value)
function selectSegment(key: number | 'all') {
  if (props.tab === 'shop')
    shopId.value = key as number
  else if (props.tab === 'cans')
    canSlot.value = key as number
  else shelf.value = key
}

const allGoods = computed<any[]>(() => {
  if (props.tab === 'shop')
    return state.value?.shop?.goods || []
  if (props.tab === 'cans')
    return state.value?.canShop?.goods || []
  return state.value?.market?.goods || []
})
const goods = computed(() => props.tab === 'market' && shelf.value !== 'all' ? allGoods.value.filter(g => g.shelfId === shelf.value) : allGoods.value)

const status = computed(() => {
  if (props.tab === 'market') {
    const market = state.value?.market
    if (!market)
      return { text: '', tone: 'muted' as const }
    return market.present ? { text: '仓鼠驿站今日到访，可用便便兑换', tone: 'muted' as const } : { text: '仓鼠驿站当前未到访', tone: 'warning' as const }
  }
  return { text: props.tab === 'shop' ? '牧场商店 · 购买幼崽与饲料' : '罐头商城 · 使用罐头喂养动物', tone: 'muted' as const }
})
/** 余额栏只列当前商品实际用到的货币（集市同时用便便和松果，罐头商城可能用钻石）。 */
const currencies = computed(() => {
  const result = new Map<number, { id: number, name: string, image: string, amount: number | null }>()
  for (const good of allGoods.value) {
    const id = Number(good.price?.id)
    if (good.free || !id || result.has(id))
      continue
    const owned = state.value?.currencies?.find((c: any) => Number(c.id) === id)
    const balance = good.price.balance ?? owned?.count
    result.set(id, { id, name: good.price.name, image: good.price.image, amount: balance === null || balance === undefined ? null : Number(balance) })
  }
  return [...result.values()]
})
function maxCount(good: any) {
  return Math.max(1, Math.min(Number(good.maxCount) || 999, good.remaining ?? 999))
}
function unavailableReason(good: any) {
  if (good.available)
    return ''
  if (good.remaining === 0)
    return '已售罄'
  if (good.requiredLevel && Number(state.value?.level) < Number(good.requiredLevel))
    return `需牧场 ${good.requiredLevel} 级`
  if (props.tab === 'market' && !state.value?.market?.present)
    return '未到访'
  return '暂不可购买'
}

const active = ref<any>(null)
function input(good: any, count: number) {
  return { goodsId: good.id, count, shopId: shopId.value, slotType: canSlot.value, autoPlace: props.tab === 'shop' && autoPlace.value }
}
function buy(good: any) {
  // 只能买一个时直接进入确认，省掉选数量这一步。
  if (maxCount(good) <= 1)
    void request(ACTION[props.tab], input(good, 1))
  else active.value = good
}
function submit(count: number) {
  const good = active.value
  active.value = null
  if (good)
    void request(ACTION[props.tab], input(good, count))
}
function priceCaption(good: any) {
  if (!good)
    return ''
  if (good.free)
    return '免费领取'
  const balance = good.price.balance === null || good.price.balance === undefined ? '' : ` · 余额 ${formatCount(good.price.balance)}`
  return `单价 ${formatCount(good.price.count)} ${good.price.name}${balance}`
}
</script>

<template>
  <div class="mall">
    <RanchGate @retry="refresh">
      <CommerceShopBar
        :status="status.text"
        :status-tone="status.tone"
        status-icon="i-carbon-store"
        :currencies="currencies"
        :loading="loading"
        refresh-label="刷新商品"
        @refresh="refresh"
      />

      <section class="mall-filters" aria-label="商品分类">
        <div class="mall-filters__chips" role="group" aria-label="商品分类">
          <NButton
            v-for="entry in segments"
            :key="entry.key"
            size="small"
            :type="segment === entry.key ? 'primary' : 'default'"
            :secondary="segment !== entry.key"
            :disabled="disabled && segment !== entry.key"
            :aria-pressed="segment === entry.key"
            @click="selectSegment(entry.key)"
          >
            {{ entry.label }}
          </NButton>
        </div>
        <BaseSwitch v-if="tab === 'shop' && shopId === 5" v-model="autoPlace" label="购买后自动放养" :disabled="disabled" />
      </section>

      <EmptyState v-if="!goods.length && !loading" :title="tab === 'market' ? '集市暂无商品' : '暂无商品'" :description="tab === 'market' ? '仓鼠驿站到访时会上架新的商品' : '换个分类看看'" icon="i-carbon-store" />

      <section v-else class="goods-grid" aria-live="polite">
        <article v-for="good in goods" :key="good.id" class="goods-card" :class="{ 'is-unavailable': !good.available }">
          <div class="goods-card__visual">
            <CommerceItemImage :src="good.reward.image" :alt="good.reward.name" size="md" />
          </div>
          <div class="goods-card__main">
            <h3 class="goods-card__name" :title="good.name || good.reward.name">
              {{ good.name || good.reward.name }}
            </h3>
            <div v-if="good.rewards?.length > 1" class="goods-card__rewards">
              <span v-for="reward in good.rewards" :key="reward.id" class="reward-chip" :title="reward.name">
                <CommerceItemImage :src="reward.image" :alt="reward.name" size="sm" /><b>×{{ formatCount(reward.count) }}</b>
              </span>
            </div>
            <div v-else class="goods-card__single">
              {{ good.reward.name }} <b>×{{ formatCount(good.reward.count) }}</b>
            </div>
            <div class="goods-card__meta">
              <span v-if="good.remaining !== null && good.remaining !== undefined">剩余 {{ good.remaining }}</span>
              <span v-if="!good.available" class="is-warn">{{ unavailableReason(good) }}</span>
              <span v-else-if="good.requiredLevel && Number(good.requiredLevel) > 1">牧场 {{ good.requiredLevel }} 级</span>
            </div>
          </div>
          <div class="goods-card__buy">
            <div class="goods-price">
              <strong v-if="good.free" class="goods-price__free">免费</strong>
              <template v-else>
                <CommerceItemImage :src="good.price.image" :alt="good.price.name" size="sm" />
                <strong :title="good.price.name">{{ formatCount(good.price.count) }}</strong>
              </template>
            </div>
            <NButton size="small" type="primary" :secondary="!good.free" :disabled="disabled || !good.available" @click="buy(good)">
              {{ good.free ? '领取' : VERB[tab] }}
            </NButton>
          </div>
        </article>
      </section>
    </RanchGate>

    <RanchAmountDialog
      :show="!!active"
      :title="`${VERB[tab]}${active?.name || active?.reward?.name || ''}`"
      :name="active ? `${active.reward.name} ×${formatCount(active.reward.count)}` : ''"
      :image="active?.reward?.image"
      :caption="priceCaption(active)"
      :max="active ? maxCount(active) : 1"
      :submit-text="VERB[tab]"
      @close="active = null"
      @submit="submit"
    />
  </div>
</template>

<style scoped>
.mall {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 24px;
}

.mall-filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mall-filters__chips {
  display: flex;
  min-width: 0;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.mall-filters__chips :deep(.n-button) {
  flex: none;
}

.goods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}

.goods-card {
  display: grid;
  min-width: 0;
  min-height: 104px;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
  transition:
    border-color 0.15s ease,
    opacity 0.15s ease;
}

.goods-card:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 30%, var(--ui-border));
}

.goods-card.is-unavailable {
  opacity: 0.62;
}

.goods-card__visual :deep(.item-image) {
  width: 64px;
  height: 64px;
  border: 0;
  border-radius: 16px;
  background: var(--ui-surface-soft);
}

.goods-card__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.goods-card__name {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goods-card__single {
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goods-card__single b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.goods-card__rewards {
  display: flex;
  min-width: 0;
  gap: 4px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
  mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
}

.reward-chip {
  height: 26px;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 0 7px 0 3px;
  border-radius: 8px;
  color: var(--ui-ink);
  background: var(--ui-surface-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.reward-chip :deep(.item-image) {
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
}

.goods-card__meta {
  display: flex;
  gap: 10px;
  color: var(--ui-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.goods-card__meta:empty {
  display: none;
}

.goods-card__meta .is-warn {
  color: var(--ui-warning);
}

.goods-card__buy {
  display: flex;
  min-width: 84px;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.goods-card__buy :deep(.n-button) {
  min-width: 72px;
}

.goods-price {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-warning);
  font-size: 14px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.goods-price :deep(.item-image) {
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
}

.goods-price__free {
  color: var(--ui-primary);
}

@media (max-width: 720px) {
  .mall-filters {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .goods-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }

  .goods-card {
    min-height: 96px;
    grid-template-columns: 52px minmax(0, 1fr) auto;
    gap: 12px;
    padding: 12px;
  }

  .goods-card__visual :deep(.item-image) {
    width: 52px;
    height: 52px;
    border-radius: 14px;
  }

  .goods-card__buy {
    min-width: 72px;
    gap: 6px;
  }
}
</style>
