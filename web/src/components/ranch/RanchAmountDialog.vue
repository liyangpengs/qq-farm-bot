<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { computed, ref, useId, watch } from 'vue'

/** 牧场操作共用的数量弹窗，可在数量下展示结算信息。 */
const props = withDefaults(defineProps<{
  show: boolean
  title: string
  name: string
  image?: string
  caption?: string
  max: number
  submitText?: string
  /** 额外条件未满足时（如未选设施）禁止下一步。 */
  ready?: boolean
}>(), { image: '', caption: '', submitText: '下一步', ready: true })

const emit = defineEmits<{ submit: [count: number], close: [] }>()
const quantityId = useId()
const count = ref<number | null>(1)
const limit = computed(() => Math.max(0, Math.min(2147483647, Math.floor(props.max))))
const quantity = computed(() => count.value !== null && Number.isSafeInteger(count.value) && count.value >= 1 && count.value <= limit.value ? count.value : null)

watch(() => props.show, (show) => {
  if (show)
    count.value = 1
})
watch(limit, (maximum) => {
  if (count.value !== null && count.value > maximum)
    count.value = Math.max(1, maximum)
})
</script>

<template>
  <NModal
    preset="card"
    style="width: 400px; max-width: calc(100% - 32px)"
    :show="show"
    :title="title"
    :aria-label="title"
    closable
    @update:show="value => !value && emit('close')"
    @close="emit('close')"
  >
    <div class="amount">
      <div class="amount__item">
        <span class="amount__well"><img v-if="image" :src="image" alt=""></span>
        <div>
          <strong>{{ name }}</strong>
          <small v-if="caption">{{ caption }}</small>
        </div>
      </div>
      <slot />
      <div class="amount__row">
        <label :for="quantityId">数量</label>
        <div class="amount__stepper">
          <NInputNumber v-model:value="count" :min="1" :max="limit || 1" :precision="0" :disabled="limit < 1" :input-props="{ id: quantityId, inputmode: 'numeric' }" class="w-32" />
          <NButton size="small" secondary :disabled="limit < 1 || count === limit" @click="count = limit">
            最大
          </NButton>
        </div>
      </div>
      <slot name="details" :count="quantity" />
    </div>
    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton secondary @click="emit('close')">
          取消
        </NButton>
        <NButton type="primary" :disabled="!ready || quantity === null" @click="quantity !== null && emit('submit', quantity)">
          {{ submitText }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.amount {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.amount__item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.amount__item > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.amount__item strong {
  font-size: 14px;
  font-weight: var(--fw-650);
}

.amount__item small {
  color: var(--ui-muted);
  font-size: 12px;
}

.amount__well {
  display: grid;
  width: 52px;
  height: 52px;
  flex: none;
  place-items: center;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.amount__well img {
  width: 72%;
  height: 72%;
  object-fit: contain;
}

.amount__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
}

.amount__stepper {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
