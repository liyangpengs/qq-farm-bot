<script setup lang="ts">
import type { RanchItem } from '@/stores/ranch'
import type { AutomationConfig } from '@/stores/setting'
import { NButton } from 'naive-ui/es/button'
import { computed, nextTick, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import { formatCount } from '@/components/ranch/ranch-shared'

const props = defineProps<{ accountId: string, connected: boolean }>()
const automation = defineModel<AutomationConfig>({ required: true })
const groups = [
  { housing: '窝', key: 'ranch_coop_cub_priority' },
  { housing: '棚', key: 'ranch_shed_cub_priority' },
] as const
type PriorityKey = typeof groups[number]['key']
interface CubStack extends RanchItem {
  animalId: number | null
  husbandryType: string | null
  locked: boolean
}

const inventory = ref<CubStack[]>([])
const loading = ref(false)
const error = ref('')
const refreshRevision = ref(0)
const status = ref('')
const dragging = ref<{ key: PriorityKey, id: number } | null>(null)

watch([() => props.accountId, () => props.connected, refreshRevision], async ([accountId, connected], _, onCleanup) => {
  inventory.value = []
  loading.value = connected && !!accountId
  error.value = ''
  status.value = ''
  dragging.value = null
  if (!accountId || !connected)
    return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  try {
    const { data } = await api.get('/api/ranch', {
      params: { view: 'bag' },
      headers: { 'x-account-id': accountId },
      signal: controller.signal,
      timeout: 45000,
      skipErrorToast: true,
    } as any)
    if (controller.signal.aborted)
      return
    if (!data.ok || !data.data?.unlocked) {
      error.value = data.error || data.data?.reason || '读取背包失败'
      return
    }
    inventory.value = data.data.bag
  }
  catch (cause) {
    if (!controller.signal.aborted)
      error.value = getApiErrorMessage(cause, '读取背包失败')
  }
  finally {
    if (!controller.signal.aborted)
      loading.value = false
  }
}, { immediate: true })

const sorted = computed(() => {
  const stock = new Map<number, CubStack>()
  for (const item of inventory.value) {
    if (!item.animalId || item.locked || BigInt(item.count) <= 0n)
      continue
    const count = BigInt(stock.get(item.id)?.count ?? '0') + BigInt(item.count)
    stock.set(item.id, { ...item, count: count.toString() })
  }
  return groups.map((group) => {
    const order = automation.value[group.key] ?? []
    const ranks = new Map(order.map((id, index) => [id, index]))
    const cubs = [...stock.values()].filter(item => item.husbandryType === group.housing)
    cubs.sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length)
      || b.animalId! - a.animalId! || a.id - b.id)
    return { ...group, cubs }
  })
})

function move(key: PriorityKey, id: number, target: number, control?: EventTarget | null) {
  const cubs = sorted.value.find(group => group.key === key)!.cubs
  const from = cubs.findIndex(cub => cub.id === id)
  if (from < 0 || target < 0 || target >= cubs.length || target === from)
    return
  const order = cubs.map(cub => cub.id)
  order.splice(from, 1)
  order.splice(target, 0, id)
  const visible = new Set(order)
  let position = 0
  // 缺货幼崽保留已保存的位置，补货后仍按原优先级放养。
  const merged = (automation.value[key] ?? []).map(item => visible.has(item) ? order[position++]! : item)
  automation.value = { ...automation.value, [key]: [...merged, ...order.slice(position)] }
  status.value = `${cubs[from]!.name}已移到第 ${target + 1} 位`
  if (control instanceof HTMLElement) {
    void nextTick(() => {
      if (control.isConnected)
        control.focus({ preventScroll: true })
    })
  }
}

function startDrag(key: PriorityKey, id: number, event: DragEvent) {
  if (!event.dataTransfer)
    return
  dragging.value = { key, id }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', String(id))
}

function dragOver(key: PriorityKey, event: DragEvent) {
  if (dragging.value?.key === key)
    event.preventDefault()
}

function drop(key: PriorityKey, target: number) {
  if (dragging.value?.key === key)
    move(key, dragging.value.id, target)
  dragging.value = null
}
</script>

<template>
  <div class="cub-priority">
    <div class="flex items-center justify-between gap-2">
      <h5 class="text-sm font-semibold">
        背包幼崽优先顺序
      </h5>
      <NButton quaternary circle size="small" aria-label="刷新幼崽库存" title="刷新幼崽库存" :disabled="!connected || loading" @click="refreshRevision++">
        <span class="i-carbon-renew" aria-hidden="true" />
      </NButton>
    </div>
    <p v-if="!connected" class="cub-priority__state">
      账号未在线，暂时无法读取库存
    </p>
    <p v-else-if="loading" class="cub-priority__state">
      正在读取背包幼崽…
    </p>
    <p v-else-if="error" class="cub-priority__state" role="alert">
      {{ error }}
    </p>
    <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div v-for="group in sorted" :key="group.key" class="cub-priority__group">
        <h6 class="mb-2 text-sm font-medium">
          {{ group.housing }}
        </h6>
        <p v-if="group.cubs.length === 0" class="cub-priority__state">
          暂无可用幼崽
        </p>
        <ol v-else class="m-0 list-none p-0 space-y-1.5" role="list" :aria-label="`${group.housing}的幼崽优先顺序`">
          <li
            v-for="(cub, index) in group.cubs"
            :key="cub.id"
            class="cub-priority__item"
            :class="{ 'opacity-60': dragging?.id === cub.id }"
            :draggable="group.cubs.length > 1"
            @dragstart="startDrag(group.key, cub.id, $event)"
            @dragend="dragging = null"
            @dragover="dragOver(group.key, $event)"
            @drop.prevent="drop(group.key, index)"
          >
            <span class="cub-priority__index" aria-hidden="true">{{ index + 1 }}</span>
            <CommerceItemImage :src="cub.image" alt="" size="sm" />
            <div class="min-w-0 flex-1">
              <div class="break-words text-sm font-medium">
                {{ cub.name }}
              </div>
              <div class="cub-priority__state">
                库存 {{ formatCount(cub.count) }}
              </div>
            </div>
            <div v-if="group.cubs.length > 1" class="flex shrink-0">
              <NButton quaternary circle size="small" :aria-disabled="index === 0" :aria-label="`上移${cub.name}`" title="上移" @click="move(group.key, cub.id, index - 1, $event.currentTarget)">
                <span class="i-carbon-chevron-up" aria-hidden="true" />
              </NButton>
              <NButton quaternary circle size="small" :aria-disabled="index === group.cubs.length - 1" :aria-label="`下移${cub.name}`" title="下移" @click="move(group.key, cub.id, index + 1, $event.currentTarget)">
                <span class="i-carbon-chevron-down" aria-hidden="true" />
              </NButton>
            </div>
          </li>
        </ol>
      </div>
    </div>
    <p class="sr-only" role="status">
      {{ status }}
    </p>
  </div>
</template>

<style scoped>
.cub-priority {
  display: grid;
  gap: 8px;
}

.cub-priority__group,
.cub-priority__item {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
}

.cub-priority__group {
  background: var(--ui-surface-soft);
}

.cub-priority__item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--ui-surface);
}

.cub-priority__item[draggable='true'] {
  cursor: grab;
}

.cub-priority__item :deep(button[aria-disabled='true']) {
  opacity: 0.35;
  cursor: default;
}

.cub-priority__index,
.cub-priority__state {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
