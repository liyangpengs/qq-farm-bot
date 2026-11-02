<script setup lang="ts">
import type { MallGoodsDto } from '@/stores/commerce'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import CommerceShopBar from '@/components/commerce/CommerceShopBar.vue'
import PurchaseDialog from '@/components/commerce/PurchaseDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useCommerceStore } from '@/stores/commerce'
import { useToastStore } from '@/stores/toast'
import { getMallLimitLabel, getMallPurchaseAction } from '@/utils/mall-purchase'

type FilterKey = 'all' | 'free' | 'discount' | 'fertilizer' | 'pet' | 'activity'

const { slotType, propsShop = false } = defineProps<{ slotType: 1 | 4 | 5, propsShop?: boolean }>()

const accountStore = useAccountStore()
const commerceStore = useCommerceStore()
const toast = useToastStore()
const route = useRoute()
const { currentAccountId } = storeToRefs(accountStore)
const { mall, mallLoading, purchasingGoodsId, error, notice } = storeToRefs(commerceStore)
const selected = ref<MallGoodsDto | null>(null)
const filter = ref<FilterKey>(route.query.category === 'pet-diary' ? 'activity' : 'all')
const query = ref('')
const clock = ref(Date.now())
let timer: number | undefined

const ACTIVITY_ITEM_IDS = new Set([1028, 1029, 1030, 80101, 80102, 80103, 90031, 90032, 90033, 90034, 90041, 29004, 29005, 101305, 101613, 101618, 101619, 6001, 6002, 26030, 90042])

const filters = computed<Array<{ key: FilterKey, label: string }>>(() => {
  const entries: Array<{ key: FilterKey, label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'free', label: '免费' },
    { key: 'discount', label: '折扣' },
  ]
  if (!propsShop) {
    entries.push(
      { key: 'fertilizer', label: '化肥' },
      { key: 'pet', label: '狗粮' },
      { key: 'activity', label: '活动限定' },
    )
  }
  return entries
})

const filteredGoods = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return (mall.value?.goods || []).filter((goods) => {
    const names = [goods.name, ...goods.rewards.map(item => item.name)].join(' ').toLowerCase()
    if (keyword && !names.includes(keyword) && !String(goods.id).includes(keyword))
      return false
    if (filter.value === 'free')
      return goods.isFree
    if (filter.value === 'discount')
      return goods.isDiscounted || !!goods.discountText
    if (filter.value === 'fertilizer')
      return names.includes('化肥')
    if (filter.value === 'pet')
      return names.includes('狗粮')
    if (filter.value === 'activity')
      return goods.isDiscounted || goods.rewards.some(item => ACTIVITY_ITEM_IDS.has(Number(item.id)))
    return true
  }).map(goods => ({ ...goods, action: getMallPurchaseAction(goods, slotType === 4 ? mall.value?.membership : null) }))
})

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0)
    return `${days}天${hours}小时`
  if (hours > 0)
    return `${hours}小时${minutes}分`
  return `${Math.max(1, minutes)}分钟`
}

const shopStatus = computed(() => {
  if (!mall.value)
    return ''
  if (propsShop)
    return ''
  if (slotType === 4 && mall.value.membership) {
    return mall.value.membership.isSvip
      ? `SVIP 生效中 · 剩余 ${mall.value.membership.remainingDays} 天`
      : '当前账号不是 SVIP，可浏览专属商品'
  }
  const refreshAt = mall.value.serverTime + mall.value.refreshCountdown * 1000
  const seconds = Math.max(0, Math.floor((refreshAt - clock.value) / 1000))
  return `${formatDuration(seconds)}后刷新`
})

const currencies = computed(() => (mall.value?.currencies || []).map(currency => ({
  id: currency.id,
  name: currency.name,
  image: currency.image,
  amount: currency.balanceKnown ? currency.count : null,
})))

// 礼包内容完整清单，用于悬停提示与读屏；卡片上一行放不下时右侧淡出，完整内容在购买弹窗中查看。
function rewardSummary(goods: MallGoodsDto) {
  return goods.rewards.map(item => `${item.name} ×${item.count}`).join('\n')
}

function limitLabel(goods: MallGoodsDto) {
  return propsShop ? '限购' : getMallLimitLabel(goods.limit?.type)
}

// 只有一种奖励且与商品同名时，名称已经说明内容，只补数量。
function isSingleReward(goods: MallGoodsDto) {
  return goods.rewards.length === 1
}

function discountRemaining(goods: MallGoodsDto) {
  if (!goods.discountEndTime)
    return ''
  const end = goods.discountEndTime > 1e12 ? goods.discountEndTime : goods.discountEndTime * 1000
  const seconds = Math.floor((end - clock.value) / 1000)
  return seconds > 0 ? `剩 ${formatDuration(seconds)}` : ''
}

function load() {
  commerceStore.fetchMall(String(currentAccountId.value || ''), slotType, propsShop)
}

function choose(goods: MallGoodsDto) {
  if (getMallPurchaseAction(goods, slotType === 4 ? mall.value?.membership : null).enabled)
    selected.value = goods
}

async function purchase(count: number) {
  if (!selected.value)
    return
  const goods = selected.value
  const succeeded = await commerceStore.purchaseMall(String(currentAccountId.value || ''), goods, count)
  if (succeeded) {
    toast.success(`购买成功：${goods.name} x${count}`)
    selected.value = null
  }
  else {
    toast.error(error.value || `购买失败：${goods.name}`)
  }
}

watch(() => [slotType, propsShop], () => {
  selected.value = null
  filter.value = 'all'
  load()
})
watch(currentAccountId, () => {
  selected.value = null
  load()
})
watch(mall, () => {
  if (selected.value)
    selected.value = mall.value?.goods.find(goods => goods.id === selected.value?.id) || null
})
onMounted(() => {
  load()
  timer = window.setInterval(() => clock.value = Date.now(), 1000)
})
onUnmounted(() => {
  if (timer)
    window.clearInterval(timer)
})
</script>

<template>
  <div class="mall-catalog">
    <CommerceShopBar
      :status="shopStatus"
      :status-tone="slotType === 4 && mall?.membership?.isSvip ? 'violet' : 'muted'"
      :currencies="currencies"
      :loading="mallLoading"
      :disabled="!currentAccountId"
      refresh-label="刷新商城"
      @refresh="load"
    />

    <div v-if="(error && mall) || notice" class="shop-message" :class="{ 'is-success': !!notice && !error }" role="status">
      <span>{{ error || notice }}</span>
      <button type="button" title="关闭消息" aria-label="关闭消息" @click="commerceStore.clearMessages">
        <span class="i-carbon-close" />
      </button>
    </div>

    <section v-if="mall" class="mall-filters" aria-label="商品筛选">
      <div class="mall-filters__chips" role="group" aria-label="商品分类">
        <NButton
          v-for="entry in filters"
          :key="entry.key"
          size="small"
          :type="filter === entry.key ? 'primary' : 'default'"
          :secondary="filter !== entry.key"
          @click="filter = entry.key"
        >
          {{ entry.label }}
        </NButton>
      </div>
      <label class="mall-search">
        <span class="i-carbon-search" aria-hidden="true" />
        <input v-model="query" type="search" placeholder="搜索商品或内容" aria-label="搜索商品">
      </label>
    </section>

    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="商城商品与余额按当前账号读取" icon="i-carbon-user-avatar" />
    <div v-else-if="mallLoading && !mall" class="shop-loading">
      <span class="i-svg-spinners-90-ring-with-bg" />
    </div>
    <EmptyState v-else-if="!mall && error" tone="error" title="商城读取失败" :description="error" icon="i-carbon-warning-alt">
      <NButton secondary @click="load">
        重新读取
      </NButton>
    </EmptyState>
    <EmptyState v-else-if="filteredGoods.length === 0" title="没有匹配的商品" description="换个分类或关键词试试" icon="i-carbon-search-locate" />

    <section v-else class="goods-grid" aria-live="polite">
      <article
        v-for="goods in filteredGoods"
        :key="goods.id"
        class="goods-card"
        :class="{ 'is-unavailable': !goods.action.enabled }"
      >
        <div class="goods-card__visual">
          <CommerceItemImage :src="goods.rewards[0]?.image" :alt="goods.rewards[0]?.name || goods.name" size="md" />
        </div>

        <div class="goods-card__main">
          <div class="goods-card__title">
            <h3 class="goods-card__name" :title="`${goods.name} #${goods.id}`">
              {{ goods.name }}
            </h3>
            <span v-if="!goods.isFree && goods.discountText" class="goods-tag">{{ goods.discountText }}</span>
          </div>
          <div v-if="isSingleReward(goods)" class="goods-card__single">
            {{ goods.rewards[0]?.name }} <b>×{{ goods.rewards[0]?.count.toLocaleString() }}</b>
          </div>
          <div v-else class="goods-card__rewards" :title="rewardSummary(goods)" :aria-label="`礼包内容：${rewardSummary(goods).replace(/\n/g, '，')}`">
            <span class="reward-total">{{ goods.rewards.length }}件</span>
            <span class="goods-card__reward-track">
              <span v-for="reward in goods.rewards" :key="reward.id" class="reward-chip">
                <CommerceItemImage :src="reward.image" :alt="reward.name" size="sm" />
                <b>×{{ reward.count.toLocaleString() }}</b>
              </span>
            </span>
          </div>
          <div v-if="goods.limit || discountRemaining(goods)" class="goods-card__meta">
            <span v-if="goods.limit">{{ limitLabel(goods) }} {{ goods.limit.bought }}/{{ goods.limit.max }}</span>
            <span v-if="discountRemaining(goods)" class="is-warn">{{ discountRemaining(goods) }}</span>
          </div>
        </div>

        <div class="goods-card__buy">
          <div class="goods-price">
            <strong v-if="goods.isFree" class="goods-price__free">免费</strong>
            <template v-else>
              <CommerceItemImage :src="goods.price.image" :alt="goods.price.name" size="sm" />
              <strong :title="goods.price.name">{{ goods.price.count.toLocaleString() }}</strong>
              <del v-if="goods.originalPrice">{{ goods.originalPrice.toLocaleString() }}</del>
            </template>
          </div>
          <NButton
            size="small"
            :type="goods.action.enabled ? 'primary' : 'default'"
            :secondary="!goods.action.enabled"
            :title="goods.action.reason"
            :disabled="!goods.action.enabled || purchasingGoodsId !== null"
            @click="choose(goods)"
          >
            {{ goods.action.label }}
          </NButton>
        </div>
      </article>
    </section>

    <PurchaseDialog
      :open="!!selected"
      :goods="selected"
      :limit-label="selected ? limitLabel(selected) : undefined"
      :pending="purchasingGoodsId === selected?.id"
      @close="selected = null"
      @confirm="purchase"
    />
  </div>
</template>

<style scoped>
.mall-catalog {
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

.mall-filters__chips::-webkit-scrollbar {
  display: none;
}

.mall-filters__chips :deep(.n-button) {
  flex: none;
}

.mall-search {
  display: flex;
  width: min(260px, 36vw);
  height: 34px;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  color: var(--ui-subtle);
  background: var(--glass-input);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.mall-search:focus-within {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-primary) 14%, transparent);
}

.mall-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: var(--ui-ink);
  background: transparent;
  font-size: 13px;
}

.shop-loading {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--ui-primary);
  font-size: 28px;
}

/* 横向紧凑卡：图 | 名称与内容 | 价格与按钮。内容压成一行，所有卡片等高。 */
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

.goods-card__visual {
  position: relative;
}

.goods-card__visual :deep(.item-image) {
  width: 64px;
  height: 64px;
  border: 0;
  border-radius: 16px;
  background: var(--ui-surface-soft);
}

.goods-card__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

/* 折扣标签放在名称后面，不再压在商品图上。 */
.goods-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 11px;
  font-weight: var(--fw-700);
  line-height: 18px;
  white-space: nowrap;
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
  align-items: center;
  gap: 6px;
  cursor: help;
}

.reward-total {
  flex: none;
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-600);
}

/* 一行放不下的物品在右侧淡出，不会被截成半个。 */
.goods-card__reward-track {
  display: flex;
  min-width: 0;
  flex: 1;
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

.reward-chip b {
  font-weight: var(--fw-600);
}

.goods-card__meta {
  display: flex;
  gap: 10px;
  color: var(--ui-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
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

.goods-price del {
  color: var(--ui-subtle);
  font-size: 11px;
}

.goods-price__free {
  color: var(--ui-primary);
}

.shop-message {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--ui-radius-control);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 13px;
}

.shop-message.is-success {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.shop-message button {
  display: grid;
  place-items: center;
  color: inherit;
}

@media (max-width: 720px) {
  .mall-filters {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .mall-search {
    width: 100%;
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

  .goods-card__buy :deep(.n-button) {
    min-width: 64px;
    height: 30px;
  }
}
</style>
