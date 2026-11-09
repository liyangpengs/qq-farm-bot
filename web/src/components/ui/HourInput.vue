<script setup lang="ts">
import { NInput } from 'naive-ui/es/input'
import { computed, useId } from 'vue'
import { parseHourOfDay } from '@/utils/hour-of-day'

const props = defineProps<{ label: string, help?: string, disabled?: boolean }>()
// 保留无效草稿，让输入错误可见，避免保存时悄悄使用旧值。
const model = defineModel<number | string>({ required: true })
const id = useId()
const hour = computed(() => parseHourOfDay(model.value))
const invalid = computed(() => hour.value === null)
const text = computed({
  get: () => String(model.value ?? ''),
  set: (value: string) => model.value = parseHourOfDay(value) ?? value,
})

function step(offset: number) {
  if (!props.disabled)
    model.value = ((hour.value ?? 10) + offset + 24) % 24
}

function handleKeydown(event: KeyboardEvent) {
  if (!event.isComposing && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    step(event.key === 'ArrowUp' ? 1 : -1)
  }
}
</script>

<template>
  <div class="base-field">
    <label class="base-field__label" :for="id" :title="help">{{ label }}</label>
    <NInput
      v-model:value="text"
      :disabled="disabled"
      :status="invalid ? 'error' : undefined"
      :input-props="{
        id,
        'inputmode': 'numeric',
        'role': 'spinbutton',
        'aria-valuemin': 0,
        'aria-valuemax': 23,
        'aria-valuenow': hour ?? undefined,
        'aria-invalid': invalid,
        'aria-describedby': invalid ? `${id}-error` : undefined,
      }"
      @keydown="handleKeydown"
    >
      <template #suffix>
        <div class="hour-input__buttons">
          <button type="button" :disabled="disabled" aria-label="减少 1 小时" @click="step(-1)">
            <span class="i-carbon-subtract" aria-hidden="true" />
          </button>
          <button type="button" :disabled="disabled" aria-label="增加 1 小时" @click="step(1)">
            <span class="i-carbon-add" aria-hidden="true" />
          </button>
        </div>
      </template>
    </NInput>
    <span v-if="invalid" :id="`${id}-error`" class="text-xs text-[var(--ui-danger)]" role="alert">请输入 0–23 的整数</span>
  </div>
</template>

<style scoped>
.hour-input__buttons {
  display: flex;
  align-items: center;
  gap: 2px;
  color: var(--ui-subtle);
}

.hour-input__buttons button {
  display: grid;
  width: 20px;
  height: 24px;
  place-items: center;
  border-radius: 4px;
  font-size: 16px;
  cursor: pointer;
}

.hour-input__buttons button:hover:not(:disabled) {
  color: var(--ui-primary);
  background: var(--ui-surface-soft);
}

.hour-input__buttons button:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 1px;
}

.hour-input__buttons button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
