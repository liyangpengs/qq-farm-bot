<script setup lang="ts">
import type { RanchItem } from '@/stores/ranch'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import CommerceShopBar from '@/components/commerce/CommerceShopBar.vue'
import { formatCount, useRanchActions, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchAmountDialog from '@/components/ranch/RanchAmountDialog.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useToastStore } from '@/stores/toast'
import { purchaseMaxCount } from '@/utils/purchase-count'

const props = defineProps<{ tab: 'shop' | 'market' | 'cans' }>()
const { state, loading } = storeToRefs(useRanchStore())
const { currentAccountId } = storeToRefs(useAccountStore())
const { disabled, request } = useRanchActions()
const toast = useToastStore()

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

interface RanchGood {
  id: string
  name?: string
  reward: RanchItem
  rewards?: RanchItem[]
  price: RanchItem & { balance?: string | null }
  available: boolean
  free?: boolean
  maxCount?: number
  remaining?: number | null
  requiredLevel?: string | null
  shelfId?: number
  animal?: { husbandry_type: string } | null
}

const allGoods = computed<RanchGood[]>(() => {
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
    return market.present ? { text: '仓鼠驿站今日到访，可用便便或松果兑换', tone: 'muted' as const } : { text: '仓鼠驿站当前未到访', tone: 'warning' as const }
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
function maxCount(good: RanchGood) {
  return purchaseMaxCount({
    cap: Number(good.maxCount ?? 999),
    limitRemaining: good.remaining ?? null,
    costs: good.free ? [] : [{ count: good.price.count, balance: balanceOf(good) }],
  })
}
function balanceOf(good: RanchGood) {
  return good.price.balance ?? state.value?.currencies?.find((c: any) => Number(c.id) === Number(good.price.id))?.count
}
function unavailableReason(good: RanchGood) {
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

const activeId = ref<string | null>(null)
const active = computed(() => allGoods.value.find(good => good.id === activeId.value) ?? null)
const activeVerb = computed(() => active.value?.free ? '领取' : VERB[props.tab])
const activeName = computed(() => active.value?.name || active.value?.reward.name || '')
watch([currentAccountId, segment], () => activeId.value = null)

function input(good: RanchGood, count: number) {
  const place = props.tab === 'shop' && shopId.value === 5 && !!good.animal && autoPlace.value
  return { goodsId: good.id, count, shopId: shopId.value, slotType: canSlot.value, autoPlace: place }
}

function buy(good: RanchGood) {
  if (disabled.value || !good.available)
    return
  if (maxCount(good) < 1) {
    toast.error(balanceOf(good) == null ? '余额未确认，请刷新商品' : `${good.price.name}余额不足`)
    return
  }
  activeId.value = good.id
}

function scaled(item: RanchItem, count: number): RanchItem {
  return { ...item, count: (BigInt(item.count) * BigInt(count)).toString() }
}

function submit(count: number) {
  const good = active.value
  if (!good?.available || disabled.value || count > maxCount(good))
    return
  activeId.value = null
  void request(ACTION[props.tab], input(good, count), {
    costItems: good.free ? [] : [scaled(good.price, count)],
    rewards: (good.rewards || [good.reward]).map(reward => scaled(reward, count)),
  })
}

function priceCaption(good: RanchGood | null) {
  if (!good)
    return ''
  if (good.free)
    return '免费领取'
  const balance = balanceOf(good) == null ? '' : ` · 余额 ${formatCount(balanceOf(good))}`
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
            <div class="goods-card__heading">
              <h3 class="goods-card__name" :title="good.name || good.reward.name">
                {{ good.name || good.reward.name }}
              </h3>
              <span v-if="good.animal?.husbandry_type" class="goods-card__housing" :class="{ 'is-shed': good.animal.husbandry_type === '棚' }">
                {{ good.animal.husbandry_type }}
              </span>
            </div>
            <div v-if="good.rewards && good.rewards.length > 1" class="goods-card__rewards">
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
            <NButton
              size="small"
              :type="maxCount(good) > 0 ? 'primary' : 'default'"
              :secondary="!good.free"
              :disabled="disabled || !good.available || maxCount(good) < 1"
              @click="buy(good)"
            >
              {{ good.free ? '领取' : VERB[tab] }}
            </NButton>
          </div>
        </article>
      </section>
    </RanchGate>

    <RanchAmountDialog
      :show="!!active"
      :title="`${activeVerb}${activeName}`"
      :name="active?.rewards && active.rewards.length > 1 ? activeName : active ? `${active.reward.name} ×${formatCount(active.reward.count)}` : ''"
      :image="active?.reward?.image"
      :caption="priceCaption(active)"
      :max="active ? maxCount(active) : 1"
      :submit-text="activeVerb"
      :ready="!!active?.available && !disabled"
      @close="activeId = null"
      @submit="submit"
    >
      <template #details="{ count }">
        <template v-if="active">
          <output class="purchase-total">
            <span>总消耗</span>
            <strong v-if="active.free">免费</strong>
            <strong v-else-if="count !== null">
              <CommerceItemImage :src="active.price.image" alt="" size="sm" />
              {{ formatCount(scaled(active.price, count).count) }} {{ active.price.name }}
            </strong>
            <strong v-else>—</strong>
          </output>
          <p v-if="autoPlace && tab === 'shop' && active.animal" class="purchase-detail">
            购买后放养至{{ active.animal.husbandry_type }}
          </p>
          <p v-if="count !== null && active.rewards && active.rewards.length > 1" class="purchase-detail">
            {{ active.rewards.map(reward => `${reward.name} ×${formatCount(scaled(reward, count).count)}`).join('、') }}
          </p>
        </template>
      </template>
    </RanchAmountDialog>
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

.goods-card__heading {
  display: flex;
  align-items: center;
  gap: 6px;
}

.goods-card__housing {
  flex: none;
  padding: 1px 6px;
  border-radius: 6px;
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  font-size: 11px;
  font-weight: var(--fw-600);
}

.goods-card__housing.is-shed {
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 14%, transparent);
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

.purchase-total {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--ui-surface-soft);
  font-size: 13px;
}

.purchase-total strong {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}

.purchase-total :deep(.item-image) {
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
}

.purchase-detail {
  margin: 0;
  color: var(--ui-muted);
  font-size: 12px;
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
