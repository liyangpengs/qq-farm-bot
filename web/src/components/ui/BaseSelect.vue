<script setup lang="ts">
import { NSelect } from 'naive-ui/es/select'
import { computed, useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

defineProps<{
  label?: string
  options?: { label: string, value: string | number, disabled?: boolean }[]
  disabled?: boolean
  placeholder?: string
  clearable?: boolean
  filterable?: boolean
}>()

const emit = defineEmits<{
  (e: 'change', value: string | number): void
}>()

const attrs = useAttrs()
const model = defineModel<string | number>()
const selectValue = computed(() => model.value ?? null)

function updateValue(value: string | number | null) {
  if (value === null)
    return
  model.value = value
  emit('change', value)
}
</script>

<template>
  <div class="base-field">
    <label v-if="label" class="base-field__label">
      {{ label }}
    </label>
    <NSelect
      v-bind="attrs"
      :value="selectValue"
      :options="options || []"
      :disabled="disabled"
      :placeholder="placeholder || '请选择'"
      :clearable="clearable"
      :filterable="filterable"
      @update:value="updateValue"
    />
  </div>
</template>
