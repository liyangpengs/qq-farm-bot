<script setup lang="ts">
import { NDropdown } from 'naive-ui/es/dropdown'
import { computed } from 'vue'
import { BUCKETS, formatHours } from '@/components/ranch/ranch-shared'

const props = withDefaults(defineProps<{
  buckets?: ReadonlyArray<{ id: number, name: string, seconds?: number | string }>
  limitedCanUsed?: boolean
  disabled?: boolean
}>(), { buckets: () => BUCKETS })
const emit = defineEmits<{ feed: [bucketType: 1 | 2, produceAfterFeed: boolean] }>()
const options = computed(() => props.buckets.flatMap((bucket) => {
  const bucketType: 1 | 2 = bucket.id === 7004 ? 1 : 2
  const alreadyUsed = bucketType === 2 && props.limitedCanUsed
  const disabled = alreadyUsed || (bucket.seconds !== undefined && Number(bucket.seconds) <= 0)
  const stock = bucket.seconds === undefined ? '' : `（剩余 ${formatHours(bucket.seconds)}）`
  const suffix = alreadyUsed ? '（本轮已用）' : stock
  return [false, true].map(produceAfterFeed => ({
    key: `${bucketType}-${produceAfterFeed}`,
    label: `${bucket.name}喂养${produceAfterFeed ? '并生产' : ''}${suffix}`,
    disabled,
    bucketType,
    produceAfterFeed,
  }))
}))
const unavailable = computed(() => props.disabled || options.value.every(option => option.disabled))

function select(key: string) {
  const option = options.value.find(item => item.key === key)!
  emit('feed', option.bucketType, option.produceAfterFeed)
}
</script>

<template>
  <NDropdown trigger="click" placement="bottom" :options="options" :disabled="unavailable" @select="select">
    <slot :unavailable="unavailable" />
  </NDropdown>
</template>
