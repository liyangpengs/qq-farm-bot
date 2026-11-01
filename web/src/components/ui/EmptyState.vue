<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description?: string
  icon?: string
  tone?: 'default' | 'error'
  /** 嵌在卡片里使用时去掉边框与背景。 */
  bare?: boolean
}>(), { icon: 'i-carbon-information', tone: 'default', bare: false })
</script>

<template>
  <div class="empty-state" :class="{ 'empty-state--bare': bare, 'empty-state--error': tone === 'error' }" role="status">
    <span class="empty-state__badge" aria-hidden="true">
      <span class="empty-state__icon" :class="icon" />
    </span>
    <strong class="empty-state__title">{{ title }}</strong>
    <p v-if="description" class="empty-state__description">
      {{ description }}
    </p>
    <div v-if="$slots.default" class="empty-state__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 44px 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
  text-align: center;
}

.empty-state--bare {
  padding-block: 36px;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.empty-state__badge {
  display: grid;
  width: 56px;
  height: 56px;
  margin-bottom: 8px;
  place-items: center;
  border-radius: 18px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.empty-state__icon {
  font-size: 26px;
}

.empty-state--error .empty-state__badge {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.empty-state__title {
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-600);
}

.empty-state__description {
  max-width: 420px;
  margin: 0;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.6;
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
}
</style>
