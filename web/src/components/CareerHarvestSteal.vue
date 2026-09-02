<script setup lang="ts">
import { computed } from 'vue'

export interface CareerHarvestSteal {
  harvest: number
  steal: number
}

const props = defineProps<{
  career: CareerHarvestSteal | null | undefined
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
