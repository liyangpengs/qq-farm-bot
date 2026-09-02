<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCheckbox, NCheckboxGroup } from 'naive-ui/es/checkbox'
import { computed, ref, watch } from 'vue'

export interface BagSeedPriorityItemSeed {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
  image?: string
}

const props = defineProps<{
  seed: BagSeedPriorityItemSeed
  index: number
  landTypes?: string[]
  landTypeOptions: Array<{ label: string, value: string }>
  dragging: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}>()

const emit = defineEmits<{
  'moveUp': []
  'moveDown': []
  'update:landTypes': [value: string[]]
  'dragStart': [event: DragEvent]
  'dragEnd': []
  'dragOver': [event: DragEvent]
  'drop': [event: DragEvent]
}>()

const chevronUpIconClass = 'i-carbon-chevron-up'
const chevronDownIconClass = 'i-carbon-chevron-down'

const imageFailed = ref(false)
const editing = ref(false)

// 勾满全部类型和一个都不勾都等价于不限制，不在界面上保留这两种中间态。
const restricted = computed(() => {
  const count = props.landTypes?.length ?? 0
  return count > 0 && count < props.landTypeOptions.length
})

const restrictionLabel = computed(() => {
  if (!restricted.value)
    return '不限制'
  const labels = props.landTypeOptions
    .filter(option => props.landTypes?.includes(option.value))
    .map(option => option.label)
  return `仅种 ${labels.join('、')}`
})

watch(restricted, (value) => {
  if (!value)
    editing.value = false
})

function handleLandTypesChange(value: (string | number)[]) {
  const next = value.map(String)
  emit('update:landTypes', next.length === props.landTypeOptions.length ? [] : next)
}
</script>

<template>
  <div
    class="flex flex-col gap-2 border cartoon-card border-amber-200 rounded-xl bg-white px-3 py-2.5 dark:border-amber-700/50 dark:bg-gray-800"
    :class="{ 'opacity-60 ring-2 ring-amber-400': dragging }"
    draggable="true"
    @dragstart="emit('dragStart', $event)"
    @dragend="emit('dragEnd')"
    @dragover.prevent="emit('dragOver', $event)"
    @drop="emit('drop', $event)"
  >
    <div class="flex items-center gap-2">
      <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-100 text-xs text-amber-700 font-bold dark:bg-amber-900/50 dark:text-amber-300">
        {{ index + 1 }}
      </div>
      <div class="h-9 w-9 flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-amber-50 dark:bg-gray-700">
        <img
          v-if="seed.image && !imageFailed"
          :src="seed.image"
          :alt="`${seed.name}种子`"
          class="h-9 w-9 object-contain"
          loading="lazy"
          @error="imageFailed = true"
        >
        <span v-else class="i-carbon-sprout text-lg text-amber-500 dark:text-amber-300" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <div class="truncate text-sm text-gray-800 font-semibold dark:text-gray-200">
            {{ seed.name }}
          </div>
          <span class="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 font-semibold dark:bg-amber-900/50 dark:text-amber-300">
            {{ seed.plantSize }}x{{ seed.plantSize }}
          </span>
        </div>
        <div class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          库存 {{ seed.count }} · {{ seed.requiredLevel }} 级 · ID {{ seed.seedId }}
        </div>
      </div>
      <div class="flex shrink-0 flex-col gap-2">
        <NButton
          quaternary
          circle
          size="tiny"
          :disabled="!canMoveUp"
          title="上移"
          aria-label="上移"
          @click="emit('moveUp')"
        >
          <span :class="chevronUpIconClass" />
        </NButton>
        <NButton
          quaternary
          circle
          size="tiny"
          :disabled="!canMoveDown"
          title="下移"
          aria-label="下移"
          @click="emit('moveDown')"
        >
          <span :class="chevronDownIconClass" />
        </NButton>
      </div>
    </div>

    <div class="border-t border-amber-100 pt-2 dark:border-amber-800/40" @mousedown.stop>
      <button
        type="button"
        class="w-full flex items-center justify-between gap-2 rounded text-left text-xs"
        :class="restricted ? 'text-amber-700 font-medium dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'"
        @click="editing = !editing"
      >
        <span class="truncate">土地：{{ restrictionLabel }}</span>
        <span class="shrink-0" :class="editing ? chevronUpIconClass : chevronDownIconClass" />
      </button>
      <div v-if="editing" class="mt-2">
        <NCheckboxGroup
          :value="landTypes ?? []"
          @update:value="handleLandTypesChange"
        >
          <div class="grid grid-cols-2 gap-1.5">
            <NCheckbox
              v-for="option in landTypeOptions"
              :key="option.value"
              :value="option.value"
              size="small"
            >
              <span class="text-xs">{{ option.label }}</span>
            </NCheckbox>
          </div>
        </NCheckboxGroup>
        <p class="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
          不勾或勾满即为不限制。
        </p>
      </div>
    </div>
  </div>
</template>
