<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BookOverview from '@/components/illustrated/BookOverview.vue'
import BookSection from '@/components/illustrated/BookSection.vue'
import BookTile from '@/components/illustrated/BookTile.vue'
import BookToolbar from '@/components/illustrated/BookToolbar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useIllustratedStore } from '@/stores/illustrated'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const props = withDefaults(defineProps<{ bookType?: 'crop' | 'mutant' }>(), { bookType: 'crop' })
const accountStore = useAccountStore()
const illustratedStore = useIllustratedStore()
const statusStore = useStatusStore()
const { currentAccountId } = storeToRefs(accountStore)
const { currentAccountConnected: isConnected } = storeToRefs(statusStore)
const { data, loading, error } = storeToRefs(illustratedStore)
const currentType = computed(() => props.bookType)
const isMutant = computed(() => currentType.value === 'mutant')
const bookName = computed(() => isMutant.value ? '超变图鉴' : '作物图鉴')
const detailsOpen = ref(false)
const claiming = ref(false)
const rewardList = ref<HTMLElement | null>(null)
let claimRevision = 0
const toast = useToastStore()
const purchaseDialogOpen = ref(false)
const selectedSeedItem = ref<any>(null)
const purchaseCount = ref(1)
const purchasingSeedId = ref<number | null>(null)
const filter = ref('all')
const query = ref('')

const book = computed(() => data.value?.[currentType.value] || null)
const items = computed<any[]>(() => Array.isArray(book.value?.items) ? book.value.items : [])
const collectedCount = computed(() => items.value.filter(item => item.unlocked).length)
const purchasableCount = computed(() => items.value.filter(canPurchaseSeed).length)
const illustratedBuffs = computed(() => Array.isArray(book.value?.buffs) ? book.value.buffs : [])
const currentIllustratedBuffs = computed(() => Array.isArray(book.value?.currentBuffs) ? book.value.currentBuffs : [])
const illustratedLevelMap = computed(() => new Map(
  (Array.isArray(book.value?.levels) ? book.value.levels : []).map((level: any) => [Number(level?.level) || 0, level]),
))
const nextUnclaimedLevel = computed(() => (Array.isArray(book.value?.levels) ? book.value.levels : []).find((level: any) => !level.claimed)?.level)

function formatBuffValue(bonus: any) {
  const value = Number(bonus?.value) || 0
  return bonus?.valueType === 'probability' ? `触发概率 ${value / 10}%` : `数量 +${value}`
}
function formatBuffLevelState(bonus: any) {
  if (Number(bonus?.level) <= Number(book.value?.level || 0))
    return '已达成'
  const level = illustratedLevelMap.value.get(Number(bonus?.level) || 0) as any
  return level?.progress ? `${level.progress} 进度` : '未达成'
}

const filters = computed(() => [
  { value: 'all', label: '全部', count: items.value.length },
  { value: 'owned', label: '已收藏', count: collectedCount.value },
  { value: 'missing', label: '未收藏', count: items.value.length - collectedCount.value },
  ...(isMutant.value ? [] : [{ value: 'buyable', label: '可购买', count: purchasableCount.value }]),
])

function matches(item: any) {
  const keyword = query.value.trim()
  if (keyword && !String(item.name || '').includes(keyword))
    return false
  if (filter.value === 'owned')
    return !!item.unlocked
  if (filter.value === 'missing')
    return !item.unlocked
  if (filter.value === 'buyable')
    return canPurchaseSeed(item)
  return true
}

const MUTANT_GROUPS = [
  { key: 'gold', label: '黄金果实' },
  { key: 'decoration', label: '装扮果实' },
  { key: 'activity', label: '活动果实' },
] as const
/** 超变图鉴按果实来源分组显示；作物图鉴只有一组。 */
const sections = computed(() => {
  if (!isMutant.value)
    return [{ key: 'crop', label: '全部作物', all: items.value, items: items.value.filter(matches) }]
  const sorted = [...items.value].sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
  return MUTANT_GROUPS.map((group) => {
    const all = sorted.filter(item => item.group === group.key)
    return { key: group.key, label: group.label, all, items: all.filter(matches) }
  }).filter(section => section.all.length)
})
const visibleSections = computed(() => sections.value.filter(section => section.items.length))

function sectionCount(section: { all: any[] }) {
  return `${section.all.filter(item => item.unlocked).length} / ${section.all.length}`
}

function progressPercent(value: any, next: any) {
  const current = Math.max(0, Number(value) || 0)
  const target = Math.max(current, Number(next) || 0)
  return target > 0 ? Math.min(100, Math.round(current / target * 100)) : 100
}
const progressHint = computed(() => {
  if (!book.value)
    return ''
  if (book.value.claimable)
    return '有可领取的收藏奖励'
  const remain = (Number(book.value.nextLevelProgress) || 0) - (Number(book.value.progress) || 0)
  return book.value.nextLevelProgress && remain > 0 ? `距下一级还差 ${remain} 进度` : '已达到最高等级'
})

let purchaseRevision = 0
const purchaseMax = computed(() => Math.min(9999, selectedSeedItem.value?.shopSeed?.remainingPurchaseCount ?? 9999))
const purchaseValid = computed(() => isConnected.value && Number.isSafeInteger(purchaseCount.value) && purchaseCount.value >= 1 && purchaseCount.value <= purchaseMax.value)
function canPurchaseSeed(item: any) {
  const seed = item?.shopSeed
  return !!(isConnected.value && seed?.goodsId && !seed.locked && !seed.soldOut && !seed.unknownMeta && !seed.requiresUnlockCard && Number.isSafeInteger(seed.price) && seed.price > 0)
}
function openSeedPurchase(item: any) {
  if (!canPurchaseSeed(item) || purchasingSeedId.value !== null)
    return
  selectedSeedItem.value = item
  purchaseCount.value = 1
  purchaseDialogOpen.value = true
}

async function purchaseSeed() {
  const item = selectedSeedItem.value
  const seed = item?.shopSeed
  if (!currentAccountId.value || !canPurchaseSeed(item) || !purchaseValid.value || purchasingSeedId.value !== null)
    return
  const count = purchaseCount.value
  const accountId = String(currentAccountId.value)
  const revision = ++purchaseRevision
  purchasingSeedId.value = item.seedId
  try {
    const response = await api.post('/api/seeds/purchase', { goodsId: seed.goodsId, count }, {
      headers: { 'x-account-id': accountId },
      skipErrorToast: true,
    } as any)
    if (revision !== purchaseRevision || accountId !== String(currentAccountId.value))
      return
    if (!response.data?.ok)
      throw new Error(getApiErrorMessage(response.data, '种子购买失败'))
    toast.success(`种子购买成功：${item.name}`)
    purchaseDialogOpen.value = false
    selectedSeedItem.value = null
    await refresh()
  }
  catch (cause: any) {
    if (revision === purchaseRevision)
      toast.error(getApiErrorMessage(cause, '种子购买失败'))
  }
  finally {
    if (revision === purchaseRevision)
      purchasingSeedId.value = null
  }
}

/** 卡片底部一行的短状态：能买就提示购买，否则说明种子获取限制，最后才是收藏状态。 */
function cropMeta(item: any) {
  if (canPurchaseSeed(item))
    return '购买种子'
  const seed = item.shopSeed
  if (seed?.unknownMeta)
    return '其他途径获取'
  if (seed?.requiresUnlockCard)
    return '需种子解锁卡'
  if (seed?.locked)
    return seed.requiredLevel ? `${seed.requiredLevel} 级解锁` : '尚未解锁'
  if (seed?.soldOut)
    return '已达限购'
  return item.unlocked ? '已收藏' : '未收藏'
}

async function refresh() {
  if (currentAccountId.value && isConnected.value)
    await illustratedStore.fetch(currentAccountId.value)
}

async function claimRewards() {
  if (claiming.value || loading.value || !book.value?.claimable || !isConnected.value)
    return
  const accountId = currentAccountId.value
  const revision = ++claimRevision
  claiming.value = true
  try {
    const response = await api.post('/api/illustrated/claim', { type: currentType.value === 'crop' ? 1 : 2 }, { headers: { 'x-account-id': accountId }, skipErrorToast: true } as any)
    if (revision !== claimRevision)
      return
    if (!response.data?.ok)
      throw new Error(getApiErrorMessage(response.data, '图鉴奖励领取失败'))
    const result = response.data.data
    const message = result.rewards?.map((item: any) => `${item.name} ×${item.count}`).join('、') || '领取成功'
    illustratedStore.reset()
    if (result.snapshot)
      data.value = result.snapshot
    if (result.refreshRequired)
      toast.warning(`${message}。请刷新确认最新进度`)
    else toast.success(message)
  }
  catch (cause) {
    if (revision === claimRevision) {
      toast.error(getApiErrorMessage(cause, '图鉴奖励领取失败'))
      await refresh()
    }
  }
  finally {
    if (revision === claimRevision)
      claiming.value = false
  }
}
async function scrollToNextReward() {
  await nextTick()
  const target = rewardList.value?.querySelector<HTMLElement>('[data-next="true"]')
  if (target && rewardList.value)
    rewardList.value.scrollTop = target.offsetTop - rewardList.value.offsetTop
}

watch(currentType, () => {
  filter.value = 'all'
  query.value = ''
  detailsOpen.value = false
})
watch([currentAccountId, isConnected], () => {
  claimRevision++
  claiming.value = false
  purchaseRevision++
  purchaseDialogOpen.value = false
  selectedSeedItem.value = null
  purchasingSeedId.value = null
  detailsOpen.value = false
  illustratedStore.reset()
}, { flush: 'sync' })
watch([currentAccountId, isConnected], refresh, { immediate: true })
</script>

<template>
  <div class="book-page">
    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后查看图鉴进度" icon="i-carbon-user-avatar" />
    <EmptyState v-else-if="!isConnected" title="账号未运行" description="启动账号后会读取图鉴进度" icon="i-carbon-connection-signal-off" />
    <div v-else-if="loading && !data" class="book-loading" role="status" aria-label="正在读取图鉴">
      <span class="i-svg-spinners-90-ring-with-bg" />
    </div>
    <EmptyState v-else-if="error" tone="error" title="图鉴读取失败" :description="error" icon="i-carbon-warning-alt">
      <NButton secondary @click="refresh">
        重新读取
      </NButton>
    </EmptyState>
    <template v-else-if="book">
      <BookOverview
        :title="bookName"
        :icon="isMutant ? 'i-carbon-gem' : 'i-carbon-sprout'"
        :badge-value="book.level || 0"
        badge-label="等级"
        :caption="`已收藏 ${collectedCount} / ${items.length}`"
        :progress-text="`${book.progress || 0} / ${book.nextLevelProgress || '—'}`"
        :percent="progressPercent(book.progress, book.nextLevelProgress)"
        :hint="progressHint"
      >
        <template #actions>
          <NButton secondary @click="detailsOpen = true">
            {{ isMutant ? '加成详情' : '奖励详情' }}
          </NButton>
          <NButton v-if="book.claimable" type="primary" :loading="claiming" :disabled="loading" @click="claimRewards">
            领取奖励
          </NButton>
          <NButton secondary :loading="loading" aria-label="刷新图鉴" title="刷新图鉴" @click="refresh">
            <template #icon>
              <span class="i-carbon-renew" />
            </template>
          </NButton>
        </template>
        <template v-if="isMutant">
          <span class="book-chip-label">当前加成</span>
          <template v-if="currentIllustratedBuffs.length">
            <span v-for="bonus in currentIllustratedBuffs" :key="`current-buff-${bonus.id}`" class="book-chip">{{ bonus.name }} · {{ formatBuffValue(bonus) }}</span>
          </template>
          <span v-else class="book-chip-label">暂无，提升图鉴等级后解锁</span>
        </template>
      </BookOverview>

      <BookToolbar v-model:filter="filter" v-model:query="query" :filters="filters" :label="`${bookName}筛选`" :placeholder="isMutant ? '搜索果实' : '搜索作物'" />

      <BookSection v-for="section in visibleSections" :key="section.key" :title="section.label" :count="sectionCount(section)" :accent="isMutant ? 'var(--ui-warning)' : undefined">
        <template v-if="isMutant">
          <BookTile
            v-for="item in section.items"
            :key="item.seedId"
            :name="item.name"
            :image="item.image"
            :state="item.unlocked ? 'owned' : 'missing'"
            :fresh="item.isNew"
            :meta="item.unlocked ? '已收藏' : '未收藏'"
          />
        </template>
        <template v-else>
          <BookTile
            v-for="item in section.items"
            :key="item.seedId"
            :name="item.name"
            :image="item.image"
            :state="item.unlocked ? 'owned' : 'missing'"
            :fresh="item.isNew"
            :interactive="canPurchaseSeed(item)"
            :label="canPurchaseSeed(item) ? `购买${item.name}种子` : ''"
            :meta-tone="canPurchaseSeed(item) ? 'primary' : 'muted'"
            :meta="cropMeta(item)"
            @select="openSeedPurchase(item)"
          >
            <template v-if="canPurchaseSeed(item)" #meta>
              <span class="i-carbon-shopping-cart" aria-hidden="true" />购买种子
            </template>
          </BookTile>
        </template>
      </BookSection>
      <EmptyState
        v-if="!visibleSections.length"
        bare
        :title="items.length ? '没有符合条件的条目' : '暂无图鉴记录'"
        :description="items.length ? '换个筛选或搜索词试试' : `当前账号还没有${bookName}记录`"
        :icon="items.length ? 'i-carbon-search' : 'i-carbon-book'"
      />

      <NModal v-model:show="purchaseDialogOpen" :mask-closable="purchasingSeedId === null" :close-on-esc="purchasingSeedId === null">
        <NCard class="max-w-sm w-[calc(100vw-32px)]" :title="`购买${selectedSeedItem?.name || ''}种子`" :closable="purchasingSeedId === null" @close="purchaseDialogOpen = false">
          <div class="seed-purchase">
            <div class="seed-purchase__item">
              <span class="seed-purchase__well"><img v-if="selectedSeedItem?.image" :src="selectedSeedItem.image" alt=""></span>
              <div>
                <strong>{{ selectedSeedItem?.name }}</strong>
                <small>每批 {{ selectedSeedItem?.shopSeed?.itemCount || 1 }} 颗 · {{ (selectedSeedItem?.shopSeed?.price || 0).toLocaleString() }} 金币</small>
              </div>
            </div>
            <label class="seed-purchase__row">
              <span>购买批次</span>
              <NInputNumber v-model:value="purchaseCount" :min="1" :max="purchaseMax" :precision="0" class="w-36" :disabled="purchasingSeedId !== null" />
            </label>
            <div class="seed-purchase__row seed-purchase__total">
              <span>合计</span>
              <strong>{{ ((selectedSeedItem?.shopSeed?.price || 0) * (purchaseCount || 0)).toLocaleString() }} 金币</strong>
            </div>
          </div>
          <template #footer>
            <div class="flex justify-end gap-2">
              <NButton secondary :disabled="purchasingSeedId !== null" @click="purchaseDialogOpen = false">
                取消
              </NButton>
              <NButton type="primary" :loading="purchasingSeedId !== null" :disabled="!purchaseValid" @click="purchaseSeed">
                确认购买
              </NButton>
            </div>
          </template>
        </NCard>
      </NModal>

      <NModal v-model:show="detailsOpen" @after-enter="scrollToNextReward">
        <NCard :title="isMutant ? '超变图鉴属性加成' : '作物图鉴收藏奖励'" closable class="book-rewards-modal max-w-2xl w-[calc(100vw-24px)]" @close="detailsOpen = false">
          <template v-if="isMutant">
            <div v-if="illustratedBuffs.length" class="buff-grid custom-scrollbar">
              <div v-for="bonus in illustratedBuffs" :key="`all-buff-${bonus.id}`" class="buff-card" :class="{ 'is-reached': bonus.level <= (book.level || 0) }">
                <div class="buff-card__head">
                  <b>Lv.{{ bonus.level }}</b>
                  <span>{{ formatBuffLevelState(bonus) }}</span>
                </div>
                <p>{{ bonus.name }} · {{ formatBuffValue(bonus) }}</p>
              </div>
            </div>
            <EmptyState v-else bare title="暂无属性加成" icon="i-carbon-gem" />
          </template>
          <div v-else ref="rewardList" class="reward-list custom-scrollbar" role="region" aria-label="收藏奖励" tabindex="0">
            <div
              v-for="level in book.levels"
              :key="level.level"
              :data-next="level.level === nextUnclaimedLevel"
              class="reward-row"
              :class="{ 'is-claimed': level.claimed, 'is-claimable': level.canClaim }"
            >
              <div class="reward-row__level">
                <b>{{ level.level }} 级</b><small>{{ level.progress }} 进度</small>
              </div>
              <div class="reward-row__items">
                <span v-for="reward in level.rewards" :key="reward.itemId" :title="reward.name">
                  <img :src="reward.image" :alt="reward.name">×{{ reward.count }}
                </span>
              </div>
              <span class="reward-row__state">
                <span v-if="level.claimed" class="i-carbon-checkmark" aria-hidden="true" />{{ level.claimed ? '已领取' : level.canClaim ? '可领取' : '未达成' }}
              </span>
            </div>
          </div>
          <template v-if="book.claimable" #footer>
            <NButton block type="primary" :loading="claiming" :disabled="loading || claiming" @click="claimRewards">
              领取奖励
            </NButton>
          </template>
        </NCard>
      </NModal>
    </template>
  </div>
</template>

<style scoped>
.book-page {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
}

.book-loading {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--ui-primary);
  font-size: 28px;
}

.seed-purchase {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.seed-purchase__item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.seed-purchase__item > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.seed-purchase__item strong {
  font-size: 14px;
  font-weight: var(--fw-650);
}

.seed-purchase__item small {
  color: var(--ui-muted);
  font-size: 12px;
}

.seed-purchase__well {
  display: grid;
  width: 52px;
  height: 52px;
  flex: none;
  place-items: center;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.seed-purchase__well img {
  width: 72%;
  height: 72%;
  object-fit: contain;
}

.seed-purchase__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.seed-purchase__total {
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}

.seed-purchase__total strong {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.book-rewards-modal {
  max-height: calc(100dvh - 32px);
}

.book-rewards-modal :deep(.n-card__content) {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.reward-list {
  display: flex;
  max-height: 60vh;
  min-height: 0;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}

.reward-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) 64px;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
}

.reward-row.is-claimable {
  border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));
  background: var(--ui-primary-soft);
}

.reward-row.is-claimed {
  opacity: 0.55;
}

.reward-row__level {
  display: flex;
  flex-direction: column;
}

.reward-row__level b {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.reward-row__level small {
  color: var(--ui-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.reward-row__items {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.reward-row__items > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.reward-row__items img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.reward-row__state {
  color: var(--ui-subtle);
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
}

.reward-row.is-claimable .reward-row__state {
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}

.reward-row__state > span {
  margin-right: 2px;
}

.buff-grid {
  display: grid;
  max-height: 60vh;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  overflow-y: auto;
}

.buff-card {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
}

.buff-card.is-reached {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  background: var(--ui-primary-soft);
}

.buff-card__head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.buff-card__head span {
  color: var(--ui-subtle);
  font-size: 12px;
}

.buff-card.is-reached .buff-card__head span {
  color: var(--ui-primary);
}

.buff-card p {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 520px) {
  .reward-row {
    grid-template-columns: 56px minmax(0, 1fr);
  }

  .reward-row__state {
    grid-column: 2;
    text-align: left;
  }
}
</style>
