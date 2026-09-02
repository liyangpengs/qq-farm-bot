<script setup lang="ts">
import { NInput } from 'naive-ui/es/input'
import { useAttrs } from 'vue'

defineOptions({ inheritAttrs: false })

defineProps<{
  placeholder?: string
  label?: string
  disabled?: boolean
  rows?: number
}>()

const attrs = useAttrs()
const model = defineModel<string>()
</script>

<template>
  <div class="base-field">
    <label v-if="label" class="base-field__label" :for="String(attrs.id || '')">
      {{ label }}
    </label>
    <NInput
      v-model:value="model"
      v-bind="attrs"
      type="textarea"
      :rows="rows || 3"
      :placeholder="placeholder"
      :disabled="disabled"
    />
  </div>
</template>
