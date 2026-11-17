<script setup lang="ts">
import type { MugeAction, MugeTier } from '@/stores/muge'
import { NButton } from 'naive-ui/es/button'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import ActivityRulesDialog from '@/components/activity/ActivityRulesDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useMugeStore } from '@/stores/muge'

/**
 * 牧歌初启：农场与牧场共用同一份账号进度，两个空间的活动页都打开这里。
 * 页面直接铺在内容区上（标题行 + 页签 + 卡片网格），与游戏商城等页面同一种结构，不再套活动外框。
 */
type Section = 'celebration' | 'friends' | 'handbook' | 'personality'
type Tone = 'done' | 'ready' | 'idle' | 'locked'

defineEmits<{ back: [] }>()
const store = useMugeStore()
const { state, busy, error, needsRefresh } = storeToRefs(store)
const { currentAccountId } = storeToRefs(useAccountStore())
const tab = ref<Section>('celebration')
const rulesOpen = ref(false)
const answering = ref(false)
const questionIndex = ref(0)
const disabled = computed(() => busy.value || needsRefresh.value || !state.value?.active)

const period = computed(() => {
  const s = state.value
  if (!s)
    return null
  const format = (value: number) => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
  // 按自然日计算剩余天数，与其他活动页的标题一致。
  const day = (ms: number) => {
    const date = new Date(ms)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((day(s.endTime) - day(s.serverTime)) / 86_400_000)
  const badge = !s.active || days < 0 ? '已结束' : days === 0 ? '今天结束' : `还剩 ${days} 天`
  return { text: `${format(s.startTime)} – ${format(s.endTime)}`, badge, ended: badge === '已结束' }
})

function claimable(tiers: MugeTier[] = []) {
  return tiers.filter(tier => tier.status === 2).length
}
const sections = computed(() => {
  const s = state.value
  return [
    { key: 'celebration' as const, label: '兴牧庆典', icon: 'i-carbon-trophy', dot: claimable(s?.celebration?.tiers) > 0 },
    { key: 'friends' as const, label: '牧友同行', icon: 'i-carbon-user-multiple', dot: claimable(s?.friends?.tiers) > 0 },
    { key: 'handbook' as const, label: '成长手册', icon: 'i-carbon-notebook', dot: !!s?.handbook && (claimable(s.handbook.tiers) > 0 || s.handbook.tasks.some(task => task.status === 2)) },
    { key: 'personality' as const, label: '牧场人格', icon: 'i-carbon-user-profile', dot: !!s?.personality?.personalityId && !s.personality.shareRewardClaimed },
  ]
})

/** 档位门槛动辄上亿，按万/亿缩写；当前数值仍显示完整数字。 */
function compact(value: number) {
  const trim = (n: number) => String(Number(n.toFixed(1)))
  if (value >= 1e8)
    return `${trim(value / 1e8)} 亿`
  if (value >= 1e4)
    return `${trim(value / 1e4)} 万`
  return value.toLocaleString('zh-CN')
}
function tierTone(status: number): { tone: Tone, text: string } {
  return status === 3 ? { tone: 'done', text: '已领取' } : status === 2 ? { tone: 'ready', text: '可领取' } : { tone: 'idle', text: '未达成' }
}

/** 兴牧庆典与牧友同行结构相同：一个累计值 + 若干档位。 */
const tierSection = computed(() => {
  const s = state.value
  if (tab.value === 'celebration' && s?.celebration)
    return { label: '全服累计饲养', unit: '只', value: s.celebration.total, tiers: s.celebration.tiers, action: 'claimCelebration' as MugeAction, note: '全服饲养数量达到档位后，所有玩家都可领取' }
  if (tab.value === 'friends' && s?.friends)
    return { label: '已开启牧场的好友', unit: '位', value: s.friends.count, tiers: s.friends.tiers, action: 'claimFriends' as MugeAction, note: '好友关系解除不影响已计数的好友' }
  return null
})
function progressTo(value: number, tiers: MugeTier[], unit: string) {
  const next = tiers.find(tier => tier.status === 1 && tier.threshold > value)
  if (!next)
    return { percent: 100, text: '全部档位已达成' }
  const previous = [...tiers].reverse().find(tier => tier.threshold <= value)?.threshold || 0
  const span = next.threshold - previous
  return {
    percent: span > 0 ? Math.min(100, Math.max(0, (value - previous) / span * 100)) : 0,
    text: `距 ${compact(next.threshold)}${unit} 还差 ${compact(next.threshold - value)}`,
  }
}

/** 成长手册：任务按解锁天数分组，未解锁的天数默认收起。 */
const handbook = computed(() => state.value?.handbook || null)
const taskDays = computed(() => {
  const groups = new Map<number, NonNullable<typeof handbook.value>['tasks']>()
  for (const task of handbook.value?.tasks || [])
    groups.set(task.unlockDay, [...(groups.get(task.unlockDay) || []), task])
  return [...groups].sort(([a], [b]) => a - b).map(([day, tasks]) => ({
    day,
    tasks,
    locked: tasks.every(task => task.status === 4),
    done: tasks.filter(task => task.status === 3).length,
  }))
})
function taskTone(task: { status: number, progress: number, target: number }): { tone: Tone, text: string } {
  if (task.status === 3)
    return { tone: 'done', text: '已领取' }
  if (task.status === 2)
    return { tone: 'ready', text: '可领取' }
  if (task.status === 4)
    return { tone: 'locked', text: '未解锁' }
  return { tone: 'idle', text: `${task.progress} / ${task.target}` }
}

/** 牧场人格：逐题保存，选中后自动进入下一题。 */
const questions = computed(() => state.value?.questions || [])
const question = computed(() => questions.value[questionIndex.value])
const answers = computed(() => state.value?.personality?.answers || {})
const allAnswered = computed(() => questions.value.length > 0 && questions.value.every(q => answers.value[q.id]))
const isLast = computed(() => questionIndex.value === questions.value.length - 1)
function startSurvey() {
  answering.value = true
  questionIndex.value = 0
}
async function answer(value: number) {
  if (!question.value || disabled.value)
    return
  const index = questionIndex.value
  const saved = await store.request('saveAnswers', { answers: { [question.value.id]: value }, clear: index === 0 })
  if (saved && index < questions.value.length - 1 && questionIndex.value === index)
    questionIndex.value++
}
async function settle() {
  if (await store.request('settle'))
    answering.value = false
}

/** 规则原文是游戏配置 JSON（含 <b> 标记），整理成段落，【】开头的行作为小标题。 */
const rules = computed(() => {
  const lines: string[] = []
  for (const raw of state.value?.rules || []) {
    let parsed: any = null
    try {
      parsed = JSON.parse(raw)
    }
    catch {}
    lines.push(...(Array.isArray(parsed?.tips?.txt) ? parsed.tips.txt.map(String) : [String(raw)]))
  }
  return lines
    .map(line => ({ heading: /^\s*<b>.*<\/b>\s*$/.test(line), text: line.replace(/<[^>]+>/g, '').trim() }))
    .filter(line => line.text)
})

watch(currentAccountId, () => {
  answering.value = false
  questionIndex.value = 0
  void store.request()
}, { immediate: true })
</script>

<template>
  <section class="muge">
    <!-- 标题行：与全站页头同一字号与位置，返回、标题、活动时间；右侧说明与刷新。 -->
    <header class="muge-head">
      <div class="muge-head__lead">
        <NButton quaternary circle title="返回活动列表" aria-label="返回活动列表" @click="$emit('back')">
          <template #icon>
            <span class="i-carbon-arrow-left" />
          </template>
        </NButton>
        <img src="/activity-assets/muge/icon.png" alt="" width="32" height="32" class="muge-head__icon">
        <div class="min-w-0">
          <h1>牧歌初启</h1>
          <p v-if="period">
            <span class="i-carbon-calendar" aria-hidden="true" />{{ period.text }}
            <span class="muge-head__badge" :class="{ 'is-ended': period.ended }">{{ period.badge }}</span>
          </p>
        </div>
      </div>
      <div class="muge-head__actions">
        <NButton quaternary :disabled="!state" title="活动说明" aria-label="活动说明" @click="rulesOpen = true">
          <template #icon>
            <span class="i-carbon-information" />
          </template>
          <span class="muge-head__rules-label">活动说明</span>
        </NButton>
        <NButton quaternary circle :loading="busy" title="刷新活动" aria-label="刷新活动" @click="store.request()">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </header>

    <NTabs v-model:value="tab" type="line" class="muge-tabs" aria-label="牧歌初启玩法">
      <NTab v-for="section in sections" :key="section.key" :name="section.key">
        <span class="muge-tab"><span :class="section.icon" aria-hidden="true" />{{ section.label }}<i v-if="section.dot" class="muge-tab__dot" aria-label="有可领取奖励" /></span>
      </NTab>
    </NTabs>

    <div class="muge-content">
      <p v-if="error" class="muge-error" role="alert">
        <span class="i-carbon-warning-alt" aria-hidden="true" />{{ error }}
      </p>

      <EmptyState v-if="!currentAccountId" title="请先选择账号" icon="i-carbon-user-avatar" />
      <EmptyState v-else-if="!state" :title="busy ? '正在读取活动进度' : '暂未获取到活动数据'" :icon="busy ? 'i-svg-spinners-90-ring-with-bg' : 'i-carbon-calendar'">
        <NButton v-if="!busy" secondary @click="store.request()">
          重新读取
        </NButton>
      </EmptyState>

      <template v-else>
        <p v-if="!state.active" class="muge-notice">
          <span class="i-carbon-time" aria-hidden="true" />活动尚未开始或已经结束，奖励暂不可领取
        </p>

        <!-- 兴牧庆典 / 牧友同行 -->
        <template v-if="tierSection">
          <section class="muge-card muge-bar">
            <div class="muge-bar__value">
              <span>{{ tierSection.label }}</span>
              <strong>{{ tierSection.value.toLocaleString('zh-CN') }}<small>{{ tierSection.unit }}</small></strong>
            </div>
            <div class="muge-bar__progress">
              <div class="muge-track" aria-hidden="true">
                <i :style="{ width: `${progressTo(tierSection.value, tierSection.tiers, tierSection.unit).percent}%` }" />
              </div>
              <span>{{ progressTo(tierSection.value, tierSection.tiers, tierSection.unit).text }}<em> · {{ tierSection.note }}</em></span>
            </div>
            <NButton type="primary" :secondary="!claimable(tierSection.tiers)" :disabled="disabled || !claimable(tierSection.tiers)" :loading="busy" @click="store.request(tierSection.action)">
              {{ claimable(tierSection.tiers) ? `领取 ${claimable(tierSection.tiers)} 档奖励` : '暂无可领取' }}
            </NButton>
          </section>

          <div class="muge-grid">
            <article v-for="tier in tierSection.tiers" :key="tier.id" class="muge-card muge-item" :class="`is-${tierTone(tier.status).tone}`">
              <span class="muge-item__well"><img v-if="tier.rewards[0]" :src="tier.rewards[0].image" alt=""></span>
              <div class="muge-item__main">
                <strong>{{ compact(tier.threshold) }}{{ tierSection.unit }}</strong>
                <span v-for="reward in tier.rewards" :key="reward.id">{{ reward.name }} <b>×{{ reward.count.toLocaleString('zh-CN') }}</b></span>
              </div>
              <span class="muge-status" :class="`is-${tierTone(tier.status).tone}`">
                <span v-if="tier.status === 3" class="i-carbon-checkmark" aria-hidden="true" />{{ tierTone(tier.status).text }}
              </span>
            </article>
          </div>
        </template>

        <!-- 成长手册 -->
        <template v-else-if="tab === 'handbook'">
          <EmptyState v-if="!handbook" title="成长手册未开启" description="种植等级达到 25 级并开启牧场后解锁" icon="i-carbon-locked" />
          <template v-else>
            <section class="muge-card muge-bar">
              <div class="muge-bar__value">
                <span>成长积分</span>
                <strong>{{ handbook.points }}<small>积分</small></strong>
              </div>
              <div class="muge-bar__progress">
                <div class="muge-track" aria-hidden="true">
                  <i :style="{ width: `${progressTo(handbook.points, handbook.tiers, ' 积分').percent}%` }" />
                </div>
                <span>{{ progressTo(handbook.points, handbook.tiers, ' 积分').text }}</span>
              </div>
              <div class="muge-bar__actions">
                <NButton :disabled="disabled || !handbook.tasks.some(task => task.status === 2)" @click="store.request('claimTask')">
                  领取任务奖励
                </NButton>
                <NButton type="primary" :secondary="!claimable(handbook.tiers)" :disabled="disabled || !claimable(handbook.tiers)" @click="store.request('claimHandbook')">
                  领取积分奖励
                </NButton>
              </div>
            </section>

            <section class="muge-section">
              <header class="muge-section__head">
                <i aria-hidden="true" /><h2>积分奖励</h2><span>{{ handbook.tiers.filter(t => t.status === 3).length }} / {{ handbook.tiers.length }}</span>
              </header>
              <div class="muge-grid is-small">
                <article v-for="tier in handbook.tiers" :key="tier.id" class="muge-card muge-item is-compact" :class="`is-${tierTone(tier.status).tone}`" :title="tier.rewards.map(r => `${r.name} ×${r.count}`).join('、')">
                  <span class="muge-item__well"><img v-if="tier.rewards[0]" :src="tier.rewards[0].image" alt=""></span>
                  <div class="muge-item__main">
                    <strong>{{ tier.threshold }} 积分</strong>
                    <span v-if="tier.rewards[0]">{{ tier.rewards[0].name }} <b>×{{ tier.rewards[0].count.toLocaleString('zh-CN') }}</b></span>
                  </div>
                  <span v-if="tier.status !== 1" class="muge-status" :class="`is-${tierTone(tier.status).tone}`">
                    <span v-if="tier.status === 3" class="i-carbon-checkmark" aria-hidden="true" />{{ tierTone(tier.status).text }}
                  </span>
                </article>
              </div>
            </section>

            <details v-for="group in taskDays" :key="group.day" class="muge-section" :open="!group.locked">
              <summary class="muge-section__head">
                <i aria-hidden="true" /><h2>第 {{ group.day }} 天</h2>
                <span>{{ group.locked ? `未解锁 · ${group.tasks.length} 个任务` : `已完成 ${group.done} / ${group.tasks.length}` }}</span>
                <span class="muge-section__chevron i-carbon-chevron-down" aria-hidden="true" />
              </summary>
              <div class="muge-grid">
                <article v-for="task in group.tasks" :key="task.id" class="muge-card muge-item" :class="`is-${taskTone(task).tone}`">
                  <span class="muge-item__well"><img v-if="task.rewards[0]" :src="task.rewards[0].image" alt=""></span>
                  <div class="muge-item__main">
                    <strong :title="task.description">{{ task.description }}</strong>
                    <span>{{ task.points }} 积分<template v-for="reward in task.rewards" :key="reward.id"> · {{ reward.name }} <b>×{{ reward.count.toLocaleString('zh-CN') }}</b></template></span>
                  </div>
                  <span class="muge-status" :class="`is-${taskTone(task).tone}`">
                    <span v-if="task.status === 3" class="i-carbon-checkmark" aria-hidden="true" />{{ taskTone(task).text }}
                  </span>
                </article>
              </div>
            </details>
          </template>
        </template>

        <!-- 牧场人格 -->
        <template v-else-if="tab === 'personality'">
          <EmptyState v-if="!state.personality" title="牧场人格暂不可用" icon="i-carbon-user-profile" />

          <section v-else-if="answering && question" class="muge-card muge-quiz" aria-label="牧场人格测试">
            <header class="muge-quiz__head">
              <span>第 <b>{{ questionIndex + 1 }}</b> / {{ questions.length }} 题</span>
              <NButton text :disabled="busy" @click="answering = false">
                退出测试
              </NButton>
            </header>
            <div class="muge-track" aria-hidden="true">
              <i :style="{ width: `${(questionIndex + 1) / questions.length * 100}%` }" />
            </div>
            <h3 class="muge-quiz__title">
              {{ question.title }}
            </h3>
            <div class="muge-quiz__options" role="radiogroup" :aria-label="question.title">
              <button
                v-for="option in question.options"
                :key="option.value"
                type="button"
                role="radio"
                class="muge-option"
                :aria-checked="answers[question.id] === option.value"
                :disabled="disabled"
                @click="answer(option.value)"
              >
                <span class="muge-option__letter">{{ option.label }}</span>
                <span class="muge-option__text">{{ option.text }}</span>
                <span v-if="answers[question.id] === option.value" class="muge-option__check i-carbon-checkmark-filled" aria-hidden="true" />
              </button>
            </div>
            <footer class="muge-quiz__foot">
              <NButton secondary :disabled="busy || questionIndex === 0" @click="questionIndex--">
                上一题
              </NButton>
              <NButton v-if="isLast" type="primary" :loading="busy" :disabled="disabled || !allAnswered" @click="settle">
                查看人格结果
              </NButton>
              <NButton v-else secondary :disabled="busy || !answers[question.id]" @click="questionIndex++">
                下一题
              </NButton>
            </footer>
          </section>

          <section v-else class="muge-card muge-result">
            <img v-if="state.personality.image" :src="state.personality.image" alt="我的牧场人格测试结果" class="muge-result__poster">
            <span v-else class="muge-result__placeholder" aria-hidden="true"><span class="i-carbon-user-profile" /></span>
            <div class="muge-result__body">
              <div>
                <h3>{{ state.personality.personalityId ? '我的牧场人格' : '测一测你的牧场人格' }}</h3>
                <p>
                  {{ state.personality.personalityId
                    ? '根据经营农场的习惯得出，活动期间可以重新测试，新结果会覆盖旧结果。'
                    : '根据经营农场的习惯得出你的牧场人格，测试结果可以分享给好友。' }}
                </p>
              </div>
              <ul class="muge-result__facts">
                <li>
                  <span>题目</span>
                  <b>{{ questions.length }} 道</b>
                </li>
                <li>
                  <span>已测试</span>
                  <b>{{ state.personality.settleCount || (state.personality.personalityId ? 1 : 0) }} 次</b>
                </li>
                <li :class="{ 'is-ready': state.personality.personalityId && !state.personality.shareRewardClaimed }">
                  <span>首次分享奖励</span>
                  <b>{{ state.personality.shareRewardClaimed ? '已领取' : state.personality.personalityId ? '可领取' : '完成测试后领取' }}</b>
                </li>
              </ul>
              <div class="muge-result__actions">
                <NButton :type="state.personality.personalityId ? 'default' : 'primary'" :secondary="!!state.personality.personalityId" :disabled="disabled" @click="startSurvey">
                  {{ state.personality.personalityId ? '重新测试' : '开始测试' }}
                </NButton>
                <NButton v-if="state.personality.personalityId && !state.personality.shareRewardClaimed" type="primary" :disabled="disabled" @click="store.request('claimShare')">
                  领取首次分享奖励
                </NButton>
              </div>
            </div>
          </section>
        </template>
      </template>
    </div>

    <ActivityRulesDialog :open="rulesOpen" title="牧歌初启 · 活动说明" @close="rulesOpen = false">
      <div v-if="rules.length" class="muge-rules">
        <p v-for="(line, index) in rules" :key="index" :class="{ 'is-heading': line.heading }">
          {{ line.text }}
        </p>
      </div>
      <p v-else class="muge-rules__empty">
        暂无活动说明
      </p>
    </ActivityRulesDialog>
  </section>
</template>

<style scoped>
/* 页面直接铺在内容区（与游戏商城同一结构）：标题行、页签、内容依次排列，宽度跟随全站内容区。 */
.muge {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding-bottom: 24px;
}

.muge h1,
.muge h2,
.muge h3,
.muge p {
  margin: 0;
}

/* 标题行与全站页头（PageHeader）同高同字号。 */
.muge-head {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
}

.muge-head__lead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.muge-head__icon {
  flex: none;
  object-fit: contain;
}

.muge-head h1 {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muge-head p {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
}

.muge-head__badge {
  margin-left: 4px;
  padding: 0 7px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
  line-height: 18px;
}

.muge-head__badge.is-ended {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.muge-head__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

/* 页签与游戏商城的页签同一种线型样式，下边线贯穿整行。 */
.muge-tabs {
  margin-top: 8px;
}

.muge-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.muge-tab__dot {
  position: absolute;
  top: -1px;
  right: -9px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ui-danger);
}

.muge-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding-top: 16px;
}

.muge-error,
.muge-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--ui-radius-control);
  font-size: 13px;
}

.muge-error {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.muge-notice {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.muge-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

/* 汇总条：数值 | 进度 | 操作，一行铺满。 */
.muge-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 28px;
  padding: 16px 20px;
}

.muge-bar__value {
  display: flex;
  flex: none;
  flex-direction: column;
}

.muge-bar__value span {
  color: var(--ui-muted);
  font-size: 12px;
}

.muge-bar__value strong {
  color: var(--ui-ink);
  font-size: 24px;
  font-weight: var(--fw-700);
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.muge-bar__value small {
  margin-left: 4px;
  color: var(--ui-muted);
  font-size: 13px;
  font-weight: var(--fw-500);
}

.muge-bar__progress {
  display: flex;
  min-width: min(100%, 240px);
  flex: 1;
  flex-direction: column;
  gap: 8px;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.muge-bar__progress em {
  color: var(--ui-subtle);
  font-style: normal;
}

.muge-bar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.muge-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.muge-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
  transition: width 0.4s ease;
}

/* 档位、任务：与商城商品同一种横向小卡片，自动换列，每行高度随内容。 */
.muge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  align-items: start;
  gap: 12px;
}

.muge-grid.is-small {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
}

.muge-item {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  transition:
    border-color 0.15s ease,
    opacity 0.15s ease;
}

.muge-item.is-compact {
  grid-template-columns: 40px minmax(0, 1fr) auto;
  gap: 10px;
  padding: 10px 12px;
}

.muge-item.is-ready {
  border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary-soft) 60%, var(--ui-surface));
}

.muge-item.is-done,
.muge-item.is-locked {
  opacity: 0.6;
}

.muge-item__well {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.muge-item.is-compact .muge-item__well {
  width: 40px;
  height: 40px;
  border-radius: 10px;
}

.muge-item__well img {
  width: 76%;
  height: 76%;
  object-fit: contain;
}

.muge-item__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.muge-item__main strong {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.muge-item__main span {
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muge-item__main b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.muge-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  color: var(--ui-subtle);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.muge-status.is-ready {
  padding: 1px 9px;
  border-radius: 999px;
  color: #fff;
  background: var(--ui-primary-fill);
  font-weight: var(--fw-600);
  line-height: 20px;
}

.muge-status.is-done {
  color: var(--ui-primary);
}

.muge-status.is-idle {
  color: var(--ui-muted);
}

/* 分组标题：与图鉴分组同一种色标 + 标题 + 计数。 */
.muge-section {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.muge-section__head {
  display: flex;
  min-height: 24px;
  align-items: center;
  gap: 8px;
  list-style: none;
}

details > .muge-section__head {
  cursor: pointer;
}

.muge-section__head::-webkit-details-marker {
  display: none;
}

.muge-section__head > i {
  width: 3px;
  height: 14px;
  flex: none;
  border-radius: 2px;
  background: var(--ui-primary);
}

.muge-section__head h2 {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.muge-section__head > span:not(.muge-section__chevron) {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.muge-section__chevron {
  color: var(--ui-subtle);
  transition: transform 0.16s ease;
}

details:not([open]) .muge-section__chevron {
  transform: rotate(-90deg);
}

details:not([open]) > .muge-section__head > i {
  background: var(--ui-border-strong);
}

.muge-section__head:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
  border-radius: 6px;
}

/* 人格测试：整行宽度，选项宽屏两列。 */
.muge-quiz {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 22px;
}

.muge-quiz__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ui-muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.muge-quiz__head b {
  color: var(--ui-primary);
  font-size: 15px;
}

.muge-quiz__title {
  margin-top: 4px;
  color: var(--ui-ink);
  font-size: 17px;
  font-weight: var(--fw-650);
  line-height: 1.5;
}

.muge-quiz__options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 8px;
}

.muge-option {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 10px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  color: var(--ui-ink);
  background: var(--ui-surface-strong);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.muge-option:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  background: var(--ui-surface-soft);
}

.muge-option[aria-checked='true'] {
  border-color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.muge-option:disabled {
  cursor: default;
  opacity: 0.7;
}

.muge-option:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.muge-option__letter {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  font-weight: var(--fw-700);
}

.muge-option[aria-checked='true'] .muge-option__letter {
  color: #fff;
  background: var(--ui-primary-fill);
}

.muge-option__check {
  color: var(--ui-primary);
  font-size: 18px;
}

.muge-quiz__foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.muge-result {
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 20px 24px;
}

.muge-result__poster {
  width: 180px;
  height: auto;
  flex: none;
  border-radius: 12px;
  box-shadow: var(--ui-shadow-sm);
}

.muge-result__placeholder {
  display: grid;
  width: 72px;
  height: 72px;
  flex: none;
  place-items: center;
  border-radius: 20px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 34px;
}

.muge-result__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 16px;
}

.muge-result__body h3 {
  color: var(--ui-ink);
  font-size: 17px;
  font-weight: var(--fw-650);
}

.muge-result__body p {
  margin-top: 6px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.6;
}

.muge-result__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.muge-result__facts li {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.muge-result__facts span {
  color: var(--ui-muted);
  font-size: 12px;
}

.muge-result__facts b {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 16px;
  font-weight: var(--fw-700);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muge-result__facts li.is-ready {
  background: var(--ui-primary-soft);
}

.muge-result__facts li.is-ready b {
  color: var(--ui-primary);
}

.muge-result__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.muge-rules {
  color: var(--ui-ink);
  font-size: 13px;
  line-height: 1.75;
}

.muge-rules p {
  margin: 0 0 6px;
}

.muge-rules p.is-heading {
  margin-top: 12px;
  font-weight: var(--fw-650);
}

.muge-rules p.is-heading:first-child {
  margin-top: 0;
}

.muge-rules__empty {
  margin: 0;
  padding: 24px 0;
  color: var(--ui-muted);
  text-align: center;
}

@media (max-width: 1023px) {
  .muge-head {
    padding-top: 12px;
  }

  .muge-head h1 {
    font-size: 19px;
  }
}

@media (max-width: 640px) {
  .muge-head__actions .muge-head__rules-label {
    display: none;
  }

  .muge-bar {
    padding: 14px 16px;
  }

  .muge-bar__actions,
  .muge-bar > :deep(.n-button) {
    width: 100%;
  }

  .muge-bar__actions > :deep(.n-button) {
    flex: 1;
  }

  .muge-result {
    flex-direction: column;
    align-items: stretch;
    gap: 18px;
    padding: 16px;
  }

  .muge-result__poster {
    align-self: center;
  }

  .muge-result__facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .muge-result__facts li:last-child {
    grid-column: 1 / -1;
  }

  .muge-result__actions > :deep(.n-button) {
    flex: 1;
  }
}
</style>
