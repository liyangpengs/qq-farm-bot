<script setup lang="ts">
import { NInput } from 'naive-ui/es/input'
import { NInputNumber } from 'naive-ui/es/input-number'
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

defineProps<{
  type?: string
  placeholder?: string
  label?: string
  disabled?: boolean
  clearable?: boolean
  min?: string | number
  max?: string | number
  step?: string | number
}>()

const emit = defineEmits<{
  (e: 'clear'): void
}>()

const attrs = useAttrs()
const model = defineModel<string | number>()

const textValue = computed({
  get: () => model.value === undefined || model.value === null ? '' : String(model.value),
  set: (value: string) => {
    model.value = value
  },
})

const numberValue = computed<number | null>({
  get: () => {
    if (model.value === undefined || model.value === null || model.value === '')
      return null
    const value = Number(model.value)
    return Number.isFinite(value) ? value : null
  },
  set: (value) => {
    model.value = value === null ? '' : value
  },
})
</script>

<template>
  <div class="base-field">
    <label v-if="label" class="base-field__label" :for="String(attrs.id || '')">
      {{ label }}
    </label>
    <NInputNumber
      v-if="type === 'number'"
      v-model:value="numberValue"
      v-bind="attrs"
      class="w-full"
      :placeholder="placeholder"
      :disabled="disabled"
      :clearable="clearable"
      :min="min"
      :max="max"
      :step="step"
      @clear="emit('clear')"
    />
    <NInput
      v-else
      v-model:value="textValue"
      v-bind="attrs"
      :type="type === 'password' ? 'password' : 'text'"
      :placeholder="placeholder"
      :disabled="disabled"
      :clearable="clearable"
      :show-password-on="type === 'password' ? 'click' : undefined"
      @clear="emit('clear')"
    />
  </div>
</template>
