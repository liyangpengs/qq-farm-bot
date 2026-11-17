<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useToastStore } from '@/stores/toast'

/** 首次读取失败保留重试入口；已有数据时用轻提示展示错误，待核对操作保留确认入口。 */
defineEmits<{ retry: [] }>()
const ranch = useRanchStore()
const { state, error, busy } = storeToRefs(ranch)
const toast = useToastStore()
watch(error, (message) => {
  if (message && state.value)
    toast.error(message)
}, { immediate: true })
const { currentAccountId } = storeToRefs(useAccountStore())
const pending = ref<{ id: string, label: string } | null>(null)
async function acknowledge() {
  if (!pending.value || !currentAccountId.value)
    return
  const done = await ranch.execute(currentAccountId.value, 'acknowledge', { id: pending.value.id }, { signature: '' }, { quiet: true })
  if (done) {
    pending.value = null
    await ranch.reload(currentAccountId.value)
  }
}
</script>

<template>
  <div v-if="!state && !error" class="ranch-gate__loading" role="status" aria-label="正在读取牧场">
    <span class="i-svg-spinners-90-ring-with-bg" />
  </div>
  <EmptyState v-else-if="!state" tone="error" title="牧场读取失败" :description="error" icon="i-carbon-warning-alt">
    <NButton secondary @click="$emit('retry')">
      重新读取
    </NButton>
  </EmptyState>
  <EmptyState v-else-if="!state.unlocked" title="牧场尚未开放" :description="state.reason" icon="i-carbon-locked" />
  <template v-else>
    <div v-for="operation in state.pendingOperations" :key="operation.id" class="ranch-gate__message" role="status">
      <span class="min-w-0 flex-1">
        {{ operation.label }}
        <span v-for="cost in operation.costs" :key="cost.resourceKey" class="ml-2">{{ cost.name }} ×{{ cost.amount }}</span>
        <span class="mt-1 block">{{ operation.message }}</span>
      </span>
      <NButton size="small" :disabled="busy" @click="pending = operation">
        核对结果
      </NButton>
    </div>
    <slot />
    <ConfirmModal
      :show="!!pending"
      title="确认已核对操作结果"
      :message="`请先在游戏中核对“${pending?.label || ''}”的库存和结果。确认后解除该操作的重复提交保护，自动巡查可继续执行。`"
      confirm-text="已核对，解除保护"
      :loading="busy"
      @confirm="acknowledge"
      @cancel="pending = null"
    />
  </template>
</template>

<style scoped>
.ranch-gate__loading {
  display: grid;
  min-height: 280px;
  place-items: center;
  color: var(--ui-primary);
  font-size: 28px;
}

.ranch-gate__message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--ui-radius-control);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.ranch-gate__message button {
  display: grid;
  flex: none;
  place-items: center;
  color: inherit;
}
</style>
