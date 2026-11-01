<script setup lang="ts">
import { computed } from 'vue'

export interface CareerHarvestSteal {
  harvest: number
  steal: number
}

const props = defineProps<{
  career: CareerHarvestSteal | null | undefined
  compact?: boolean
}>()

function formatWan(count: number) {
  const wan = Math.max(0, count) / 10000
  const text = wan.toFixed(2).replace(/\.?0+$/, '')
  return `${text}万`
}

const harvest = computed(() => Math.max(0, Number(props.career?.harvest) || 0))
const steal = computed(() => Math.max(0, Number(props.career?.steal) || 0))
const harvestText = computed(() => formatWan(harvest.value))
const stealText = computed(() => formatWan(steal.value))
const ratioText = computed(() => {
  if (harvest.value <= 0)
    return steal.value > 0 ? '--' : '0%'
  const percent = steal.value / harvest.value * 100
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`
})
</script>

<template>
  <template v-if="career">
    <template v-if="compact">
      <span class="career-stat" title="生涯收获">
        <span class="i-carbon-wheat text-green-600 dark:text-green-400" aria-hidden="true" />
        <span class="career-stat__label">生涯收获</span>
        <b>{{ harvestText }}</b>
      </span>
      <span class="career-stat" title="生涯偷菜">
        <span class="i-carbon-run text-orange-600 dark:text-orange-400" aria-hidden="true" />
        <span class="career-stat__label">生涯偷菜</span>
        <b>{{ stealText }}</b>
      </span>
      <span class="career-stat" title="生涯偷菜 / 生涯收获">
        <span class="i-carbon-chart-relationship text-sky-600 dark:text-sky-400" aria-hidden="true" />
        <span class="career-stat__label">收偷比</span>
        <b>{{ ratioText }}</b>
      </span>
    </template>
    <template v-else>
      <div class="flex items-center gap-1.5 text-green-700 dark:text-green-300">
        <div class="i-carbon-wheat" />
        <span class="font-body font-semibold">生涯收获: {{ harvestText }}</span>
      </div>
      <div class="flex items-center gap-1.5 text-orange-700 dark:text-orange-300">
        <div class="i-carbon-run" />
        <span class="font-body font-semibold">生涯偷菜: {{ stealText }}</span>
      </div>
      <div class="flex items-center gap-1.5 text-sky-700 dark:text-sky-300">
        <div class="i-carbon-chart-relationship" />
        <span class="font-body font-semibold">收偷比: {{ ratioText }}</span>
      </div>
    </template>
  </template>
</template>

<style scoped>
.career-stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.career-stat b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}
</style>
