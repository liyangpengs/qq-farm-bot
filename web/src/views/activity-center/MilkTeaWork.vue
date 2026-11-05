<script setup lang="ts">
import { useElementSize, useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { computed, ref, watch } from 'vue'

const { state, busy, selectionOnly = false } = defineProps<{ state: any, busy: boolean, selectionOnly?: boolean }>()
const emit = defineEmits<{ navigate: [page: string], operation: [action: string, input: any], confirmation: [value: any] }>()
const selected = ref<number | null>(null)
const shiftCard = ref<HTMLElement | null>(null)
const { height: shiftHeight } = useElementSize(shiftCard, undefined, { box: 'border-box' })
const tokenImage = '/game-config/seed_images_named/seed_images/1041.png'
const receivedAt = ref(Date.now())
const tick = ref(Date.now())
watch(() => state, () => {
  receivedAt.value = Date.now()
  tick.value = receivedAt.value
  selected.value = null
}, { immediate: true })
useIntervalFn(() => tick.value = Date.now(), 1000)
const shift = computed(() => state.work.my_shift)
const now = computed(() => Number(state.serverTime) + (tick.value - receivedAt.value) / 1000)
const remaining = computed(() => Math.max(0, Math.ceil(Number(shift.value?.end_at || 0) - now.value)))
const progress = computed(() => {
  const duration = Number(shift.value?.end_at) - Number(shift.value?.begin_at)
  return duration > 0 ? Math.max(0, Math.min(100, (1 - remaining.value / duration) * 100)) : 0
})
const chances = computed(() => Math.max(0, Number(shift.value?.interact_limit || 0) - Number(shift.value?.interact_count || 0)))
const canInteract = computed(() => !!shift.value && state.active && !state.settling && remaining.value > 0 && !state.work.interact_done && chances.value > 0)
const choice = computed(() => state.interactions?.find((value: any) => value.interaction_id === selected.value))
const hasPendingWages = computed(() => !!state.work.slips?.some((value: any) => Number(value.wage_status) === 1))
function duration(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`
}
function date(seconds: any) {
  return Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'
}
function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value}`
}
function wageStatus(slip: any) {
  const status = Number(slip.wage_status)
  return status === 2 ? '已领取' : status === 1 ? '待领取' : '—'
}
function confirm() {
  if (busy || !canInteract.value || !choice.value?.ready)
    return
  emit('confirmation', { action: 'interact', title: choice.value.name, description: choice.value.description, input: { interactionType: choice.value.interaction_id, expectedShiftId: String(shift.value.shift_id) } })
}
</script>

<template>
  <!-- 工作事项弹窗：选择一项互动 -->
  <div v-if="selectionOnly" class="work-options">
    <div class="work-choices custom-scrollbar" role="radiogroup" aria-label="工作事项">
      <label v-for="entry in state.interactions" :key="entry.interaction_id" class="work-choice" :class="{ 'is-selected': selected === entry.interaction_id, 'is-disabled': busy || !canInteract || !entry.ready }">
        <input v-model="selected" type="radio" name="milk-tea-work" :value="entry.interaction_id" :disabled="busy || !canInteract || !entry.ready">
        <span class="work-choice__well"><img :src="entry.image" alt="" width="48" height="48"></span>
        <span class="work-choice__text"><strong>{{ entry.name }}</strong><small>{{ entry.description }}</small></span>
      </label>
    </div>
    <footer class="work-options__foot">
      <span>本班次剩余 <b>{{ state.work.interact_done ? 0 : chances }}/{{ shift?.interact_limit || 0 }}</b> 次</span>
      <NButton type="primary" :disabled="busy || !canInteract || !choice?.ready" @click="confirm">
        确认选择
      </NButton>
    </footer>
  </div>

  <!-- 我的工作页 -->
  <div v-else class="work-page">
    <section ref="shiftCard" class="work-card" aria-labelledby="work-shift-title">
      <header class="work-card__head">
        <h3 id="work-shift-title">
          本次兼职
        </h3>
        <span class="work-tag" :class="{ 'is-muted': !(shift && remaining) }">{{ shift && remaining ? '兼职中' : '空闲中' }}</span>
      </header>

      <div v-if="shift" class="work-shift">
        <div class="work-employer">
          <img v-if="shift.employer?.avatar" class="work-employer__avatar" :src="shift.employer.avatar" alt="">
          <span v-else class="work-employer__avatar work-employer__avatar--empty i-carbon-user" aria-hidden="true" />
          <div>
            <small>你的老板</small>
            <strong>{{ shift.employer?.name || '—' }}</strong>
            <small>{{ shift.shop_name }}</small>
          </div>
        </div>
        <div class="work-clock">
          <div class="work-clock__text">
            <strong>{{ remaining ? `剩余 ${duration(remaining)}` : '已结束' }}</strong>
            <time>{{ date(shift.end_at) }} 下班</time>
          </div>
          <div class="work-clock__track" role="progressbar" aria-label="班次进度" :aria-valuenow="Math.round(progress)" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: `${progress}%` }" />
          </div>
        </div>
        <dl class="work-details">
          <div>
            <dt>你的特长</dt>
            <dd>
              <strong>{{ shift.talent_name || state.work.talent_name }}</strong>
              <small v-if="state.work.talentDescription">{{ state.work.talentDescription }}</small>
            </dd>
          </div>
          <div>
            <dt>预计工资</dt>
            <dd class="work-reward">
              <img :src="tokenImage" alt="奶茶券">{{ shift.baseWage == null ? '—' : signed(shift.baseWage) }}
            </dd>
          </div>
          <div v-if="shift.interactionResult">
            <dt>{{ shift.interactionResult.name }}</dt>
            <dd class="work-reward">
              <img v-if="shift.interactionResult.reward.image" :src="shift.interactionResult.reward.image" :alt="shift.interactionResult.reward.name">{{ signed(shift.interactionResult.reward.count) }}
            </dd>
          </div>
        </dl>
      </div>

      <div v-else class="work-idle">
        <p class="work-empty">
          当前没有兼职，等待好友雇佣你。
        </p>
        <dl class="work-details">
          <div>
            <dt>你的特长</dt>
            <dd>
              <strong>{{ state.work.talent_name || '—' }}</strong>
              <small v-if="state.work.talentDescription">{{ state.work.talentDescription }}</small>
            </dd>
          </div>
        </dl>
      </div>

      <footer v-if="shift" class="work-card__foot">
        <NButton type="primary" :disabled="busy" @click="emit('navigate', 'workItems')">
          工作事项
        </NButton>
      </footer>
    </section>

    <section class="work-card work-card--records" :style="{ maxHeight: `${shiftHeight}px` }" aria-labelledby="work-records-title">
      <header class="work-card__head">
        <h3 id="work-records-title">
          兼职记录<small>{{ state.work.slips?.length || 0 }}</small>
        </h3>
        <NButton size="small" type="primary" :disabled="busy || !hasPendingWages" @click="emit('operation', 'wages', {})">
          领取工资
        </NButton>
      </header>
      <ul v-if="state.work.slips?.length" class="work-records custom-scrollbar" tabindex="0" aria-label="兼职记录列表">
        <li v-for="slip in state.work.slips" :key="slip.shift_id" class="work-record">
          <div class="work-record__main">
            <strong>{{ slip.shop_name }}</strong>
            <small>{{ slip.employer?.name }} · {{ date(slip.begin_at) }} — {{ date(slip.end_at) }}</small>
            <small v-if="slip.interactionResult" class="work-record__extra">
              {{ slip.interactionResult.name }}
              <img v-if="slip.interactionResult.reward.image" :src="slip.interactionResult.reward.image" :alt="slip.interactionResult.reward.name">{{ signed(slip.interactionResult.reward.count) }}
            </small>
          </div>
          <div class="work-record__side">
            <span class="work-reward"><img :src="tokenImage" alt="奶茶券">{{ slip.wages?.final_wage ?? '—' }}</span>
            <span class="work-tag" :class="{ 'is-muted': Number(slip.wage_status) !== 1 }">{{ wageStatus(slip) }}</span>
          </div>
        </li>
      </ul>
      <p v-else class="work-empty">
        暂无工作记录
      </p>
    </section>
  </div>
</template>

<style scoped>
h3,
p,
dl,
dd {
  margin: 0;
}

small {
  display: block;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
}

strong,
small {
  overflow-wrap: anywhere;
}

.work-tag {
  flex: none;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  font-weight: var(--fw-600);
  line-height: 20px;
  white-space: nowrap;
}

.work-tag.is-muted {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.work-empty {
  padding: 16px 0;
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}

.work-reward {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  color: var(--ui-primary);
  font-size: 15px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.work-reward img {
  width: 22px;
  height: 22px;
  flex: none;
  object-fit: contain;
}

/* —— 我的工作：宽屏两栏 —— */
.work-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.work-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  padding: 18px 20px 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
}

.work-card__head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.work-card--records {
  min-height: 0;
  overflow: hidden;
}

.work-card__head h3 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 15px;
  font-weight: var(--fw-650);
}

.work-card__head h3 small {
  display: inline;
  color: var(--ui-subtle);
  font-weight: var(--fw-400);
}

.work-card__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--ui-border);
}

.work-shift,
.work-idle {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.work-employer {
  display: flex;
  align-items: center;
  gap: 12px;
}

.work-employer strong {
  display: block;
  font-size: 15px;
  font-weight: var(--fw-650);
}

.work-employer__avatar {
  width: 48px;
  height: 48px;
  flex: none;
  border-radius: 999px;
  object-fit: cover;
  background: var(--ui-surface-soft);
}

.work-employer__avatar--empty {
  display: inline-block;
  color: var(--ui-subtle);
}

.work-clock {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.work-clock__text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  font-variant-numeric: tabular-nums;
}

.work-clock__text strong {
  font-size: 18px;
  font-weight: var(--fw-700);
}

.work-clock__text time {
  color: var(--ui-muted);
  font-size: 12px;
}

.work-clock__track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-ink) 8%, transparent);
}

.work-clock__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ui-primary);
}

.work-details > div {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  font-size: 14px;
}

.work-details > div + div {
  border-top: 1px solid var(--ui-border);
}

.work-details dt {
  flex: none;
  color: var(--ui-muted);
}

.work-details dd {
  min-width: 0;
  text-align: right;
}

.work-details dd strong {
  font-weight: var(--fw-600);
}

.work-records {
  min-height: 0;
  margin: 0;
  padding: 0 12px 0 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  list-style: none;
}

.work-record {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
}

.work-record + .work-record {
  border-top: 1px solid var(--ui-border);
}

.work-record__main {
  min-width: 0;
}

.work-record__main strong {
  font-size: 14px;
  font-weight: var(--fw-600);
}

.work-record__extra {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.work-record__extra img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.work-record__side {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

/* —— 工作事项弹窗 —— */
.work-options {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
}

.work-choices {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  overscroll-behavior: contain;
  margin-inline: -4px;
  padding: 2px 4px 4px;
}

.work-choice {
  display: grid;
  grid-template-columns: 18px 56px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
  cursor: pointer;
  transition: border-color 0.16s ease;
}

.work-choice:hover:not(.is-disabled) {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
}

.work-choice.is-selected {
  border-color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.work-choice.is-disabled {
  cursor: default;
  opacity: 0.6;
}

.work-choice:focus-within {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.work-choice input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--ui-primary);
}

.work-choice__well {
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.work-choice__well img {
  width: 82%;
  height: 82%;
  object-fit: contain;
}

.work-choice__text strong {
  display: block;
  margin-bottom: 2px;
  font-size: 14px;
  font-weight: var(--fw-650);
}

.work-options__foot {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-muted);
  font-size: 13px;
}

.work-options__foot b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

@media (hover: hover) and (pointer: fine) {
  .work-records {
    scrollbar-color: transparent transparent;
  }

  .work-records:hover,
  .work-records:focus-visible {
    scrollbar-color: color-mix(in srgb, var(--ui-muted) 55%, transparent) transparent;
  }

  .work-records:not(:hover):not(:focus-visible)::-webkit-scrollbar-thumb {
    background: transparent;
  }
}

@container tea-content (min-width: 960px) {
  .work-page {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 20px;
  }
}

@media (max-width: 520px) {
  .work-card {
    padding: 16px;
  }

  .work-choice {
    grid-template-columns: 16px 44px minmax(0, 1fr);
    gap: 10px;
    padding: 10px 12px;
  }

  .work-choice__well {
    width: 44px;
    height: 44px;
  }
}
</style>
