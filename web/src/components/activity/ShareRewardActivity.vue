<script setup lang="ts">
import type { CommerceItemDto } from '@/stores/commerce'
import { NButton } from 'naive-ui/es/button'
import { NPopover } from 'naive-ui/es/popover'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import BookOverview from '@/components/illustrated/BookOverview.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

interface ShareRewardState {
  id: string
  title: string
  icon: string
  active: boolean
  startTime: number
  endTime: number
  serverTime: number
  score: number
  dailyReward: number
  firstShareReward: number
  firstShareAwarded: boolean
  canShare: boolean
  canClaimDaily: boolean
  canClaimMilestones: boolean
  claimedCount: number
  claimLimit: number
  poolClaimedCount: number
  poolClaimLimit: number
  milestones: Array<{ id: string, threshold: number, state: number, rewards: Array<CommerceItemDto & { description: string }> }>
}
interface ShareRecord { seq: string, kind: number, score: string, created_at: string, actor?: { name: string } }

const props = defineProps<{ activityId: string }>()
defineEmits<{ back: [] }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const state = ref<ShareRewardState | null>(null)
const busy = ref(false)
const records = ref<ShareRecord[]>([])
const logTab = ref(1)
const logsOpen = ref(false)
const rewardDetails = ref<Record<string, boolean>>({})
const brokenImages = ref<Record<string, boolean>>({})
let sequence = 0
const readyTiers = computed(() => state.value?.milestones.filter(tier => tier.state === 2).length || 0)
const nextTier = computed(() => state.value?.milestones.find(tier => tier.threshold > state.value!.score))
/** 概览进度：从上一档门槛到下一档门槛；全部解锁后满格。 */
const tierProgress = computed(() => {
  const current = state.value
  if (!current)
    return 0
  const next = nextTier.value
  if (!next)
    return 100
  const previous = [...current.milestones].reverse().find(tier => tier.threshold <= current.score)?.threshold || 0
  return Math.max(0, Math.min(100, (current.score - previous) / Math.max(1, next.threshold - previous) * 100))
})
const period = computed(() => state.value ? `${date(state.value.startTime)} – ${date(state.value.endTime)}` : '')
const daysLeft = computed(() => {
  if (!state.value?.active)
    return ''
  const left = Math.ceil((state.value.endTime - Date.now()) / 86400000)
  return left <= 0 ? '今天结束' : `还剩 ${left} 天`
})

const TIER_STATE = {
  2: { label: '可领取', tone: 'ready' },
  3: { label: '已领取', tone: 'claimed' },
} as Record<number, { label: string, tone: string }>
function tierState(state: number) {
  return TIER_STATE[state] || { label: '未达成', tone: 'locked' }
}

function date(value: number) {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
function recordTime(entry: ShareRecord) {
  return new Date(Number(entry.created_at) * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function recordLabel(entry: ShareRecord) {
  if (entry.kind === 3)
    return '分享快乐包'
  if (entry.kind === 4)
    return '领取今日快乐值'
  if (entry.kind === 1)
    return `领取${entry.actor?.name || '好友'}的快乐包`
  if (entry.kind === 2)
    return `${entry.actor?.name || '好友'}领取了我的快乐包`
  return '快乐值记录'
}
async function request(action = '') {
  const accountId = String(currentAccountId.value || '')
  const activityId = props.activityId
  if (!accountId || !activityId || busy.value)
    return
  const version = ++sequence
  busy.value = true
  try {
    const url = `/api/activities/share-reward/${encodeURIComponent(activityId)}${action ? `/${action}` : ''}`
    const options = { headers: { 'x-account-id': accountId }, skipErrorToast: true } as any
    const response = action ? await api.post(url, { tab: logTab.value }, options) : await api.get(url, options)
    if (version !== sequence)
      return
    if (!response.data?.ok)
      throw new Error(response.data?.error || '活动请求失败')
    const data = response.data.data
    const next = action ? data.activity : data
    if (next && String(next.id) !== activityId)
      throw new Error('活动回包不匹配，请重新加载')
    state.value = next
    if (action === 'logs')
      records.value = data.result.logs || []
    if (action && action !== 'logs') {
      const rewards = (data.rewards || []).map((item: CommerceItemDto) => `${item.name} ×${item.count}`).join('、')
      const message = rewards || (data.result?.granted_score ? `获得 ${data.result.granted_score} 快乐值` : '领取成功')
      if (data.refreshRequired)
        toast.warning(`${message}。请刷新确认最新进度`)
      else toast.success(message)
    }
  }
  catch (cause: any) {
    if (version === sequence) {
      toast.error(cause?.response?.data?.error || cause?.message || '加载失败，请刷新重试')
      if (action)
        state.value = null
    }
  }
  finally {
    if (version === sequence)
      busy.value = false
  }
}
function switchLogTab(tab: number) {
  logTab.value = tab
  records.value = []
  void request('logs')
}
function toggleLogs() {
  logsOpen.value = !logsOpen.value
  if (logsOpen.value)
    void request('logs')
}
watch([currentAccountId, () => props.activityId], () => {
  sequence++
  busy.value = false
  state.value = null
  records.value = []
  logTab.value = 1
  logsOpen.value = false
  rewardDetails.value = {}
  void request()
}, { immediate: true })
onUnmounted(() => sequence++)
</script>

<template>
  <section class="share-page">
    <header class="share-head">
      <NButton secondary circle title="返回活动列表" aria-label="返回活动列表" @click="$emit('back')">
        <template #icon>
          <span class="i-carbon-arrow-left" />
        </template>
      </NButton>
      <div class="share-head__title">
        <h2>{{ state?.title || '快乐不独享' }}</h2>
        <p v-if="state">
          <span class="i-carbon-calendar" aria-hidden="true" />{{ period }}
          <span v-if="daysLeft" class="share-head__badge">{{ daysLeft }}</span>
          <span v-else-if="!state.active" class="share-head__badge is-ended">已结束</span>
        </p>
      </div>
      <NButton secondary circle :loading="busy" title="刷新活动数据" aria-label="刷新活动数据" @click="request()">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </header>

    <main>
      <EmptyState
        v-if="!currentAccountId || !state"
        :title="!currentAccountId ? '请先选择账号' : busy ? '正在读取活动进度' : '暂未获取到活动数据'"
        :icon="busy ? 'i-svg-spinners-90-ring-with-bg' : 'i-carbon-gift'"
      >
        <NButton v-if="currentAccountId && !busy" secondary @click="request()">
          重新加载
        </NButton>
      </EmptyState>

      <div v-else class="share-content">
        <BookOverview
          title="我的快乐值"
          icon="i-carbon-face-satisfied"
          :badge-value="state.score"
          badge-label="快乐值"
          :caption="readyTiers ? `${readyTiers} 档奖励可领取` : `共 ${state.milestones.length} 档奖励`"
          :progress-text="nextTier ? `${state.score} / ${nextTier.threshold}` : ''"
          :percent="tierProgress"
          :hint="nextTier ? `再攒 ${nextTier.threshold - state.score} 点解锁 ${nextTier.threshold} 档` : '全部档位都已解锁'"
        >
          <template v-if="readyTiers" #actions>
            <NButton type="primary" :loading="busy" :disabled="!state.canClaimMilestones" @click="request('milestones')">
              领取档位奖励（{{ readyTiers }}）
            </NButton>
          </template>
        </BookOverview>

        <div class="share-tasks">
          <article class="share-task">
            <span class="share-task__icon"><span class="i-carbon-share" /></span>
            <div class="share-task__main">
              <strong>每日分享</strong>
              <span>首次分享得 {{ state.firstShareReward }} 快乐值 · 快乐包已被领 {{ state.poolClaimedCount }}/{{ state.poolClaimLimit }}</span>
            </div>
            <NButton :type="state.canShare ? 'primary' : 'default'" :secondary="!state.canShare" :disabled="busy || !state.canShare" @click="request('share')">
              {{ state.firstShareAwarded ? '今日已分享' : '分享' }}
            </NButton>
          </article>
          <article class="share-task">
            <span class="share-task__icon"><span class="i-carbon-gift" /></span>
            <div class="share-task__main">
              <strong>好友快乐包</strong>
              <span>每日可领 +{{ state.dailyReward }} 快乐值 · 今日已领 {{ state.claimedCount }}/{{ state.claimLimit }}</span>
            </div>
            <NButton :type="state.canClaimDaily ? 'primary' : 'default'" :secondary="!state.canClaimDaily" :disabled="busy || !state.canClaimDaily" @click="request('daily')">
              {{ state.canClaimDaily ? '领取' : '已领取' }}
            </NButton>
          </article>
        </div>

        <section class="share-section" aria-labelledby="share-tiers-title">
          <h3 id="share-tiers-title" class="share-section__title">
            档位奖励<small>{{ state.milestones.length }}</small>
          </h3>
          <ol class="tier-list" :style="{ '--tier-rows': Math.ceil(state.milestones.length / 2) }">
            <li v-for="tier in state.milestones" :key="tier.id" class="tier-row" :class="`is-${tierState(tier.state).tone}`">
              <div class="tier-row__threshold">
                <b>{{ tier.threshold }}</b><small>快乐值</small>
              </div>
              <div class="tier-row__rewards">
                <NPopover v-for="item in tier.rewards" :key="item.id" v-model:show="rewardDetails[`${tier.id}-${item.id}`]" trigger="click" :show-arrow="false">
                  <template #trigger>
                    <button type="button" class="tier-reward" :title="`${item.name} ×${item.count}`" :aria-label="`查看${item.name}说明`" :aria-expanded="!!rewardDetails[`${tier.id}-${item.id}`]" @keydown.esc="rewardDetails[`${tier.id}-${item.id}`] = false">
                      <span class="tier-reward__well"><img v-if="item.image && !brokenImages[item.image]" :src="item.image" alt="" @error="brokenImages[item.image] = true"><span v-else class="i-carbon-image" aria-hidden="true" /></span>
                      <span class="tier-reward__name">{{ item.name }}</span>
                      <b>×{{ item.count }}</b>
                    </button>
                  </template>
                  <div class="reward-description" @keydown.esc="rewardDetails[`${tier.id}-${item.id}`] = false">
                    <strong>{{ item.name }} ×{{ item.count }}</strong>
                    <p v-if="item.description">
                      {{ item.description }}
                    </p>
                  </div>
                </NPopover>
              </div>
              <span class="tier-row__state">
                <span v-if="tier.state === 3" class="i-carbon-checkmark" aria-hidden="true" />
                <span v-else-if="tier.state !== 2" class="i-carbon-locked" aria-hidden="true" />
                {{ tierState(tier.state).label }}
              </span>
            </li>
          </ol>
        </section>

        <section class="share-section">
          <button type="button" class="share-section__title share-section__toggle" :aria-expanded="logsOpen" aria-controls="share-logs" @click="toggleLogs">
            领取日志
            <span class="share-section__chevron i-carbon-chevron-down" :class="{ 'is-open': logsOpen }" aria-hidden="true" />
          </button>
          <div v-if="logsOpen" id="share-logs" class="share-logs">
            <NTabs :value="logTab" type="segment" size="small" class="share-logs__tabs" @update:value="switchLogTab">
              <NTab :name="1" :disabled="busy">
                我领取的
              </NTab>
              <NTab :name="0" :disabled="busy">
                领取我的
              </NTab>
            </NTabs>
            <ul v-if="records.length" class="share-records">
              <li v-for="entry in records" :key="`${entry.seq}-${entry.kind}`">
                <span>{{ recordLabel(entry) }}</span>
                <time>{{ recordTime(entry) }}</time>
                <b>+{{ entry.score }}</b>
              </li>
            </ul>
            <p v-else class="share-logs__empty">
              {{ busy ? '正在读取记录…' : '暂无记录' }}
            </p>
          </div>
        </section>
      </div>
    </main>
  </section>
</template>

<style scoped>
.share-page {
  display: flex;
  flex-direction: column;
}

.share-head {
  display: flex;
  width: 100%;
  flex-shrink: 0;
  margin: 0 auto;
  align-items: center;
  gap: 12px;
  padding: 14px 4px 12px;
  border-bottom: 1px solid var(--ui-border);
}

.share-head__title {
  min-width: 0;
  flex: 1;
}

.share-head__title h2 {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-head__title p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.share-head__badge {
  padding: 0 7px;
  border-radius: 999px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 11px;
  line-height: 18px;
}

.share-head__badge.is-ended {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.share-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0 auto;
  padding: 16px 0 32px;
  container: share-content / inline-size;
}

.share-tasks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.share-task {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 18px 24px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
}

.share-task__icon {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 10px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 18px;
}

.share-task__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.share-task__main strong {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.share-task__main span {
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

.share-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.share-section__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.share-section__title small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
}

.share-section__toggle {
  align-self: flex-start;
  align-items: center;
  padding: 4px 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.share-section__toggle:hover {
  color: var(--ui-primary);
}

.share-section__toggle:focus-visible,
.tier-reward:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
  border-radius: 6px;
}

.share-section__chevron {
  color: var(--ui-subtle);
  transition: transform var(--spring-drag-duration) var(--spring-drag);
}

.share-section__chevron.is-open {
  transform: rotate(180deg);
}

/* 档位奖励：每档一张卡片。宽屏两列，按列排序（左列先走完再到右列），上下读仍是递增进度。 */
.tier-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

@container share-content (min-width: 960px) {
  .tier-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: repeat(var(--tier-rows), auto);
    grid-auto-flow: column;
    column-gap: 12px;
  }
}

.tier-row {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr) 80px;
  align-items: center;
  gap: 16px;
  padding: 14px 24px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.tier-row.is-ready {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  background: var(--ui-primary-soft);
}

.tier-row.is-claimed {
  opacity: 0.55;
}

.tier-row__threshold {
  display: flex;
  flex-direction: column;
}

.tier-row__threshold b {
  color: var(--ui-ink);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.tier-row__threshold small {
  color: var(--ui-subtle);
  font-size: 11px;
}

.tier-row__rewards {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.tier-reward {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 3px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-strong);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease;
}

.tier-reward:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
}

.tier-reward__well {
  display: grid;
  width: 26px;
  height: 26px;
  flex: none;
  place-items: center;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.tier-reward__well > span {
  color: var(--ui-subtle);
  font-size: 13px;
}

.tier-reward__well img {
  width: 80%;
  height: 80%;
  object-fit: contain;
}

.tier-reward__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tier-reward b {
  flex: none;
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.tier-row__state {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  color: var(--ui-subtle);
  font-size: 12px;
  white-space: nowrap;
}

.tier-row.is-ready .tier-row__state {
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}

.reward-description {
  max-width: min(280px, calc(100vw - 56px));
  font-size: 13px;
  line-height: 1.6;
}

.reward-description p {
  margin: 6px 0 0;
  color: var(--ui-muted);
  white-space: pre-line;
}

.share-logs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 24px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
}

.share-logs__tabs {
  max-width: 260px;
}

.share-records {
  margin: 0;
  padding: 0;
  list-style: none;
}

.share-records li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 56px;
  align-items: center;
  gap: 12px;
  padding: 9px 0;
  font-size: 13px;
}

.share-records li + li {
  border-top: 1px solid var(--ui-border);
}

.share-records span {
  overflow: hidden;
  color: var(--ui-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-records time {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.share-records b {
  color: var(--ui-primary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.share-logs__empty {
  margin: 0;
  padding: 12px 0;
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 720px) {
  .share-tasks {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .tier-row {
    grid-template-columns: 56px minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    padding: 16px;
  }

  .tier-row__threshold {
    padding-top: 6px;
  }

  .tier-row__rewards {
    gap: 8px;
  }

  .tier-row__state {
    grid-column: 2;
    justify-content: flex-start;
    padding-top: 10px;
    border-top: 1px solid var(--ui-border);
    line-height: 18px;
  }

  .share-task {
    grid-template-columns: 36px minmax(0, 1fr);
    padding: 16px;
  }

  .share-logs {
    padding: 14px 16px;
  }

  .share-task > :deep(.n-button) {
    grid-column: 1 / -1;
  }

  .share-records li {
    grid-template-columns: minmax(0, 1fr) 48px;
  }

  .share-records time {
    grid-column: 1;
    grid-row: 2;
    margin-top: -6px;
  }
}
</style>
