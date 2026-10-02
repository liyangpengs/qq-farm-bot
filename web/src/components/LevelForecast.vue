<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ forecast: any }>()
const timeText = computed(() => {
  const value = props.forecast
  if (!value || !value.estimatedAt)
    return value?.plotCount ? '本轮收获不足升级' : '等待预测数据'
  if (value.source === 'ready')
    return '收获后可升级'
  const minutes = Math.max(1, Math.ceil((value.estimatedAt - value.generatedAt) / 60000))
  const duration = minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`
  return value.source === 'planted' ? `约 ${duration}后收获可升级` : `约 ${duration}后升级`
})
const basis = computed(() => ({ planted: '按当前作物', ready: '待收获', mixed: '收获排期 + 历史均值', history: '历史均值估算' }[props.forecast?.source as string] || ''))
</script>

<template>
  <div class="mt-2 text-xs space-y-1" aria-label="升级预测">
    <div class="flex flex-wrap items-center justify-between gap-1">
      <span class="text-gray-700 dark:text-gray-200">{{ timeText }}</span>
      <span class="text-gray-400">{{ basis }}</span>
    </div>
    <div v-if="forecast?.plotCount" class="text-gray-500" title="按当前季作物和土地经验加成估算，不计未确认的随机加成；经验需收获后获得。">
      已种植 {{ forecast.plotCount }} 处 · 预计 {{ forecast.scheduledExp.toLocaleString('zh-CN') }} 经验
    </div>
    <div v-if="forecast?.plotCount && !forecast.automatic" class="text-amber-600 dark:text-amber-400">
      收获时间取决于手动操作或恢复自动农场
    </div>
  </div>
</template>
