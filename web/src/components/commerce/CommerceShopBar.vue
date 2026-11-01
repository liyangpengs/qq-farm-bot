<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'

// 商城与神秘商人共用的信息栏：左侧状态，右侧货币余额与刷新。
withDefaults(defineProps<{
  status?: string
  statusTone?: 'muted' | 'violet' | 'warning'
  statusIcon?: string
  currencies?: Array<{ id: number | string, name: string, image: string, amount: number | null }>
  loading?: boolean
  disabled?: boolean
  refreshLabel?: string
}>(), {
  status: '',
  statusTone: 'muted',
  statusIcon: 'i-carbon-time',
  currencies: () => [],
  loading: false,
  disabled: false,
  refreshLabel: '刷新',
})

defineEmits<{ refresh: [] }>()
</script>

<template>
  <header class="shop-bar">
    <p v-if="status" class="shop-bar__status" :class="`is-${statusTone}`">
      <span :class="statusIcon" aria-hidden="true" />
      <span>{{ status }}</span>
    </p>
    <span v-else />

    <div class="shop-bar__end">
      <span
        v-for="currency in currencies"
        :key="currency.id"
        class="shop-currency"
        :title="`${currency.name}：${currency.amount === null ? '余额未确认' : currency.amount.toLocaleString()}`"
      >
        <CommerceItemImage :src="currency.image" :alt="currency.name" size="sm" />
        <b>{{ currency.amount === null ? '--' : currency.amount.toLocaleString() }}</b>
      </span>
      <NButton secondary circle :loading="loading" :disabled="disabled" :title="refreshLabel" :aria-label="refreshLabel" @click="$emit('refresh')">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </div>
  </header>
</template>

<style scoped>
.shop-bar {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.shop-bar__status {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ui-muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.shop-bar__status span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shop-bar__status.is-violet {
  color: var(--ui-violet);
  font-weight: var(--fw-600);
}

.shop-bar__status.is-warning {
  color: var(--ui-warning);
  font-weight: var(--fw-600);
}

.shop-bar__end {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.shop-currency {
  height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px 0 6px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-ink);
  background: var(--ui-surface);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.shop-currency :deep(.item-image) {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
}

.shop-currency b {
  font-weight: var(--fw-650);
}

@media (max-width: 520px) {
  .shop-bar {
    flex-wrap: wrap;
  }

  .shop-bar__end {
    width: 100%;
    justify-content: flex-start;
  }

  .shop-bar__end > :last-child {
    margin-left: auto;
  }
}
</style>
