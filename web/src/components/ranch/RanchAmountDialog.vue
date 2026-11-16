<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { computed, ref, watch } from 'vue'

/** 先选数量（和放养设施），再交给报价确认框核对费用与内容。 */
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
const count = ref<number | null>(1)
const limit = computed(() => Math.max(1, Math.min(2147483647, Math.floor(props.max) || 1)))
const valid = computed(() => props.ready && Number.isSafeInteger(count.value) && count.value! >= 1 && count.value! <= limit.value)

watch(() => props.show, (show) => {
  if (show)
    count.value = 1
})
</script>

<template>
  <NModal :show="show" @update:show="value => !value && emit('close')">
    <NCard class="amount-card" :title="title" closable @close="emit('close')">
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
          <span>数量</span>
          <div class="amount__stepper">
            <NInputNumber v-model:value="count" :min="1" :max="limit" :precision="0" class="w-32" aria-label="数量" />
            <NButton size="small" secondary :disabled="count === limit" @click="count = limit">
              最大
            </NButton>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton secondary @click="emit('close')">
            取消
          </NButton>
          <NButton type="primary" :disabled="!valid" @click="emit('submit', count!)">
            {{ submitText }}
          </NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.amount-card {
  width: min(400px, calc(100vw - 32px));
}

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
