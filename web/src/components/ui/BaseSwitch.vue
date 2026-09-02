<script setup lang="ts">
import { NSwitch } from 'naive-ui/es/switch'

const props = defineProps<{
  label?: string
  disabled?: boolean
}>()

const model = defineModel<boolean>()

function toggleFromLabel() {
  if (!props.disabled)
    model.value = !model.value
}
</script>

<template>
  <div class="base-switch">
    <NSwitch v-model:value="model" :disabled="disabled" size="small" />
    <button
      v-if="label"
      type="button"
      class="base-switch__label"
      :disabled="disabled"
      @click="toggleFromLabel"
    >
      {{ label }}
    </button>
  </div>
</template>
