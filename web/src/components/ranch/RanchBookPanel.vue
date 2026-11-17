<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'
import BookOverview from '@/components/illustrated/BookOverview.vue'
import BookSection from '@/components/illustrated/BookSection.vue'
import BookTile from '@/components/illustrated/BookTile.vue'
import BookToolbar from '@/components/illustrated/BookToolbar.vue'
import { formatCount, useRanchActions, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useRanchStore } from '@/stores/ranch'

const props = defineProps<{ kind: 'normal' | 'giant' }>()
const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('illustrated')
const { disabled, request } = useRanchActions()

const isGiant = computed(() => props.kind === 'giant')
const book = computed(() => state.value?.book || null)
const animals = computed<any[]>(() => book.value?.animals || [])
const owned = (entry: any) => isGiant.value ? !!entry.giant?.unlocked : !!entry.unlocked
const ownedCount = computed(() => animals.value.filter(owned).length)

const filter = ref('all')
const query = ref('')
const detailsOpen = ref(false)
const rewardList = ref<HTMLElement | null>(null)
watch(() => props.kind, () => {
  filter.value = 'all'
  query.value = ''
})

const filters = computed(() => [
  { value: 'all', label: '全部', count: animals.value.length },
  { value: 'owned', label: '已收集', count: ownedCount.value },
  { value: 'missing', label: '未收集', count: animals.value.length - ownedCount.value },
])
const visible = computed(() => animals.value.filter((entry) => {
  const keyword = query.value.trim()
  if (keyword && !String(entry.name || '').includes(keyword))
    return false
  if (filter.value === 'owned')
    return owned(entry)
  if (filter.value === 'missing')
    return !owned(entry)
  return true
}))

/** 普通图鉴：按收集进度升级；巨大图鉴：按体重总分逐档领奖。 */
const levels = computed<any[]>(() => book.value?.giant?.levels || [])
const nextLevel = computed(() => levels.value.find(level => !level.claimed && !level.canClaim) || null)
const claimable = computed(() => isGiant.value ? levels.value.some(level => level.canClaim) : !!book.value?.normal?.canClaim)
const overview = computed(() => {
  if (!book.value)
    return null
  if (isGiant.value) {
    const score = Number(book.value.giant.score) || 0
    const target = Number(nextLevel.value?.score) || 0
    return {
      badge: formatCount(score),
      badgeLabel: '总分',
      progressText: target ? `${formatCount(score)} / ${formatCount(target)}` : formatCount(score),
      percent: target ? Math.min(100, score / target * 100) : 100,
      hint: claimable.value ? '有可领取的体重奖励' : target ? `距下一档还差 ${formatCount(target - score)} 分` : '已达成全部体重奖励',
    }
  }
  const normal = book.value.normal
  const progress = Number(normal.progress) || 0
  const next = Number(normal.nextProgress) || 0
  return {
    badge: normal.level,
    badgeLabel: '等级',
    progressText: `${progress} / ${next || '—'}`,
    percent: next ? Math.min(100, progress / next * 100) : 100,
    hint: normal.canClaim ? '有可领取的收集奖励' : next > progress ? `距下一级还差 ${next - progress} 进度` : '已达到最高等级',
  }
})

function tileMeta(entry: any) {
  if (!isGiant.value)
    return entry.unlocked ? '已收集' : '未收集'
  if (!entry.giant?.unlocked)
    return entry.giant?.harvestCount && entry.giant.harvestCount !== '0' ? `已收获 ${entry.giant.harvestCount} 次` : '未收集'
  return `${entry.giant.tierName ? `${entry.giant.tierName} · ` : ''}${entry.giant.weightKg} kg`
}
async function scrollToNext() {
  await nextTick()
  const target = rewardList.value?.querySelector<HTMLElement>('[data-next="true"]')
  if (target && rewardList.value)
    rewardList.value.scrollTop = target.offsetTop - rewardList.value.offsetTop
}
</script>

<template>
  <div class="book-page">
    <RanchGate @retry="refresh">
      <template v-if="book && overview">
        <BookOverview
          :title="isGiant ? '巨大图鉴' : '动物图鉴'"
          :icon="isGiant ? 'i-carbon-gem' : 'i-carbon-pet-image-o'"
          :badge-value="overview.badge"
          :badge-label="overview.badgeLabel"
          :caption="`已收集 ${ownedCount} / ${animals.length}`"
          :progress-text="overview.progressText"
          :percent="overview.percent"
          :hint="overview.hint"
        >
          <template #actions>
            <NButton v-if="isGiant" secondary @click="detailsOpen = true">
              奖励详情
            </NButton>
            <NButton v-if="claimable" type="primary" :disabled="disabled" @click="request('claimIllustrated', { kind })">
              领取奖励
            </NButton>
            <NButton secondary :loading="loading" aria-label="刷新图鉴" title="刷新图鉴" @click="refresh">
              <template #icon>
                <span class="i-carbon-renew" />
              </template>
            </NButton>
          </template>
          <template v-if="isGiant && book.mutations?.length">
            <span class="book-chip-label">出现规则</span>
            <span v-for="mutation in book.mutations" :key="mutation.type" class="book-chip">{{ mutation.name }} · {{ mutation.description }} · 基础概率 {{ mutation.baseProbabilityPercent }}%</span>
          </template>
          <template v-else-if="!isGiant && book.normal.canClaim && book.normal.rewards?.length">
            <span class="book-chip-label">可领取</span>
            <span v-for="reward in book.normal.rewards" :key="reward.id" class="book-chip">{{ reward.name }} ×{{ formatCount(reward.count) }}</span>
          </template>
        </BookOverview>

        <BookToolbar v-model:filter="filter" v-model:query="query" :filters="filters" :label="`${isGiant ? '巨大图鉴' : '动物图鉴'}筛选`" placeholder="搜索动物" />

        <BookSection v-if="visible.length" :title="isGiant ? '巨大动物' : '全部动物'" :count="`${ownedCount} / ${animals.length}`" :accent="isGiant ? 'var(--ui-warning)' : undefined">
          <BookTile
            v-for="entry in visible"
            :key="entry.id"
            :name="isGiant ? `巨大${entry.name}` : entry.name"
            :image="entry.image"
            :state="owned(entry) ? 'owned' : 'missing'"
            :meta="tileMeta(entry)"
            :meta-tone="isGiant && owned(entry) ? 'warning' : 'muted'"
          >
            <template v-if="isGiant && entry.giant?.isNew" #corner>
              <span class="book-new">新</span>
            </template>
          </BookTile>
        </BookSection>
        <EmptyState
          v-else
          bare
          :title="animals.length ? '没有符合条件的动物' : '暂无图鉴记录'"
          :description="animals.length ? '换个筛选或搜索词试试' : '饲养动物后会记录到图鉴'"
          :icon="animals.length ? 'i-carbon-search' : 'i-carbon-book'"
        />

        <NModal v-model:show="detailsOpen" @after-enter="scrollToNext">
          <NCard title="巨大图鉴体重奖励" closable class="book-rewards-modal max-w-2xl w-[calc(100vw-24px)]" @close="detailsOpen = false">
            <div ref="rewardList" class="reward-list dialog-scroll custom-scrollbar" role="region" aria-label="体重奖励" tabindex="0">
              <div
                v-for="level in levels"
                :key="level.id"
                :data-next="level.id === nextLevel?.id"
                class="reward-row"
                :class="{ 'is-claimed': level.claimed, 'is-claimable': level.canClaim }"
              >
                <div class="reward-row__level">
                  <b>{{ formatCount(level.score) }} 分</b><small>第 {{ level.id }} 档</small>
                </div>
                <div class="reward-row__items">
                  <span v-for="reward in level.rewards" :key="reward.id" :title="reward.name">
                    <img :src="reward.image" :alt="reward.name" loading="lazy">×{{ formatCount(reward.count) }}
                  </span>
                </div>
                <span class="reward-row__state">
                  <span v-if="level.claimed" class="i-carbon-checkmark" aria-hidden="true" />{{ level.claimed ? '已领取' : level.canClaim ? '可领取' : '未达成' }}
                </span>
              </div>
            </div>
            <template v-if="claimable" #footer>
              <NButton block type="primary" :disabled="disabled" @click="detailsOpen = false; request('claimIllustrated', { kind })">
                领取奖励
              </NButton>
            </template>
          </NCard>
        </NModal>
      </template>
    </RanchGate>
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

.book-new {
  position: absolute;
  top: 5px;
  left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  color: #fff;
  background: var(--ui-danger-fill);
  font-size: 10px;
  font-weight: var(--fw-700);
  line-height: 16px;
}

.book-rewards-modal {
  max-height: calc(100dvh - 32px);
}

.book-rewards-modal :deep(.n-card-content) {
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
  grid-template-columns: 76px minmax(0, 1fr) 64px;
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

@media (max-width: 520px) {
  .reward-row {
    grid-template-columns: 64px minmax(0, 1fr);
  }

  .reward-row__state {
    grid-column: 2;
    text-align: left;
  }
}
</style>
