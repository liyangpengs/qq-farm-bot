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

interface ActivityState {
  title: string
  active: boolean
  startTime: number
  endTime: number
  rules: string[]
  remaining?: number
  day?: number
  choices?: Array<{ id: number, name: string }>
  rewardDays?: Array<{ day: number, reward: CommerceItemDto }>
  pending?: { chooseId: number, text: string, rewards: CommerceItemDto[] } | null
  canDraw?: boolean
  canClaim?: boolean
  score?: number
  dailyReward?: number
  firstShareReward?: number
  firstShareAwarded?: boolean
  canClaimDaily?: boolean
  canClaimMilestones?: boolean
  claimedCount?: number
  claimLimit?: number
  poolClaimedCount?: number
  poolClaimLimit?: number
  milestones?: Array<{ id: string, threshold: number, state: number, rewards: CommerceItemDto[] }>
}
const props = defineProps<{ kind: 'wish' | 'happy' }>()
defineEmits<{ back: [] }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const state = ref<ActivityState | null>(null)
const busy = ref(false)
const choice = ref(1)
const group = ref(0)
const logTab = ref(1)
const records = ref<Array<{ seq: string, kind: number, score: string, created_at: string, actor?: { name: string } }>>([])
const now = ref(Date.now())
const clock = window.setInterval(() => now.value = Date.now(), 60000)
let sequence = 0
const choiceIcons: Record<number, string> = {
  1: 'i-carbon-currency',
  2: 'i-carbon-favorite',
  3: 'i-carbon-rocket',
  4: 'i-carbon-home',
  5: 'i-carbon-sprout',
  6: 'i-carbon-user-multiple',
}
const title = computed(() => props.kind === 'wish' ? '秋祈良愿' : '快乐不独享')
const tagline = computed(() => props.kind === 'wish' ? '把心愿交给秋天' : '小小快乐，一起收集')
const intro = computed(() => props.kind === 'wish' ? '每天选一个心愿方向抽一支签，签文附带的好运奖励可直接领取。' : '每日领取、分享快乐包攒快乐值，达到档位即可领取奖励。')
const choices = computed(() => (state.value?.choices || []).slice(group.value * 3, group.value * 3 + 3))
const nextTier = computed(() => state.value?.milestones?.find(v => v.threshold > (state.value?.score || 0)))
// 档位门槛间距不均匀：轨道上的圆点等距排布，相邻圆点之间再按快乐值线性插值
const trackFill = computed(() => {
  const tiers = state.value?.milestones || []
  const score = state.value?.score || 0
  const span = tiers.length - 0.5
  let previous = 0
  for (const [index, tier] of tiers.entries()) {
    if (score < tier.threshold) {
      const from = index ? (index - 0.5) / span : 0
      const to = (index + 0.5) / span
      return (from + (to - from) * (score - previous) / Math.max(1, tier.threshold - previous)) * 100
    }
    previous = tier.threshold
  }
  return tiers.length ? 100 : 0
})
const maxThreshold = computed(() => Math.max(0, ...(state.value?.milestones || []).map(v => v.threshold)))
const readyTiers = computed(() => (state.value?.milestones || []).filter(v => v.state === 2).length)
const dates = computed(() => state.value ? `${formatDate(state.value.startTime)} — ${formatDate(state.value.endTime)}` : '')
const remainingText = computed(() => {
  if (!state.value)
    return ''
  if (!state.value.active)
    return state.value.startTime > now.value ? '活动未开始' : '活动已结束'
  const hours = Math.max(0, Math.ceil((state.value.endTime - now.value) / 3600000))
  return `剩余 ${Math.floor(hours / 24)} 天 ${hours % 24} 时`
})
const wishHint = computed(() => {
  if (state.value?.canDraw)
    return '挑一个方向，抽取今日签文'
  return state.value?.active ? '今日心愿已送达，明天再来' : '活动尚未开放或已经结束'
})

function formatDate(value: number) {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
function formatRecordTime(value: string) {
  return new Date(Number(value) * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function tierLabel(value: number) {
  return value === 3 ? '已领取' : value === 2 ? '可领取' : '未达成'
}
function tierClass(value: number) {
  return value === 3 ? 'claimed' : value === 2 ? 'ready' : 'locked'
}
function recordLabel(entry: { kind: number, actor?: { name: string } }) {
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
function switchGroup() {
  group.value = 1 - group.value
  choice.value = group.value * 3 + 1
}
function switchLogTab(tab: number) {
  logTab.value = tab
  void request('logs')
}
function onLogsToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !records.value.length && !busy.value)
    void request('logs')
}

async function request(action = '') {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || busy.value)
    return
  const version = ++sequence
  busy.value = true
  try {
    const url = `/api/activities/autumn/${props.kind}${action ? `/${action}` : ''}`
    const options = { headers: { 'x-account-id': accountId }, skipErrorToast: true } as any
    const response = action ? await api.post(url, { chooseId: choice.value, tab: logTab.value }, options) : await api.get(url, options)
    if (version !== sequence)
      return
    if (!response.data?.ok)
      throw new Error(response.data?.error || '活动请求失败')
    const data = response.data.data
    state.value = action ? data.activity : data
    if (action === 'logs')
      records.value = data.result.logs || []
    if (action && action !== 'logs') {
      const rewards = (data.rewards || []).map((v: CommerceItemDto) => `${v.name} ×${v.count}`).join('、')
      const message = rewards || (data.result?.granted_score ? `获得 ${data.result.granted_score} 快乐值` : action === 'draw' ? '签文已揭晓，请领取好运奖励' : '操作已完成')
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

watch([currentAccountId, () => props.kind], () => {
  sequence++
  busy.value = false
  state.value = null
  records.value = []
  logTab.value = 1
  choice.value = 1
  group.value = 0
  void request()
}, { immediate: true })
onUnmounted(() => {
  sequence++
  window.clearInterval(clock)
})
</script>

<template>
  <ActivityShell theme="day">
    <div class="autumn" :class="`autumn--${kind}`">
      <ActivityHeader
        :title="state?.title || title"
        :remaining="remainingText"
        :loading="busy"
        show-refresh
        @back="$emit('back')"
        @refresh="request()"
      />

      <main class="autumn-scroll">
        <div v-if="!currentAccountId" class="autumn-state">
          <span class="autumn-state__icon i-carbon-user-avatar" />
          <strong>请先选择账号</strong>
          <small>活动数据按当前账号加载</small>
        </div>
        <div v-else-if="!state" class="autumn-state">
          <div v-if="busy" class="autumn-spinner" />
          <span v-else class="autumn-state__icon i-carbon-cloud-offline" />
          <strong>{{ busy ? '正在读取活动进度' : '暂未获取到活动数据' }}</strong>
          <button v-if="!busy" type="button" class="btn btn--ghost" @click="request()">
            <span class="i-carbon-renew" />重新加载
          </button>
        </div>

        <div v-else class="autumn-body">
          <section class="hero">
            <div class="hero__art">
              <img :src="`/activity-assets/autumn/${kind}.png`" alt="" width="84" height="84">
            </div>
            <div class="hero__copy">
              <span class="hero__eyebrow">2026 秋 · 限时活动 · {{ dates }}</span>
              <h2>{{ tagline }}</h2>
              <p>{{ intro }}</p>
            </div>
            <dl class="hero__stats">
              <template v-if="kind === 'wish'">
                <div><dt>活动进行</dt><dd>第<b>{{ state.day ?? '-' }}</b>天</dd></div>
                <div><dt>今日可祈愿</dt><dd><b>{{ state.remaining ?? 0 }}</b>次</dd></div>
              </template>
              <template v-else>
                <div><dt>我的快乐值</dt><dd><b>{{ state.score ?? 0 }}</b></dd></div>
                <div><dt>可领档位</dt><dd><b>{{ readyTiers }}</b>档</dd></div>
              </template>
            </dl>
          </section>

          <template v-if="kind === 'wish'">
            <section class="panel">
              <header class="panel__head">
                <div>
                  <h3>{{ state.pending ? '今日签文' : '今日祈愿' }}</h3>
                  <p>{{ state.pending ? '签文已揭晓，领取奖励后今天的祈愿就完成了' : wishHint }}</p>
                </div>
                <span class="tag" :class="{ 'tag--on': state.canDraw || state.canClaim }">
                  {{ state.pending ? (state.canClaim ? '奖励待领取' : '已完成') : state.canDraw ? '可祈愿' : '今日已完成' }}
                </span>
              </header>

              <div v-if="state.pending" class="slip">
                <span class="slip__seal" aria-hidden="true">吉</span>
                <p class="slip__text">
                  {{ state.pending.text || '好运已到，请收下这份秋日祝福。' }}
                </p>
                <ul class="slip__rewards">
                  <li v-for="item in state.pending.rewards" :key="item.id">
                    <CommerceItemImage :src="item.image" :alt="item.name" size="sm" />
                    <span>{{ item.name }}</span><b>×{{ item.count }}</b>
                  </li>
                </ul>
                <button class="btn btn--primary btn--lg" type="button" :disabled="busy || !state.canClaim" @click="request('claim')">
                  <span class="i-carbon-gift" />领取好运奖励
                </button>
              </div>

              <template v-else>
                <div class="sticks" role="radiogroup" aria-label="心愿方向">
                  <button
                    v-for="(entry, index) in choices"
                    :key="entry.id"
                    type="button"
                    role="radio"
                    class="stick"
                    :class="{ 'stick--active': choice === entry.id }"
                    :disabled="busy || !state.canDraw"
                    :aria-checked="choice === entry.id"
                    @click="choice = entry.id"
                  >
                    <small>第{{ ['一', '二', '三'][index] }}签</small>
                    <span class="stick__icon" :class="choiceIcons[entry.id] || 'i-carbon-star'" />
                    <strong>{{ entry.name }}</strong>
                    <span class="stick__mark" aria-hidden="true">{{ choice === entry.id ? '已选' : '' }}</span>
                  </button>
                </div>
                <div class="action-row">
                  <button type="button" class="btn btn--ghost" :disabled="busy || !state.canDraw" @click="switchGroup">
                    <span class="i-carbon-shuffle" />换一组方向
                  </button>
                  <button class="btn btn--primary btn--lg" type="button" :disabled="busy || !state.canDraw" @click="request('draw')">
                    <span :class="busy ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-star'" />开始祈愿
                  </button>
                </div>
              </template>
            </section>

            <section v-if="state.rewardDays?.length" class="panel">
              <header class="panel__head">
                <div>
                  <h3>每日祈愿奖励</h3>
                  <p>活动期间每天可祈愿一次，按活动天数发放对应奖励</p>
                </div>
              </header>
              <ol class="days">
                <li v-for="entry in state.rewardDays" :key="entry.day" class="day" :class="{ 'day--today': entry.day === state.day, 'day--past': entry.day < (state.day || 0) }">
                  <span class="day__label">{{ entry.day === state.day ? '今天' : `第 ${entry.day} 天` }}</span>
                  <CommerceItemImage :src="entry.reward.image" :alt="entry.reward.name" size="sm" />
                  <span class="day__name">{{ entry.reward.name }}</span>
                  <b>×{{ entry.reward.count }}</b>
                </li>
              </ol>
            </section>
          </template>

          <template v-else>
            <section class="panel">
              <header class="panel__head">
                <div>
                  <h3>快乐值进度</h3>
                  <p>{{ nextTier ? `再收集 ${nextTier.threshold - (state.score || 0)} 点快乐值，可解锁 ${nextTier.threshold} 档奖励` : '已达到全部奖励门槛' }}</p>
                </div>
                <button class="btn btn--primary" type="button" :disabled="busy || !state.canClaimMilestones" @click="request('milestones')">
                  <span class="i-carbon-gift" />{{ readyTiers ? `领取 ${readyTiers} 档奖励` : '暂无可领奖励' }}
                </button>
              </header>
              <div class="ladder" :style="{ '--tiers': state.milestones?.length || 1 }">
                <div class="ladder__track" role="progressbar" :aria-valuenow="state.score || 0" aria-valuemin="0" :aria-valuemax="maxThreshold" aria-label="快乐值档位进度">
                  <span :style="{ width: `${trackFill}%` }" />
                </div>
                <article v-for="tier in state.milestones" :key="tier.id" class="rung" :class="`rung--${tierClass(tier.state)}`">
                  <span class="rung__dot" aria-hidden="true"><span :class="tier.state === 3 ? 'i-carbon-checkmark' : tier.state === 2 ? 'i-carbon-gift' : 'i-carbon-locked'" /></span>
                  <b class="rung__value">{{ tier.threshold }}</b>
                  <ul>
                    <li v-for="item in tier.rewards" :key="item.id" :title="`${item.name} ×${item.count}`">
                      <CommerceItemImage :src="item.image" :alt="item.name" size="sm" />
                      <span>{{ item.name }}</span><em>×{{ item.count }}</em>
                    </li>
                  </ul>
                  <span class="tag" :class="{ 'tag--on': tier.state === 2 }">{{ tierLabel(tier.state) }}</span>
                </article>
              </div>
            </section>

            <section class="panel">
              <header class="panel__head">
                <div>
                  <h3>今日收集</h3>
                  <p>以下次数每日 0 点刷新</p>
                </div>
              </header>
              <div class="tasks">
                <article class="task">
                  <span class="task__icon"><span class="i-carbon-sun" /></span>
                  <div class="task__copy">
                    <strong>每日快乐值</strong>
                    <span>{{ state.canClaimDaily ? `今天可领取 ${state.dailyReward} 点` : '今天已领取，明天再来' }}</span>
                  </div>
                  <button class="btn btn--primary" type="button" :disabled="busy || !state.canClaimDaily" @click="request('daily')">
                    {{ state.canClaimDaily ? `+${state.dailyReward} 领取` : '已领取' }}
                  </button>
                </article>
                <article class="task">
                  <span class="task__icon"><span class="i-carbon-share" /></span>
                  <div class="task__copy">
                    <strong>每日首次分享</strong>
                    <span>{{ state.firstShareAwarded ? '今天的分享奖励已领取' : `分享快乐包可得 ${state.firstShareReward} 点` }}</span>
                  </div>
                  <button class="btn btn--primary" type="button" :disabled="busy || !state.active || state.firstShareAwarded" @click="request('share')">
                    {{ state.firstShareAwarded ? '已分享' : `+${state.firstShareReward} 分享` }}
                  </button>
                </article>
                <article class="task task--meter">
                  <span class="task__icon"><span class="i-carbon-user-multiple" /></span>
                  <div class="task__copy">
                    <strong>好友快乐包</strong>
                    <span>今日已领取好友的快乐包</span>
                  </div>
                  <b class="task__count">{{ state.claimedCount ?? 0 }}<small>/{{ state.claimLimit ?? 0 }}</small></b>
                </article>
                <article class="task task--meter">
                  <span class="task__icon"><span class="i-carbon-favorite" /></span>
                  <div class="task__copy">
                    <strong>我的快乐包</strong>
                    <span>今日已被好友领取</span>
                  </div>
                  <b class="task__count">{{ state.poolClaimedCount ?? 0 }}<small>/{{ state.poolClaimLimit ?? 0 }}</small></b>
                </article>
              </div>
            </section>

            <details class="panel fold" @toggle="onLogsToggle">
              <summary><span class="i-carbon-list" />快乐收集记录</summary>
              <div class="fold__body">
                <div class="segmented" role="tablist">
                  <button type="button" role="tab" :aria-selected="logTab === 1" :disabled="busy" @click="switchLogTab(1)">
                    我领取的
                  </button>
                  <button type="button" role="tab" :aria-selected="logTab === 0" :disabled="busy" @click="switchLogTab(0)">
                    领取我的
                  </button>
                </div>
                <ul v-if="records.length" class="records">
                  <li v-for="entry in records" :key="`${entry.seq}-${entry.kind}`">
                    <span>{{ recordLabel(entry) }}</span>
                    <b>+{{ entry.score }}</b>
                    <time>{{ formatRecordTime(entry.created_at) }}</time>
                  </li>
                </ul>
                <p v-else class="fold__empty">
                  {{ busy ? '正在读取记录…' : '暂无记录' }}
                </p>
              </div>
            </details>
          </template>

          <details v-if="state.rules?.length" class="panel fold">
            <summary><span class="i-carbon-information" />活动说明</summary>
            <div class="fold__body rules">
              <p v-for="(line, index) in state.rules" :key="index" :class="{ rules__title: /^【.+】$/.test(line.trim()) }">
                {{ line }}
              </p>
            </div>
          </details>
        </div>
      </main>
    </div>
  </ActivityShell>
</template>

<style scoped>
.autumn {
  --ink: #3b2f24;
  --muted: #7a6a58;
  --accent: #9a5a1c;
  --accent-deep: #7c4512;
  --accent-soft: #fbeedb;
  --line: rgba(154, 90, 28, 0.16);
  --paper: #fffcf6;
  --seal: #b8412e;
  position: relative;
  height: 100%;
  color: var(--ink);
  background:
    radial-gradient(900px 360px at 85% -8%, rgba(236, 170, 92, 0.22), transparent 70%),
    linear-gradient(180deg, #f8f1e4, #f4eee3 60%, #f3efe7);
}
.autumn--happy {
  --ink: #26352c;
  --muted: #66756b;
  --accent: #2e7650;
  --accent-deep: #215c3d;
  --accent-soft: #e5f2e6;
  --line: rgba(46, 118, 80, 0.16);
  --paper: #fffef8;
  background:
    radial-gradient(900px 360px at 85% -8%, rgba(240, 196, 84, 0.24), transparent 70%),
    linear-gradient(180deg, #f2f5e7, #f1f4ea 60%, #f2f4ee);
}
.autumn-scroll {
  position: absolute;
  inset: calc(86px + env(safe-area-inset-top)) 0 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.autumn-body {
  width: min(980px, 100%);
  margin: 0 auto;
  padding: 26px 22px 56px;
}
h2,
h3 {
  margin: 0;
  color: var(--ink);
  font-weight: var(--fw-700);
  letter-spacing: 0;
}

/* 按钮与标签 */
.btn {
  min-height: 38px;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 999px;
  font: inherit;
  font-size: 14px;
  font-weight: var(--fw-700);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}
.btn--lg {
  min-height: 44px;
  padding: 0 26px;
  font-size: 15px;
}
.btn--primary {
  color: #fff;
  background: var(--accent);
  box-shadow: 0 4px 12px -4px var(--accent);
}
.btn--primary:hover:not(:disabled) {
  background: var(--accent-deep);
}
.btn--ghost {
  border-color: var(--line);
  color: var(--accent);
  background: var(--paper);
}
.btn--ghost:hover:not(:disabled) {
  border-color: var(--accent);
}
button:disabled {
  box-shadow: none;
  cursor: not-allowed;
  opacity: 0.45;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tag {
  flex: none;
  padding: 3px 10px;
  border-radius: 999px;
  color: var(--muted);
  background: rgba(120, 110, 95, 0.1);
  font-size: 12px;
  font-weight: var(--fw-700);
  white-space: nowrap;
}
.tag--on {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 空状态 */
.autumn-state {
  height: 100%;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}
.autumn-state__icon {
  color: var(--muted);
  font-size: 34px;
  opacity: 0.6;
}
.autumn-state strong {
  font-size: 16px;
}
.autumn-state small {
  color: var(--muted);
  font-size: 13px;
}
.autumn-state .btn {
  margin-top: 8px;
}
.autumn-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: autumn-spin 0.85s linear infinite;
}
@keyframes autumn-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 头图 */
.hero {
  display: flex;
  align-items: center;
  gap: 22px;
  margin-bottom: 22px;
  padding: 4px 2px;
}
.hero__art {
  width: 104px;
  height: 104px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #fff 0%, var(--accent-soft) 72%);
  box-shadow:
    0 0 0 6px rgba(255, 255, 255, 0.6),
    0 10px 24px -12px var(--accent);
}
.hero__art img {
  object-fit: contain;
}
.hero__copy {
  min-width: 0;
  flex: 1;
}
.hero__eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: var(--fw-700);
  letter-spacing: 0.06em;
}
.hero__copy h2 {
  margin: 6px 0 8px;
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif;
  font-size: 30px;
  font-weight: var(--fw-900);
  line-height: 1.25;
  letter-spacing: 0.06em;
}
.hero__copy p {
  max-width: 440px;
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.7;
}
.hero__stats {
  display: flex;
  flex: none;
  gap: 10px;
  margin: 0;
}
.hero__stats > div {
  min-width: 110px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.72);
}
.hero__stats dt {
  color: var(--muted);
  font-size: 12px;
}
.hero__stats dd {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin: 4px 0 0;
  font-size: 13px;
}
.hero__stats b {
  color: var(--accent);
  font-size: 26px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* 面板 */
.panel {
  margin-bottom: 16px;
  padding: 22px 24px 24px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--paper);
  box-shadow:
    0 1px 2px rgba(80, 60, 30, 0.04),
    0 8px 24px -16px rgba(80, 60, 30, 0.16);
}
.panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.panel__head > div {
  min-width: 0;
}
.panel__head h3 {
  font-size: 18px;
  line-height: 1.4;
}
.panel__head p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

/* 签筒选择 */
.sticks {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 168px));
  justify-content: center;
  gap: 18px;
}
.stick {
  position: relative;
  min-height: 188px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 22px 10px 18px;
  border: 1.5px solid var(--line);
  border-radius: 84px 84px 16px 16px;
  color: var(--ink);
  font: inherit;
  background: linear-gradient(180deg, #fff, #fdf6ea);
  cursor: pointer;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}
.stick:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-3px);
}
.stick small {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.1em;
}
.stick__icon {
  color: var(--accent);
  font-size: 26px;
}
.stick strong {
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif;
  font-size: 26px;
  font-weight: var(--fw-900);
  letter-spacing: 0.16em;
  text-indent: 0.16em;
}
.stick__mark {
  min-height: 20px;
  color: var(--accent);
  font-size: 12px;
  font-weight: var(--fw-700);
}
.stick--active {
  border-color: var(--accent);
  background: linear-gradient(180deg, #fff8ec, var(--accent-soft));
  box-shadow: 0 12px 24px -14px var(--accent);
  transform: translateY(-4px);
}
.stick--active .stick__mark::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--seal);
  vertical-align: middle;
}
.action-row {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}

/* 签文 */
.slip {
  position: relative;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  margin: 0 auto;
  padding: 30px 24px 26px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background:
    repeating-linear-gradient(0deg, transparent 0 35px, rgba(154, 90, 28, 0.05) 35px 36px),
    linear-gradient(180deg, #fffaf0, #fbefd9);
  text-align: center;
}
.slip__seal {
  position: absolute;
  top: 16px;
  right: 18px;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 2px solid var(--seal);
  border-radius: 8px;
  color: var(--seal);
  font-family: 'Noto Serif SC', 'Songti SC', SimSun, serif;
  font-size: 22px;
  font-weight: var(--fw-900);
  opacity: 0.85;
  transform: rotate(8deg);
}
.slip__text {
  margin: 0;
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif;
  font-size: 24px;
  font-weight: var(--fw-700);
  line-height: 1.8;
  letter-spacing: 0.08em;
  white-space: pre-line;
}
.slip__rewards {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.slip__rewards li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px 4px 4px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  font-size: 14px;
}
.slip__rewards :deep(.item-image) {
  border-radius: 50%;
}

/* 每日奖励 */
.days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 6px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  text-align: center;
}
.day :deep(.item-image) {
  width: 44px;
  height: 44px;
}
.day__label {
  color: var(--muted);
  font-size: 12px;
  font-weight: var(--fw-700);
}
.day__name {
  min-height: 2.8em;
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.day b {
  color: var(--accent);
  font-size: 13px;
}
.day--past {
  opacity: 0.55;
}
.day--today {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 8px 18px -12px var(--accent);
}
.day--today .day__label {
  color: var(--accent);
}

/* 快乐值阶梯 */
.ladder {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--tiers), minmax(0, 1fr));
  gap: 10px;
  padding-top: 8px;
}
.ladder__track {
  position: absolute;
  top: 24px;
  right: calc(100% / var(--tiers) / 2);
  left: 0;
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(46, 118, 80, 0.12);
}
.ladder__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #8cc56e, var(--accent));
  transition: width 0.3s ease;
}
.rung {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.rung__dot {
  position: relative;
  z-index: 1;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 2px solid var(--paper);
  border-radius: 50%;
  color: var(--muted);
  background: #e7ece4;
  font-size: 15px;
}
.rung--ready .rung__dot {
  color: #fff;
  background: #e0a42b;
  box-shadow: 0 0 0 4px rgba(224, 164, 43, 0.22);
}
.rung--claimed .rung__dot {
  color: #fff;
  background: var(--accent);
}
.rung__value {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.rung ul {
  width: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  list-style: none;
}
.rung--ready ul {
  border-color: #e0a42b;
  background: #fff9ea;
}
.rung--claimed ul {
  opacity: 0.6;
}
.rung li {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  line-height: 1.35;
}
.rung li span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rung li em {
  color: var(--accent);
  font-style: normal;
  font-weight: var(--fw-700);
}
.rung--ready .tag {
  color: #9a6b0c;
  background: #fbefcf;
}

/* 今日任务 */
.tasks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.task {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
}
.task__icon {
  width: 40px;
  height: 40px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 12px;
  color: var(--accent);
  background: var(--accent-soft);
  font-size: 20px;
}
.task__copy {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.task__copy strong {
  font-size: 15px;
}
.task__copy span {
  color: var(--muted);
  font-size: 13px;
}
.task__count {
  flex: none;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.task__count small {
  color: var(--muted);
  font-size: 14px;
  font-weight: var(--fw-400);
}
.task--meter {
  background: rgba(255, 255, 255, 0.55);
}

/* 折叠区 */
.fold {
  padding: 0;
}
.fold summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 24px;
  font-size: 15px;
  font-weight: var(--fw-700);
  cursor: pointer;
  list-style: none;
}
.fold summary::-webkit-details-marker {
  display: none;
}
.fold summary > span {
  color: var(--accent);
}
.fold summary::after {
  content: '';
  width: 7px;
  height: 7px;
  margin-left: auto;
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: rotate(45deg);
  transition: transform 0.15s ease;
}
.fold[open] summary::after {
  transform: rotate(-135deg);
}
.fold__body {
  padding: 4px 24px 20px;
  border-top: 1px dashed var(--line);
}
.fold__empty {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 14px;
}
.segmented {
  display: inline-flex;
  gap: 2px;
  margin-top: 14px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(120, 110, 95, 0.1);
}
.segmented button {
  padding: 6px 16px;
  border: 0;
  border-radius: 999px;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  background: transparent;
  cursor: pointer;
}
.segmented button[aria-selected='true'] {
  color: var(--accent);
  font-weight: var(--fw-700);
  background: #fff;
  box-shadow: 0 1px 3px rgba(55, 45, 30, 0.12);
}
.records {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.records li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(120, 110, 95, 0.1);
  font-size: 14px;
}
.records li:last-child {
  border-bottom: 0;
}
.records b {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.records time {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.rules p {
  margin: 0 0 6px;
  color: #4f4538;
  font-size: 14px;
  line-height: 1.85;
}
.autumn--happy .rules p {
  color: #3f4d44;
}
.rules p:first-child {
  margin-top: 14px;
}
.rules .rules__title {
  margin-top: 16px;
  color: var(--accent);
  font-weight: var(--fw-700);
}

@media (max-width: 900px) {
  .autumn-scroll {
    top: calc(72px + env(safe-area-inset-top));
  }
  .hero {
    flex-wrap: wrap;
  }
  .hero__stats {
    width: 100%;
  }
  .hero__stats > div {
    flex: 1;
  }
  .days {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .ladder {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    row-gap: 18px;
  }
  .ladder__track {
    display: none;
  }
}
@media (max-width: 640px) {
  .autumn-body {
    padding: 16px 12px 36px;
  }
  .hero {
    gap: 14px;
    margin-bottom: 16px;
  }
  .hero__art {
    width: 72px;
    height: 72px;
  }
  .hero__art img {
    width: 58px;
    height: 58px;
  }
  .hero__copy {
    flex-basis: calc(100% - 86px);
  }
  .hero__copy h2 {
    font-size: 22px;
  }
  .hero__copy p {
    font-size: 13px;
  }
  .panel {
    padding: 18px 16px;
    border-radius: 14px;
  }
  .panel__head {
    flex-wrap: wrap;
  }
  .sticks {
    gap: 8px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .stick {
    min-height: 150px;
    padding: 16px 4px 12px;
    border-radius: 60px 60px 12px 12px;
  }
  .stick strong {
    font-size: 20px;
  }
  .action-row .btn {
    flex: 1;
    padding: 0 12px;
  }
  .slip__text {
    font-size: 20px;
  }
  .ladder {
    grid-template-columns: 1fr;
    row-gap: 8px;
    padding-top: 0;
  }
  .rung {
    display: grid;
    grid-template-areas:
      'dot value tag'
      'dot list list';
    grid-template-columns: 34px minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 12px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #fff;
    text-align: left;
  }
  .rung--ready {
    border-color: #e0a42b;
    background: #fff9ea;
  }
  .rung--claimed {
    opacity: 0.6;
  }
  .rung__dot {
    grid-area: dot;
    align-self: start;
  }
  .rung__value {
    grid-area: value;
  }
  .rung .tag {
    grid-area: tag;
  }
  .rung ul,
  .rung--ready ul,
  .rung--claimed ul {
    grid-area: list;
    flex-flow: row wrap;
    gap: 6px 14px;
    padding: 0;
    border: 0;
    background: transparent;
    opacity: 1;
  }
  .rung li {
    flex-direction: row;
    gap: 6px;
  }
  .tasks {
    grid-template-columns: 1fr;
  }
  .fold summary {
    padding: 14px 16px;
  }
  .fold__body {
    padding: 4px 16px 16px;
  }
}
</style>
