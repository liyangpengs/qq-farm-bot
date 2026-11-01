<script setup lang="ts">
import type { CommerceItemDto } from '@/stores/commerce'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
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
  milestones: Array<{ id: string, threshold: number, state: number, rewards: CommerceItemDto[] }>
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
let sequence = 0
const readyTiers = computed(() => state.value?.milestones.filter(tier => tier.state === 2).length || 0)
const nextTier = computed(() => state.value?.milestones.find(tier => tier.threshold > state.value!.score))
// 档位门槛间距不均匀：刻度等距排在每列中心，相邻刻度之间再按快乐值线性插值
const trackFill = computed(() => {
  const tiers = state.value?.milestones || []
  const score = state.value?.score || 0
  let previous = 0
  for (const [index, tier] of tiers.entries()) {
    if (score < tier.threshold) {
      const from = index ? (index - 0.5) / tiers.length : 0
      const to = (index + 0.5) / tiers.length
      return (from + (to - from) * (score - previous) / Math.max(1, tier.threshold - previous)) * 100
    }
    previous = tier.threshold
  }
  return tiers.length ? 100 : 0
})
const period = computed(() => state.value ? `${date(state.value.startTime)} — ${date(state.value.endTime)}` : '')

function date(value: number) {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
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
function toggleLogs(event: Event) {
  if ((event.target as HTMLDetailsElement).open)
    void request('logs')
}
watch([currentAccountId, () => props.activityId], () => {
  sequence++
  busy.value = false
  state.value = null
  records.value = []
  logTab.value = 1
  void request()
}, { immediate: true })
onUnmounted(() => sequence++)
</script>

<template>
  <ActivityShell class="share-shell" theme="day">
    <div class="share-reward">
      <ActivityHeader :title="state?.title || '快乐不独享'" :remaining="state?.active ? period : state ? '活动已结束' : ''" :loading="busy" show-refresh @back="$emit('back')" @refresh="request()" />
      <main class="share-scroll">
        <div v-if="!currentAccountId || !state" class="empty">
          <span :class="busy ? 'i-carbon-renew animate-spin' : 'i-carbon-gift'" />
          <strong>{{ !currentAccountId ? '请先选择账号' : busy ? '正在读取活动进度' : '暂未获取到活动数据' }}</strong>
          <button v-if="currentAccountId && !busy" class="g-btn" @click="request()">
            重新加载
          </button>
        </div>
        <div v-else class="content">
          <section class="board">
            <div class="score-pill">
              我的快乐值：<img :src="state.icon" alt=""><b>{{ state.score }}</b>
            </div>
            <p class="hint">
              {{ nextTier ? `再攒 ${nextTier.threshold - state.score} 点，解锁 ${nextTier.threshold} 档奖励` : '全部档位都已解锁' }}
            </p>

            <div class="ladder" :style="{ '--tiers': state.milestones.length || 1 }">
              <div v-for="tier in state.milestones" :key="tier.id" class="ladder__col" :class="{ ready: tier.state === 2, claimed: tier.state === 3 }">
                <span v-if="tier.state === 2" class="ladder__tag">可领取</span>
                <div v-for="item in tier.rewards" :key="item.id" class="item" :title="`${item.name} ×${item.count}`">
                  <span class="item-box">
                    <CommerceItemImage :src="item.image" :alt="item.name" />
                    <b>{{ item.count }}</b>
                    <span v-if="tier.state !== 2" class="item-box__badge" :aria-label="tier.state === 3 ? '已领取' : '未达成'"><span :class="tier.state === 3 ? 'i-carbon-checkmark' : 'i-carbon-locked'" /></span>
                  </span>
                  <span class="item__name">{{ item.name }}</span>
                </div>
                <i class="ladder__arrow" aria-hidden="true" />
              </div>
              <div class="ladder__track" role="progressbar" :aria-valuenow="state.score" aria-valuemin="0" :aria-valuemax="state.milestones[state.milestones.length - 1]?.threshold || 0" aria-label="快乐值档位进度">
                <span :style="{ width: `${trackFill}%` }" />
              </div>
              <b v-for="tier in state.milestones" :key="`v-${tier.id}`" class="ladder__value">{{ tier.threshold }}</b>
            </div>

            <div v-if="readyTiers" class="actions">
              <button class="g-btn g-btn--wide" :disabled="busy || !state.canClaimMilestones" @click="request('milestones')">
                领取档位奖励（{{ readyTiers }}）
              </button>
            </div>

            <div class="duo">
              <div class="duo__item">
                <span class="bubble">快乐包已被领 {{ state.poolClaimedCount }}/{{ state.poolClaimLimit }}</span>
                <button class="g-btn" :disabled="busy || !state.canShare" @click="request('share')">
                  <template v-if="state.firstShareAwarded">
                    今日已分享
                  </template>
                  <template v-else>
                    每日分享得<img :src="state.icon" alt="快乐值">{{ state.firstShareReward }}
                  </template>
                </button>
              </div>
              <div class="duo__item">
                <span class="bubble">好友快乐包今日已领 {{ state.claimedCount }}/{{ state.claimLimit }}</span>
                <button class="g-btn g-btn--brown" :disabled="busy || !state.canClaimDaily" @click="request('daily')">
                  {{ state.canClaimDaily ? `领取今日快乐 +${state.dailyReward}` : '今日快乐已领取' }}
                </button>
              </div>
            </div>
          </section>

          <details class="board board--fold" @toggle="toggleLogs">
            <summary>领取日志</summary>
            <div class="log-tabs" role="tablist">
              <button role="tab" :aria-selected="logTab === 1" :disabled="busy" @click="switchLogTab(1)">
                我领取的
              </button><button role="tab" :aria-selected="logTab === 0" :disabled="busy" @click="switchLogTab(0)">
                领取我的
              </button>
            </div>
            <ul class="records">
              <li v-for="entry in records" :key="`${entry.seq}-${entry.kind}`">
                <span>{{ recordLabel(entry) }}<time>{{ new Date(Number(entry.created_at) * 1000).toLocaleString('zh-CN') }}</time></span><b>+{{ entry.score }}</b>
              </li>
            </ul>
            <p v-if="!records.length" class="hint">
              {{ busy ? '正在读取记录…' : '暂无记录' }}
            </p>
          </details>
        </div>
      </main>
    </div>
  </ActivityShell>
</template>

<style scoped>
.activity-shell.share-shell {
  flex: 1 1 0;
  height: auto;
  min-height: 0;
}
.share-reward {
  --wood: #9a6438;
  --wood-dark: #5e3a1f;
  --paper: #fbf3e2;
  --paper-hi: #fffaf0;
  --ink: #4b301b;
  --muted: #7d5c40;
  --orange: #f5a23a;
  height: 100%;
  color: var(--ink);
  background: linear-gradient(180deg, #f7ecdc 0%, #efdfc8 100%);
}
.share-scroll {
  position: absolute;
  inset: calc(86px + env(safe-area-inset-top)) 0 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
@media (max-width: 900px) {
  .share-scroll {
    top: calc(72px + env(safe-area-inset-top));
  }
}
.content {
  max-width: 680px;
  margin: 0 auto;
  padding: 22px 18px 44px;
  display: grid;
  gap: 22px;
}
.hint {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 14px;
  text-align: center;
}

/* 纸面面板 */
.board {
  padding: 22px 22px 26px;
  border: 4px solid var(--wood);
  border-radius: 22px;
  background: var(--paper);
  box-shadow:
    inset 0 0 0 3px #f3ddb0,
    0 6px 0 var(--wood-dark),
    0 16px 24px -12px rgba(70, 40, 15, 0.42);
}
.score-pill {
  width: fit-content;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 auto;
  padding: 5px 28px;
  border-radius: 999px;
  color: #5a2e0d;
  background: linear-gradient(180deg, #ffcf74, var(--orange));
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.5),
    inset 0 -3px 0 rgba(200, 100, 20, 0.35);
  font-size: 17px;
  font-weight: var(--fw-900);
}
.score-pill img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}
.score-pill b {
  margin-left: 4px;
  color: #ffe54a;
  font-size: 26px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  text-shadow:
    1.5px 0 0 #7a3d0c,
    -1.5px 0 0 #7a3d0c,
    0 1.5px 0 #7a3d0c,
    0 -1.5px 0 #7a3d0c,
    0 2.5px 0 #7a3d0c;
}

/* 档位 */
.ladder {
  display: grid;
  grid-template-columns: repeat(var(--tiers), minmax(0, 1fr));
  column-gap: 8px;
  margin-top: 20px;
  padding: 0 4px;
}
.ladder__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
}
.ladder__tag {
  padding: 1px 8px;
  border-radius: 999px;
  color: #fff;
  background: #e8731f;
  font-size: 11px;
  font-weight: var(--fw-900);
}
.item {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.item__name {
  max-width: 100%;
  display: -webkit-box;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.35;
  text-align: center;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.item-box {
  position: relative;
  width: 62px;
  height: 62px;
  display: grid;
  place-items: center;
  border: 3px solid #8d7c6c;
  border-radius: 13px;
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
  font-size: 12px;
  font-weight: var(--fw-900);
  text-shadow:
    1.5px 0 0 var(--wood-dark),
    -1.5px 0 0 var(--wood-dark),
    0 1.5px 0 var(--wood-dark),
    0 -1.5px 0 var(--wood-dark);
}
.item-box__badge {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 2px solid var(--paper-hi);
  border-radius: 50%;
  color: #fff;
  background: #9b8f84;
  font-size: 12px;
}
.ready .item-box {
  border-color: #e0891f;
  background: linear-gradient(180deg, #fff6d0, #ffe08a);
  box-shadow:
    inset 0 0 0 2px #fffaf0,
    0 0 0 4px rgba(255, 190, 70, 0.45);
}
.claimed .item-box :deep(.item-image) {
  opacity: 0.5;
}
.claimed .item-box__badge {
  background: #6aa84f;
}
.ladder__arrow {
  width: 0;
  height: 0;
  border-top: 7px solid var(--wood-dark);
  border-right: 6px solid transparent;
  border-left: 6px solid transparent;
}
.ladder__track {
  grid-column: 1 / -1;
  height: 16px;
  margin-top: 4px;
  overflow: hidden;
  border: 3px solid var(--wood-dark);
  border-radius: 999px;
  background: #e9dcc0;
}
.ladder__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(180deg, #ffd35c, #f59a2b);
  transition: width 0.3s ease;
}
.ladder__value {
  margin-top: 6px;
  font-size: 15px;
  font-weight: var(--fw-900);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* 按钮 */
.g-btn {
  min-height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 18px;
  border: 3px solid var(--wood-dark);
  border-radius: 999px;
  color: #5a3214;
  background: linear-gradient(180deg, #ffe58e, #ffc847);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.65),
    inset 0 -4px 0 rgba(214, 128, 26, 0.45),
    0 4px 0 var(--wood-dark);
  font: inherit;
  font-size: 17px;
  font-weight: var(--fw-900);
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.08s ease;
}
.g-btn img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.g-btn--brown {
  color: #fff4dc;
  background: linear-gradient(180deg, #b77a4b, #91572d);
  box-shadow:
    inset 0 2px 0 rgba(255, 220, 170, 0.4),
    inset 0 -4px 0 rgba(70, 35, 10, 0.35),
    0 4px 0 var(--wood-dark);
  text-shadow: 0 1px 0 rgba(70, 35, 10, 0.6);
}
.g-btn--wide {
  min-width: min(300px, 100%);
}
.g-btn:active:not(:disabled) {
  box-shadow: 0 1px 0 var(--wood-dark);
  transform: translateY(3px);
}
.g-btn:disabled {
  border-color: #7c736a;
  color: #6f665d;
  background: linear-gradient(180deg, #d8d1c6, #bdb5aa);
  box-shadow: 0 4px 0 #7c736a;
  text-shadow: none;
  cursor: not-allowed;
}
.g-btn:disabled img {
  filter: grayscale(1);
  opacity: 0.6;
}
button:focus-visible,
summary:focus-visible {
  outline: 3px solid #f0a33a;
  outline-offset: 3px;
}
.actions {
  display: flex;
  justify-content: center;
  margin-top: 22px;
}
.duo {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 26px;
}
.duo__item {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bubble {
  position: relative;
  align-self: center;
  padding: 4px 14px;
  border: 2px solid #e2cfa6;
  border-radius: 999px;
  background: var(--paper-hi);
  font-size: 13px;
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
}
.bubble::after {
  content: '';
  position: absolute;
  bottom: -8px;
  left: 50%;
  border-top: 7px solid #e2cfa6;
  border-right: 6px solid transparent;
  border-left: 6px solid transparent;
  transform: translateX(-50%);
}

/* 日志 */
.board--fold {
  padding: 0;
}
.board--fold summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 22px;
  font-size: 16px;
  font-weight: var(--fw-900);
  list-style: none;
  cursor: pointer;
}
.board--fold summary::-webkit-details-marker {
  display: none;
}
.board--fold summary::before,
.board--fold summary::after {
  content: '';
  flex: 1;
  border-top: 2px dashed rgba(94, 58, 31, 0.4);
}
.log-tabs {
  display: flex;
  justify-content: center;
  gap: 10px;
  padding: 0 22px;
}
.log-tabs button {
  padding: 5px 18px;
  border: 2px solid #c9ab7e;
  border-radius: 999px;
  color: var(--muted);
  background: var(--paper-hi);
  font: inherit;
  font-size: 13px;
  font-weight: var(--fw-700);
  cursor: pointer;
}
.log-tabs button[aria-selected='true'] {
  border-color: var(--wood-dark);
  color: #5a2e0d;
  background: linear-gradient(180deg, #ffe58e, #ffc847);
}
.records {
  margin: 10px 0 0;
  padding: 0 22px;
  list-style: none;
}
.records li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 2px;
  border-bottom: 1.5px dashed rgba(94, 58, 31, 0.22);
  font-size: 15px;
}
.records li:last-child {
  border-bottom: 0;
}
.records time {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}
.records b {
  flex: none;
  color: #c76a14;
  font-size: 16px;
}
.board--fold .hint {
  padding: 4px 22px 20px;
}
.board--fold[open] {
  padding-bottom: 12px;
}

.empty {
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  color: var(--muted);
}
.empty > span {
  font-size: 36px;
}
@media (prefers-reduced-motion: no-preference) {
  .ready .item-box {
    animation: share-glow 1.6s ease-in-out infinite;
  }
}
@keyframes share-glow {
  50% {
    box-shadow:
      inset 0 0 0 2px #fffaf0,
      0 0 0 7px rgba(255, 190, 70, 0.25);
  }
}
@media (max-width: 600px) {
  .content {
    padding: 14px 10px 32px;
    gap: 16px;
  }
  .board {
    padding: 18px 12px 22px;
    border-radius: 18px;
  }
  .ladder {
    column-gap: 3px;
    padding: 0;
  }
  .item-box {
    width: 48px;
    height: 48px;
    border-width: 2px;
    border-radius: 10px;
  }
  .item__name {
    display: none;
  }
  .duo {
    grid-template-columns: 1fr;
    gap: 18px;
  }
}
</style>
