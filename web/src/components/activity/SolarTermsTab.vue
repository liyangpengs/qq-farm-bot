<script setup lang="ts">
import type { SolarTermsDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'
import RewardItem from './RewardItem.vue'

const props = defineProps<{ solar: SolarTermsDto | null, now: number, pending?: boolean }>()
const emit = defineEmits<{ claim: [termId: string] }>()
const selectedId = ref('')
function activeTermId(solar: SolarTermsDto | null) {
  if (!solar || !Number.isFinite(props.now))
    return ''

  return solar.terms.find(term => (
    Number.isFinite(term.startTime)
    && Number.isFinite(term.endTime)
    && term.startTime! <= props.now
    && props.now <= term.endTime!
  ))?.id || ''
}
watch(() => props.solar, (solar) => {
  if (!solar?.terms.some(term => term.id === selectedId.value))
    selectedId.value = activeTermId(solar) || solar?.currentTermId || solar?.terms.find(term => term.current)?.id || solar?.terms[0]?.id || ''
}, { immediate: true })
const current = computed(() => props.solar?.terms.find(term => term.id === selectedId.value) ?? null)
const rewardTitle = computed(() => current.value?.rewardTitle || props.solar?.rewardTitle || '')
const rewardDescription = computed(() => current.value?.rewardDescription || props.solar?.rewardDescription || '')
const timeStatus = computed(() => {
  const startTime = current.value?.startTime
  const endTime = current.value?.endTime
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || !Number.isFinite(props.now))
    return 'unavailable'

  const now = Math.floor(props.now / 1000)
  const start = Math.floor(startTime! / 1000)
  const end = Math.floor(endTime! / 1000)
  if (start > end)
    return 'unavailable'
  if (now < start)
    return 'not-started'
  if (now > end)
    return 'expired'
  return 'active'
})
const canClaim = computed(() => Boolean(current.value && !current.value.claimed && timeStatus.value === 'active' && !props.pending))
const rewardsLocked = computed(() => timeStatus.value === 'not-started')
const buttonLabel = computed(() => {
  if (props.pending)
    return '领取中…'
  if (current.value?.claimed)
    return '已领取'
  if (timeStatus.value === 'not-started')
    return '未开始'
  if (timeStatus.value === 'expired')
    return '已过期'
  if (timeStatus.value === 'active')
    return '领取'
  return '暂不可领取'
})
function claim() {
  if (canClaim.value && current.value)
    emit('claim', current.value.id)
}
</script>

<template>
  <div class="solar-tab">
    <div v-if="solar?.terms.length" class="term-rail" aria-label="节令列表">
      <button v-for="term in solar.terms" :key="term.id" type="button" :class="{ active: term.id === selectedId, locked: term.locked }" @click="selectedId = term.id">
        <span>{{ term.name || '—' }}</span><i v-if="term.claimable" aria-label="可领取" />
      </button>
    </div>
    <section class="solar-reward">
      <h3 v-if="rewardTitle">
        {{ rewardTitle }}
      </h3>
      <p v-if="rewardDescription">
        {{ rewardDescription }}
      </p>
      <div v-if="current?.rewards.length" class="solar-reward__items">
        <RewardItem v-for="(reward, index) in current.rewards" :key="reward.id || index" :name="reward.name" :count="reward.count" :image="reward.image" :rarity="reward.rarity" :locked="rewardsLocked" :claimed="current.claimed" />
      </div>
      <div v-else class="solar-reward__empty">
        暂无数据
      </div>
      <button type="button" :disabled="!canClaim" @click="claim">
        {{ buttonLabel }}
      </button>
    </section>
  </div>
</template>

<style scoped>
.solar-tab {
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(240px, 0.8fr) minmax(360px, 1.2fr);
  align-content: start;
  gap: 16px;
  padding: 24px;
  color: #203a32;
  background: transparent;
}

.term-rail {
  position: static;
  width: auto;
  height: auto;
  grid-column: 1 / -1;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 7px;
  overflow-x: auto;
  padding: 0 0 8px;
  scrollbar-width: none;
}

.term-rail::before {
  display: none;
}

.term-rail button,
.term-rail button.active {
  position: relative;
  width: auto;
  min-width: 72px;
  min-height: 36px;
  flex: none;
  padding: 7px 11px;
  border: 1px solid rgba(48, 82, 70, 0.14);
  border-radius: 10px;
  color: #677871;
  background: rgba(255, 255, 255, 0.58);
  box-shadow: none;
  font-weight: 400;
  cursor: pointer;
}

.term-rail button.active {
  border-color: rgba(38, 128, 94, 0.28);
  color: #236e52;
  background: rgba(226, 245, 237, 0.9);
  font-weight: 700;
}

.term-rail button.locked {
  filter: grayscale(0.65);
  opacity: 0.6;
}

.term-rail i {
  position: absolute;
  top: -1px;
  right: 0;
  width: 9px;
  height: 9px;
  border: 1px solid white;
  border-radius: 50%;
  background: #ff4058;
}

.solar-reward {
  grid-column: 1 / -1;
  min-height: 280px;
  margin: 0;
  padding: 28px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 12px 30px rgba(38, 69, 57, 0.07);
  text-align: left;
}

.solar-reward h3 {
  margin: 0;
  color: #2b5b4a;
  font-size: 18px;
}

.solar-reward p {
  min-height: 1em;
  margin: 6px 0 18px;
  color: #73847d;
  font-size: 11px;
  white-space: pre-line;
}

.solar-reward__items {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
}

.solar-reward__empty {
  padding: 16px;
  color: #719b95;
  font-size: 12px;
}

.solar-reward button {
  display: block;
  width: 124px;
  margin: 22px 0 0;
  padding: 9px;
  border: 1px solid #2f8d69;
  border-radius: 10px;
  color: white;
  background: #2f8d69;
  box-shadow: 0 8px 18px rgba(35, 113, 83, 0.18);
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}

.solar-reward button:disabled {
  filter: grayscale(0.5);
  opacity: 0.58;
  cursor: not-allowed;
}

@media (max-width: 760px) {
  .solar-tab {
    grid-template-columns: 1fr;
    gap: 10px;
    padding: 14px;
  }

  .term-rail {
    grid-column: auto;
  }

  .solar-reward {
    min-height: auto;
    padding: 16px;
    text-align: center;
  }

  .solar-reward__items {
    justify-content: center;
  }

  .solar-reward button {
    width: 96px;
    min-height: 34px;
    margin: 12px auto 0;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 13px;
  }
}
</style>
