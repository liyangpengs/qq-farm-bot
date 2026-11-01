<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

const { state, busy, selectionOnly = false } = defineProps<{ state: any, busy: boolean, selectionOnly?: boolean }>()
const emit = defineEmits<{ navigate: [page: string], operation: [action: string, input: any], confirmation: [value: any] }>()
const selected = ref<number | null>(null)
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
function duration(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`
}
function date(seconds: any) {
  return Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'
}
function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value}`
}
function confirm() {
  if (busy || !canInteract.value || !choice.value?.ready)
    return
  emit('confirmation', { action: 'interact', title: choice.value.name, description: choice.value.description, input: { interactionType: choice.value.interaction_id, expectedShiftId: String(shift.value.shift_id) } })
}
</script>

<template>
  <section v-if="selectionOnly" class="work-options">
    <div class="work-choices" role="radiogroup" aria-label="工作事项" tabindex="0">
      <label v-for="entry in state.interactions" :key="entry.interaction_id" class="work-choice" :class="{ selected: selected === entry.interaction_id }">
        <input v-model="selected" type="radio" name="milk-tea-work" :value="entry.interaction_id" :disabled="busy || !canInteract || !entry.ready">
        <img :src="entry.image" alt="" width="64" height="64">
        <span><strong>{{ entry.name }}</strong><small>{{ entry.description }}</small></span>
      </label>
    </div>
    <footer>
      <span>本班次剩余次数：{{ state.work.interact_done ? 0 : chances }}/{{ shift?.interact_limit || 0 }}</span>
      <button class="primary" :disabled="busy || !canInteract || !choice?.ready" @click="confirm">
        确认选择
      </button>
    </footer>
  </section>
  <div v-else class="work-page">
    <section class="work-paper">
      <header><h2>本次兼职信息</h2><span class="tag">{{ shift && remaining ? '兼职中' : '空闲中' }}</span></header>
      <div v-if="shift" class="shift">
        <div class="employer">
          <small>你的老板是：</small>
          <img v-if="shift.employer?.avatar" class="avatar" :src="shift.employer.avatar" alt="">
          <strong>{{ shift.employer?.name || '—' }}</strong>
          <small>{{ shift.shop_name }}</small>
        </div>
        <div class="shift-details">
          <strong>{{ remaining ? `剩余 ${duration(remaining)}` : '已结束' }}</strong>
          <time>{{ date(shift.end_at) }}</time>
          <div class="shift-progress" role="progressbar" aria-label="班次进度" :aria-valuenow="Math.round(progress)" :aria-valuemin="0" :aria-valuemax="100">
            <span :style="{ width: `${progress}%` }" />
          </div>
          <div class="detail-row">
            <span>你的特长</span><strong>{{ shift.talent_name || state.work.talent_name }}</strong>
          </div>
          <small class="talent-description">{{ state.work.talentDescription }}</small>
          <div class="detail-row">
            <span>预计工资</span><strong class="reward"><img :src="tokenImage" alt="奶茶券">{{ shift.baseWage == null ? '—' : signed(shift.baseWage) }}</strong>
          </div>
          <div v-if="shift.interactionResult" class="detail-row">
            <span>{{ shift.interactionResult.name }}</span><strong class="reward"><img v-if="shift.interactionResult.reward.image" :src="shift.interactionResult.reward.image" :alt="shift.interactionResult.reward.name">{{ signed(shift.interactionResult.reward.count) }}</strong>
          </div>
        </div>
      </div>
      <p v-else class="empty">
        暂无工作
      </p>
      <div v-if="!shift" class="detail-row">
        <span>你的特长</span><strong>{{ state.work.talent_name || '—' }}</strong>
      </div>
      <small v-if="!shift">{{ state.work.talentDescription }}</small>
      <footer>
        <button :disabled="busy" @click="emit('navigate', 'settings')">
          店铺设置
        </button>
        <button v-if="shift" class="primary" :disabled="busy" @click="emit('navigate', 'workItems')">
          工作事项
        </button>
      </footer>
    </section>
    <section class="work-paper work-records">
      <h2>兼职记录</h2>
      <div class="record-list" role="region" aria-label="兼职记录" tabindex="0">
        <article v-for="slip in state.work.slips" :key="slip.shift_id" class="work-record">
          <header><strong>{{ slip.shop_name }}</strong><span class="tag">{{ Number(slip.wage_status) === 2 ? '已领取' : Number(slip.wage_status) === 1 ? '待领取' : '—' }}</span></header>
          <small>{{ slip.employer?.name }}</small>
          <small>{{ date(slip.begin_at) }} — {{ date(slip.end_at) }}</small>
          <div class="detail-row">
            <span>工资</span><strong class="reward"><img :src="tokenImage" alt="奶茶券">{{ slip.wages?.final_wage ?? '—' }}</strong>
          </div>
          <div v-if="slip.interactionResult" class="detail-row">
            <span>{{ slip.interactionResult.name }}</span><strong class="reward"><img v-if="slip.interactionResult.reward.image" :src="slip.interactionResult.reward.image" :alt="slip.interactionResult.reward.name">{{ signed(slip.interactionResult.reward.count) }}</strong>
          </div>
        </article>
        <p v-if="!state.work.slips?.length" class="empty">
          暂无工作记录
        </p>
      </div>
      <footer>
        <button class="primary" :disabled="busy || !state.work.slips?.some((value: any) => Number(value.wage_status) === 1)" @click="emit('operation', 'wages', {})">
          领取工资
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.work-page {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.work-paper {
  padding: 20px;
  border: 2px solid var(--edge);
  border-radius: 18px;
  background: var(--paper-hi);
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 18px;
  font-weight: var(--fw-900);
}
header,
.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
header {
  margin-bottom: 16px;
}
strong,
small {
  overflow-wrap: anywhere;
}
small {
  display: block;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  font-weight: var(--fw-500);
}
.tag {
  flex-shrink: 0;
  border-radius: 8px;
  padding: 3px 8px;
  background: #eddbb7;
  font-size: 12px;
}
.shift {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) minmax(0, 2fr);
  gap: 20px;
}
.employer {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  border-radius: 12px;
  background: #f5e8cc;
  text-align: center;
  min-width: 0;
}
.avatar {
  width: 58px;
  height: 58px;
  object-fit: cover;
  border-radius: 50%;
}
.shift-details {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.detail-row {
  font-size: 14px;
}
.detail-row > span {
  flex-shrink: 0;
  color: var(--muted);
}
.detail-row > strong {
  text-align: right;
}
.talent-description {
  margin-top: -6px;
  text-align: right;
}
.shift-progress {
  height: 8px;
  background: #e8d8bd;
  border-radius: 8px;
  overflow: hidden;
}
.shift-progress > span {
  display: block;
  height: 100%;
  background: #bd8855;
  border-radius: inherit;
}
.reward {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  color: #a46135;
  font-size: 18px;
}
.reward img {
  width: 26px;
  height: 26px;
  object-fit: contain;
  flex-shrink: 0;
}
.record-list {
  max-height: 420px;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
  overscroll-behavior: contain;
}
.work-record {
  padding: 12px 0;
  border-bottom: 1px dashed var(--edge);
}
.work-record header {
  margin-bottom: 2px;
}
.work-record .detail-row {
  margin-top: 8px;
}
.empty {
  padding: 24px 0;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}
footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 12px;
  padding: 16px 0 4px;
  flex-shrink: 0;
}
button {
  min-height: 40px;
  padding: 8px 18px;
  border: 2px solid var(--wood-dark);
  border-radius: 12px;
  background: #f1e1c2;
  box-shadow: 0 3px 0 var(--wood-dark);
  color: var(--ink);
  font: inherit;
  font-weight: var(--fw-800);
  cursor: pointer;
}
button.primary {
  background: linear-gradient(180deg, #ffe58e, #ffc847);
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button:focus-visible,
.work-choice:focus-within {
  outline: 2px solid #b8741f;
  outline-offset: 3px;
}
.work-options {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.work-choices {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding: 4px;
  scrollbar-width: thin;
  overscroll-behavior: contain;
}
.work-choice {
  display: grid;
  grid-template-columns: 18px 64px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 2px solid var(--edge);
  border-radius: 14px;
  background: var(--paper-hi);
  cursor: pointer;
}
.work-choice.selected {
  border-color: #bf8a2e;
  background: #fff2ce;
}
.work-choice input {
  margin: 0;
  width: 18px;
  height: 18px;
  accent-color: #aa702e;
}
.work-choice img {
  object-fit: contain;
}
.work-choice strong {
  display: block;
  margin-bottom: 4px;
}
.work-choice:has(input:disabled) {
  cursor: default;
}
.work-options footer {
  font-size: 13px;
}
@media (max-width: 520px) {
  .work-paper {
    padding: 14px;
  }
  .shift {
    grid-template-columns: minmax(76px, 1fr) minmax(0, 2fr);
    gap: 10px;
  }
  .employer {
    padding: 8px;
  }
  .detail-row {
    font-size: 12px;
    gap: 6px;
  }
  .reward {
    font-size: 16px;
  }
  .work-choice {
    grid-template-columns: 18px 44px minmax(0, 1fr);
    padding: 10px;
    gap: 8px;
  }
  .work-choice img {
    width: 44px;
    height: 52px;
  }
}
</style>
