<script setup lang="ts">
import type { RanchItem } from '@/stores/ranch'
import { computed, ref } from 'vue'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import { formatCount } from '@/components/ranch/ranch-shared'

const props = defineProps<{
  career: {
    harvest: number
    mature: number
    steal: number
    products: Array<RanchItem & { type?: number }>
  }
}>()

const category = ref<'all' | 'main' | 'secondary'>('all')
const metrics = computed(() => ({
  harvest: category.value === 'main' ? 0 : props.career.harvest,
  mature: category.value === 'secondary' ? 0 : props.career.mature,
  steal: category.value === 'main' ? 0 : props.career.steal,
}))
const ranking = computed(() => {
  const type = category.value === 'main' ? 106 : 107
  return props.career.products
    .filter(product => category.value === 'all' || product.type === type)
    .sort((left, right) => Number(right.count) - Number(left.count))
    .slice(0, 3)
})
</script>

<template>
  <section class="ov-card">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-lg font-display font-medium">
        牧场生涯
      </h3>
      <label class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>产物类别</span>
        <select v-model="category" class="border border-gray-200 rounded-lg bg-white px-2 py-1 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
          <option value="all">全部</option>
          <option value="main">主产物</option>
          <option value="secondary">副产物</option>
        </select>
      </label>
    </div>

    <CareerHarvestSteal :career="metrics" />

    <ol v-if="ranking.length" aria-label="产物排行" class="grid grid-cols-1 mb-0 mt-3 list-decimal list-inside gap-2 text-sm sm:grid-cols-3">
      <li v-for="product in ranking" :key="product.id" class="min-w-0 break-words">
        <span>{{ product.name }}</span>
        <b class="ml-2 tabular-nums">{{ formatCount(product.count) }}</b>
      </li>
    </ol>
  </section>
</template>
