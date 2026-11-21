<script setup lang="ts">
import { computed } from 'vue'

export interface CareerHarvestSteal {
  harvest: number
  steal: number
  mature?: number
}

const props = withDefaults(defineProps<{
  career: CareerHarvestSteal | null | undefined
  variant?: 'inline' | 'tiles'
  compact?: boolean
}>(), {
  variant: 'inline',
})

function formatWan(count: number) {
  const wan = Math.max(0, count) / 10000
  const text = wan.toFixed(2).replace(/\.?0+$/, '')
  return `${text}万`
}

const harvest = computed(() => Math.max(0, Number(props.career?.harvest) || 0))
const steal = computed(() => Math.max(0, Number(props.career?.steal) || 0))
const mature = computed(() => Math.max(0, Number(props.career?.mature) || 0))
const harvestText = computed(() => formatWan(harvest.value))
const stealText = computed(() => formatWan(steal.value))
const ratioText = computed(() => {
  if (harvest.value <= 0) {
    if (props.career?.mature !== undefined)
      return '—'
    return steal.value > 0 ? '--' : '0%'
  }
  const percent = steal.value / harvest.value * 100
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`
})
const ranchMetrics = computed(() => [
  {
    label: '累计产物',
    value: harvest.value.toLocaleString('zh-CN'),
    icon: 'i-carbon-wheat text-amber-500',
    title: '牧场生涯累计收获产物',
  },
  {
    label: '累计成熟',
    value: mature.value.toLocaleString('zh-CN'),
    icon: 'i-carbon-growth text-emerald-500',
    title: '牧场生涯累计成熟次数',
  },
  {
    label: '收取好友产物',
    value: steal.value.toLocaleString('zh-CN'),
    icon: 'i-carbon-shopping-bag text-orange-500',
    title: '牧场生涯收取好友产物',
  },
  {
    label: '收偷比',
    value: ratioText.value,
    icon: 'i-carbon-chart-relationship text-sky-500',
    title: '收取好友产物 / 累计产物',
  },
])
</script>

<template>
  <dl
    v-if="career?.mature !== undefined"
    :class="variant === 'tiles' ? 'career-tiles' : 'career-inline'"
    aria-label="牧场生涯"
  >
    <div
      v-for="stat in ranchMetrics"
      :key="stat.label"
      :class="variant === 'tiles' ? 'career-tile' : 'career-stat'"
      :title="stat.title"
    >
      <dt :class="variant === 'tiles' ? 'career-tile__label' : 'career-stat__term'">
        <span :class="stat.icon" aria-hidden="true" />
        <span>{{ stat.label }}</span>
      </dt>
      <dd :class="variant === 'tiles' ? 'career-tile__value' : 'career-stat__value'" :title="stat.value">
        {{ stat.value }}
      </dd>
    </div>
  </dl>
  <template v-else-if="career">
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
.career-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  margin: 0 0 10px;
  font-size: 13px;
}

.career-stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.career-stat__term {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
}

.career-stat b,
.career-stat__value {
  margin: 0;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.career-tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

@media (min-width: 640px) {
  .career-tiles {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.career-tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.career-tile__label {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}

.career-tile__label > span:first-child {
  flex: none;
  font-size: 14px;
}

.career-tile__label > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
}

.career-tile__value {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 20px;
  font-weight: var(--fw-700);
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 520px) {
  .career-tile {
    padding: 10px 12px;
  }

  .career-tile__value {
    font-size: clamp(15px, 4.5vw, 18px);
  }
}
</style>
