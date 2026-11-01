<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

const { currentAccountId, currentAccount } = storeToRefs(useAccountStore())
const connected = computed(() => !!currentAccount.value?.running)
const toast = useToastStore()
const data = ref<any>(null)
const busy = ref(false)
const error = ref('')
const seasonId = ref(0)
const questionId = ref(0)
const answer = ref<number | null>(null)
const receivedAt = ref(Date.now())
const tick = ref(Date.now())
let sequence = 0
let refreshedBoundary = 0
useIntervalFn(() => tick.value = Date.now(), 1000)
const now = computed(() => Number(data.value?.serverTime || 0) + (tick.value - receivedAt.value) / 1000)
const season = computed(() => data.value?.seasons.find((v: any) => v.id === seasonId.value))
const events = computed<any[]>(() => (data.value?.events || []).filter((v: any) => !season.value || season.value.eventIds.includes(v.id)))
const question = computed(() => data.value?.events.find((v: any) => v.id === questionId.value))
const nextBoundary = computed(() => {
  const snapshotTime = Number(data.value?.serverTime || 0)
  const times = (data.value?.events || []).flatMap((event: any) => [event.startTime, event.endTime + 1])
  if (data.value?.events.some((event: any) => event.quizWrongToday))
    times.push((Math.floor((snapshotTime + 28800) / 86400) + 1) * 86400 - 28800)
  return Math.min(...times.filter((time: number) => time > snapshotTime))
})
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' })
// 撕页日历：开始日期的月、日，以及结束日（同月只写日）
function leaf(event: any) {
  const part = (value: number) => {
    const parts = dayFormat.formatToParts(new Date(value * 1000))
    return { month: parts.find(v => v.type === 'month')?.value || '', day: parts.find(v => v.type === 'day')?.value || '' }
  }
  const start = part(event.startTime)
  const end = part(event.endTime)
  return { month: `${start.month}月`, day: start.day, until: end.month === start.month ? `至 ${end.day}日` : `至 ${end.month}月${end.day}日` }
}
// 描述首行是农历日期，其余是节令诗句
function lunarOf(event: any) {
  const first = String(event.description || '').split('\n')[0] || ''
  return first.startsWith('农历') ? first : ''
}
function poemOf(event: any) {
  const lines = String(event.description || '').split('\n').filter(Boolean)
  return lunarOf(event) ? lines.slice(1) : lines
}
function distance(seconds: number) {
  return seconds >= 86400 ? `${Math.ceil(seconds / 86400)}天` : seconds >= 3600 ? `${Math.ceil(seconds / 3600)}小时` : `${Math.max(1, Math.ceil(seconds / 60))}分钟`
}
function phase(event: any) {
  if (event.directClaimed && (!event.question || event.quizClaimed))
    return 'done'
  if (now.value > event.endTime || event.status === 3)
    return 'expired'
  return now.value < event.startTime ? 'upcoming' : 'open'
}
function phaseText(event: any) {
  const current = phase(event)
  if (current === 'done')
    return '已完成'
  if (current === 'expired')
    return '已结束'
  if (current === 'upcoming')
    return `${distance(Math.ceil(event.startTime - now.value))}后开始`
  return `进行中 · 剩 ${distance(Math.ceil(event.endTime - now.value))}`
}
// "A.敬老节" 拆成字母标和选项文字
function optionParts(option: string, index: number | string) {
  const match = /^([A-Z])[.．、](.*)$/.exec(option)
  return match ? { letter: match[1], text: (match[2] || '').trim() } : { letter: String.fromCharCode(65 + Number(index)), text: option }
}
function stateText(event: any, quiz = false) {
  if (quiz ? event.quizClaimed : event.directClaimed)
    return '已领取'
  if (now.value > event.endTime || event.status === 3)
    return '已过期'
  const seconds = Math.ceil(event.startTime - now.value)
  if (seconds > 0)
    return `${distance(seconds)}后${quiz ? '开启' : '可领取'}`
  return quiz ? event.quizWrongToday ? '明日再来' : '答题' : '领取'
}
function available(event: any, quiz = false) {
  return connected.value && !busy.value && (quiz ? event.canAnswer : event.canClaim) && now.value >= event.startTime && now.value <= event.endTime
}
function openQuestion(event: any) {
  answer.value = null
  questionId.value = event.id
}
async function request(action = '', input: any = {}) {
  if (!currentAccountId.value || !connected.value || busy.value)
    return
  const revision = ++sequence
  busy.value = true
  error.value = ''
  try {
    const options = { headers: { 'x-account-id': currentAccountId.value }, skipErrorToast: true } as any
    const response = action ? await api.post(`/api/solar-calendar/${action}`, input, options) : await api.get('/api/solar-calendar', options)
    if (revision !== sequence)
      return
    if (!response.data?.ok)
      throw new Error(getApiErrorMessage(response.data, '节令日历请求失败'))
    const result = response.data.data
    if (action) {
      questionId.value = 0
      const text = result.rewards?.map((v: any) => `${v.name} ×${v.count}`).join('、') || (action === 'answer' && !result.correct ? '明日再来' : '领取成功')
      if (result.refreshRequired)
        toast.warning(`${text}。请刷新确认最新进度`)
      else toast.success(text)
    }
    data.value = action ? result.calendar : result
    receivedAt.value = Date.now()
    tick.value = receivedAt.value
    if (!data.value?.seasons.some((v: any) => v.id === seasonId.value)) {
      const target = data.value?.events.find((v: any) => !v.directClaimed && v.endTime >= now.value)?.id || data.value?.defaultEventId
      seasonId.value = data.value?.seasons.find((v: any) => v.eventIds.includes(target))?.id || data.value?.seasons.at(-1)?.id || 0
    }
  }
  catch (cause) {
    if (revision === sequence) {
      error.value = getApiErrorMessage(cause, '节令日历请求失败')
      if (action) {
        toast.error(error.value)
        data.value = null
        questionId.value = 0
      }
    }
  }
  finally {
    if (revision === sequence)
      busy.value = false
  }
}
watch([now, busy], () => {
  const boundary = nextBoundary.value
  if (connected.value && !busy.value && now.value >= boundary && refreshedBoundary !== boundary) {
    refreshedBoundary = boundary
    void request()
  }
})
watch([currentAccountId, connected], () => {
  sequence++
  data.value = null
  busy.value = false
  questionId.value = 0
  answer.value = null
  seasonId.value = 0
  error.value = ''
  refreshedBoundary = 0
  void request()
}, { immediate: true, flush: 'sync' })
onUnmounted(() => sequence++)
</script>

<template>
  <div class="solar">
    <header class="page-toolbar">
      <span class="text-sm text-gray-500">按当前账号读取节令进度</span>
      <NButton :loading="busy" :disabled="!currentAccountId || !connected" @click="request()">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
        刷新
      </NButton>
    </header>

    <div v-if="!currentAccountId || !connected" class="solar-empty">
      <span class="i-carbon-calendar" />
      <strong>{{ !currentAccountId ? '请先选择账号' : '请先启动账号' }}</strong>
      <small>节令进度按当前账号读取</small>
    </div>
    <div v-else-if="error || !data" class="solar-empty">
      <span :class="busy ? 'i-carbon-renew animate-spin' : 'i-carbon-calendar'" />
      <strong>{{ error || (busy ? '正在读取节令日历' : '暂未获取到节令日历') }}</strong>
    </div>

    <template v-if="data">
      <nav class="season-tabs" aria-label="节令季度">
        <button
          v-for="entry in data.seasons"
          :key="entry.id"
          type="button"
          :class="{ selected: seasonId === entry.id }"
          :aria-current="seasonId === entry.id ? 'true' : undefined"
          :disabled="busy"
          @click="seasonId = entry.id"
        >
          {{ entry.name }}<small>{{ entry.litCount }}/{{ entry.totalCount }}</small>
        </button>
      </nav>

      <section v-if="season" class="season-bar" aria-label="季度进度">
        <div class="season-bar__progress">
          <strong>{{ season.name }}已点亮</strong>
          <span class="season-dots" aria-hidden="true">
            <i v-for="index in season.totalCount" :key="index" :class="{ lit: index <= season.litCount }" />
          </span>
          <b>{{ season.litCount }}/{{ season.totalCount }}</b>
        </div>
        <div v-if="season.rewards.length" class="season-bar__reward">
          <span class="line-label">集齐奖励</span>
          <span class="chips">
            <span v-for="item in season.rewards" :key="item.id" class="chip" :title="`${item.name} ×${item.count}`"><CommerceItemImage :src="item.image" :alt="item.name" size="sm" /><b>{{ item.count }}</b></span>
          </span>
          <NButton size="small" :type="season.canClaim ? 'primary' : 'default'" :disabled="busy || !season.canClaim" @click="request('season', { id: season.id })">
            {{ season.claimed ? '已领取' : season.canClaim ? '领取' : '集齐后可领' }}
          </NButton>
        </div>
      </section>

      <ol class="timeline" aria-label="节令列表">
        <li v-for="event in events" :key="event.id" class="term" :class="`term--${phase(event)}`">
          <div class="leaf" aria-hidden="true">
            <span class="leaf__month">{{ leaf(event).month }}</span>
            <b class="leaf__day">{{ leaf(event).day }}</b>
            <span class="leaf__until">{{ leaf(event).until }}</span>
            <span v-if="phase(event) === 'done'" class="leaf__check"><span class="i-carbon-checkmark" /></span>
          </div>

          <div class="term__body">
            <div class="term__title">
              <h3>{{ event.name }}</h3>
              <span v-if="lunarOf(event)" class="term__lunar">{{ lunarOf(event) }}</span>
              <span class="term__badge">{{ phaseText(event) }}</span>
            </div>
            <p v-if="poemOf(event).length" class="term__poem">
              <span v-for="line in poemOf(event)" :key="line">{{ line }}</span>
            </p>
          </div>

          <div class="term__rewards">
            <div class="reward-line">
              <span class="line-label">节令奖励</span>
              <span class="chips">
                <span v-for="item in event.rewards" :key="item.id" class="chip" :title="`${item.name} ×${item.count}`"><CommerceItemImage :src="item.image" :alt="item.name" size="sm" /><b>{{ item.count }}</b></span>
              </span>
              <NButton size="small" :type="available(event) ? 'primary' : 'default'" :disabled="!available(event)" @click="request('claim', { id: event.id })">
                {{ stateText(event) }}
              </NButton>
            </div>
            <div v-if="event.question" class="reward-line">
              <span class="line-label">答题奖励</span>
              <span class="chips">
                <span v-for="item in event.questionRewards" :key="item.id" class="chip" :title="`${item.name} ×${item.count}`"><CommerceItemImage :src="item.image" :alt="item.name" size="sm" /><b>{{ item.count }}</b></span>
              </span>
              <NButton size="small" :type="available(event, true) ? 'primary' : 'default'" secondary :disabled="!available(event, true)" @click="openQuestion(event)">
                {{ stateText(event, true) }}
              </NButton>
            </div>
            <p v-if="event.quizWrongToday && event.errorTips" class="term__tips">
              <span class="i-carbon-information" />{{ event.errorTips }}
            </p>
          </div>
        </li>
      </ol>
    </template>

    <NModal v-if="question" :show="true" :mask-closable="!busy" :close-on-esc="!busy" @update:show="!busy && (questionId = 0)">
      <NCard :title="`${question.name} · 节令问答`" :closable="!busy" class="solar-question" role="dialog" aria-modal="true" :aria-label="question.name" @close="questionId = 0">
        <div class="question-scroll">
          <p class="question-text">
            {{ question.question }}
          </p>
          <div class="answer-options" role="radiogroup" aria-label="答案">
            <label
              v-for="(option, index) in question.options"
              :key="index"
              :class="{ selected: answer === index, correct: question.answerIndex === index, wrong: question.wrongOptions.includes(index) }"
            >
              <input v-model="answer" type="radio" name="solar-answer" :value="index" :disabled="busy || question.wrongOptions.includes(index)">
              <b class="answer-options__letter">{{ optionParts(option, index).letter }}</b>
              <span class="answer-options__text">{{ optionParts(option, index).text }}</span>
              <small v-if="question.answerIndex === index" class="answer-options__correct">正确答案</small>
              <small v-else-if="question.wrongOptions.includes(index)">已答错</small>
            </label>
          </div>
        </div>
        <template #footer>
          <NButton block type="primary" :loading="busy" :disabled="answer === null || !available(question, true)" @click="request('answer', { id: question.id, optionIndex: answer, expectedQuestion: question.question })">
            提交答案
          </NButton>
        </template>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.solar {
  --seal: #c0533f;
  --seal-soft: #fbece8;
  --serif: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif;
  width: 100%;
  min-width: 0;
  color: var(--ui-ink);
  container-type: inline-size;
}

/* 页头 */
.solar-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 2px 18px;
  border-bottom: 1px solid var(--ui-border);
}
.solar-head p {
  margin: 0 0 4px;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
}
.solar-head h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.2;
}
.solar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  padding: 56px 20px;
  border: 1px dashed var(--ui-border-strong);
  border-radius: var(--ui-radius-card);
  color: var(--ui-muted);
  text-align: center;
}
.solar-empty > span {
  font-size: 32px;
  opacity: 0.6;
}
.solar-empty strong {
  color: var(--ui-ink);
  font-size: 15px;
}

/* 季度页签 */
.season-tabs {
  display: flex;
  gap: 6px;
  margin-top: 16px;
  overflow-x: auto;
}
.season-tabs button {
  height: 34px;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--ui-muted);
  background: transparent;
  font: inherit;
  font-size: 14px;
  white-space: nowrap;
  cursor: pointer;
}
.season-tabs button small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.season-tabs button:hover:not(:disabled) {
  background: var(--ui-surface-soft);
}
.season-tabs button.selected {
  border-color: color-mix(in srgb, var(--ui-primary) 30%, transparent);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
}
.season-tabs button.selected small {
  color: var(--ui-primary);
}
.season-tabs button:disabled {
  cursor: wait;
}

/* 季度进度条 */
.season-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  margin-top: 14px;
  padding: 14px 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
}
.season-bar__progress {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}
.season-bar__progress b {
  color: var(--ui-primary);
  font-variant-numeric: tabular-nums;
}
.season-dots {
  display: flex;
  gap: 6px;
}
.season-dots i {
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--ui-border-strong);
  border-radius: 50%;
  background: transparent;
}
.season-dots i.lit {
  border-color: var(--seal);
  background: var(--seal);
}
.season-bar__reward {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 时间线 */
.timeline {
  position: relative;
  display: grid;
  gap: 12px;
  margin: 18px 0 0;
  padding: 0;
  list-style: none;
}
.timeline::before {
  content: '';
  position: absolute;
  top: 24px;
  bottom: 24px;
  left: 54px;
  border-left: 2px dotted var(--ui-border-strong);
}
.term {
  position: relative;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 14px 20px;
  padding: 18px 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface-strong);
  box-shadow: var(--ui-shadow-sm);
}
.term--open {
  border-color: color-mix(in srgb, var(--seal) 38%, var(--ui-border));
  box-shadow:
    inset 3px 0 0 var(--seal),
    var(--ui-shadow-sm);
}
.term--expired,
.term--done {
  background: var(--ui-surface);
}

/* 撕页日历 */
.leaf {
  position: relative;
  align-self: start;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--ui-border-strong);
  border-radius: 8px;
  background: var(--ui-surface-strong);
  box-shadow: 0 2px 0 var(--ui-border);
}
.leaf__month {
  width: 100%;
  padding: 3px 0;
  color: #fff;
  background: var(--seal);
  font-size: 12px;
  font-weight: var(--fw-600);
  text-align: center;
}
.leaf__day {
  margin-top: 2px;
  font-family: var(--serif);
  font-size: 30px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.leaf__until {
  padding-bottom: 6px;
  color: var(--ui-muted);
  font-size: 11px;
  white-space: nowrap;
}
.leaf__check {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 14px;
  height: 14px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--ui-primary);
  background: var(--ui-surface-strong);
  font-size: 10px;
}
.term--upcoming .leaf__month {
  background: #9aa79e;
}
.term--done .leaf__month {
  background: var(--ui-primary-fill);
}
.term--expired .leaf__month {
  background: #b6bab5;
}
.term--expired .leaf__day {
  color: var(--ui-subtle);
}

/* 节令内容 */
.term__body {
  min-width: 0;
  align-self: center;
}
.term__title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}
.term__title h3 {
  margin: 0;
  font-family: var(--serif);
  font-size: 22px;
  font-weight: var(--fw-700);
  letter-spacing: 0.08em;
}
.term__lunar {
  color: var(--ui-muted);
  font-size: 13px;
}
.term__badge {
  align-self: center;
  padding: 1px 9px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-bg-soft);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.term--open .term__badge {
  color: var(--seal);
  background: var(--seal-soft);
  font-weight: var(--fw-600);
}
.term--upcoming .term__badge {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}
.term--done .term__badge {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}
.term__poem {
  display: flex;
  flex-wrap: wrap;
  gap: 0 18px;
  margin: 8px 0 0;
  color: var(--ui-muted);
  font-family: var(--serif);
  font-size: 14px;
  line-height: 1.8;
}
.term--expired .term__poem,
.term--done .term__poem {
  color: var(--ui-muted);
}

/* 奖励 */
.term__rewards {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--ui-border-strong);
}
.reward-line {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.line-label {
  color: var(--ui-muted);
  font-size: 13px;
  white-space: nowrap;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.chip :deep(.item-image) {
  width: 30px;
  height: 30px;
  border-radius: 7px;
}
.reward-line :deep(.n-button) {
  min-width: 96px;
}
.term__tips {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 13px;
  line-height: 1.6;
}
.term__tips span {
  flex: none;
  margin-top: 3px;
}

/* 宽屏：节令是按时间排列的序列，保持单列时间线。
   每行「日历页 | 节令内容 | 奖励」三栏统一垂直居中，奖励栏定宽，各行按钮落在同一条竖线上。 */
@container (min-width: 820px) {
  .term {
    grid-template-columns: 72px minmax(0, 1fr) minmax(360px, 440px);
    align-items: center;
    gap: 14px 24px;
  }
  .leaf {
    align-self: center;
  }
  .term__rewards {
    grid-column: auto;
    align-self: center;
    padding: 2px 0 2px 24px;
    border-top: 0;
    border-left: 1px dashed var(--ui-border-strong);
  }
}

/* 问答弹窗 */
.solar-question {
  display: flex;
  flex-direction: column;
  width: min(520px, calc(100vw - 24px));
  max-height: calc(100dvh - 32px);
  border-radius: 12px;
}
.solar-question :deep(.n-card-content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.solar-question :deep(.n-card-header),
.solar-question :deep(.n-card__footer) {
  flex-shrink: 0;
}
.question-text {
  margin: 0;
  color: var(--ui-ink);
  font-size: 16px;
  font-weight: var(--fw-600);
  line-height: 1.7;
}
.answer-options {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}
.answer-options label {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 10px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}
.answer-options label:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 45%, transparent);
}
.answer-options input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.answer-options__letter {
  width: 26px;
  height: 26px;
  display: grid;
  flex: none;
  place-items: center;
  border: 1.5px solid var(--ui-border-strong);
  border-radius: 50%;
  color: var(--ui-muted);
  font-size: 13px;
}
.answer-options label.selected {
  border-color: var(--ui-primary);
  background: var(--ui-primary-soft);
}
.answer-options label.correct {
  border-color: color-mix(in srgb, var(--ui-primary) 60%, var(--ui-border-strong));
}
.answer-options__text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.answer-options label.selected .answer-options__letter {
  border-color: var(--ui-primary);
  color: #fff;
  background: var(--ui-primary-fill);
}
.answer-options label:has(input:focus-visible) {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.answer-options label.wrong {
  color: var(--ui-subtle);
  cursor: not-allowed;
}
.answer-options label.wrong span {
  text-decoration: line-through;
}
.answer-options label small {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--ui-danger);
  font-size: 12px;
}
.answer-options label .answer-options__correct {
  padding: 2px 6px;
  border-radius: 4px;
  color: color-mix(in srgb, var(--ui-primary) 60%, var(--ui-ink));
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
  white-space: nowrap;
}

@media (max-width: 600px) {
  .solar-head h1 {
    font-size: 22px;
  }
  .season-bar {
    padding: 12px 14px;
  }
  .season-bar__reward {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
  }
  .season-bar__reward .line-label {
    grid-column: 1 / -1;
  }
  .timeline::before {
    left: 44px;
  }
  .term {
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 12px 14px;
    padding: 14px;
  }
  .leaf__day {
    font-size: 24px;
  }
  .leaf__until {
    font-size: 10px;
  }
  .term__title h3 {
    font-size: 19px;
  }
  .term__poem {
    flex-direction: column;
    font-size: 13px;
    line-height: 1.7;
  }
  .reward-line {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .reward-line .line-label {
    grid-column: 1 / -1;
  }
  .reward-line :deep(.n-button) {
    min-width: 88px;
  }
}

/* 深色：印章红与日历页眉降低亮度，淡色背景改为半透明。 */
.dark .solar {
  --seal: #d4705e;
  --seal-soft: rgba(212, 112, 94, 0.14);
}
.dark .term--open .leaf__month {
  background: #b5503f;
}
.dark .term--upcoming .leaf__month {
  background: #4b535c;
}
.dark .term--expired .leaf__month {
  background: #3a4048;
}
.dark .term--expired .leaf__day {
  color: var(--ui-subtle);
}
</style>
