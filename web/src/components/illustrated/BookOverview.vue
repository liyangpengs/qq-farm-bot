<script setup lang="ts">
import { Comment, computed, useSlots } from 'vue'

/** 图鉴概览：等级（或评分）徽章、进度条与操作按钮，四个页签共用。 */
const props = withDefaults(defineProps<{
  title: string
  icon: string
  badgeValue: string | number
  badgeLabel: string
  /** 进度条上方左侧说明，例如“已收藏 32 / 120”。 */
  caption?: string
  /** 进度条上方右侧数值，例如“860 / 1000”。 */
  progressText?: string
  /** 0–100；为 null 时不显示进度条。 */
  percent?: number | null
  hint?: string
}>(), { caption: '', progressText: '', percent: null, hint: '' })

const slots = useSlots()
/** 父组件用 v-if 关闭附加区时插槽只剩注释节点，此时不渲染分隔线和留白。 */
function hasExtra() {
  return !!slots.default?.().some(node => node.type !== Comment)
}

const width = computed(() => `${Math.max(0, Math.min(100, props.percent ?? 0))}%`)
</script>

<template>
  <section class="book-overview">
    <div class="book-overview__badge" aria-hidden="true">
      <b>{{ badgeValue }}</b><small>{{ badgeLabel }}</small>
    </div>
    <div class="book-overview__main">
      <div class="book-overview__heading">
        <h3><span :class="icon" />{{ title }}</h3>
        <span v-if="caption" class="book-overview__caption">{{ caption }}</span>
      </div>
      <template v-if="percent !== null">
        <div
          class="book-overview__track"
          role="progressbar"
          :aria-label="`${title}进度`"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(percent)"
          :aria-valuetext="progressText || undefined"
        >
          <span :style="{ width }" />
        </div>
        <div class="book-overview__foot">
          <span>{{ hint }}</span><b v-if="progressText">{{ progressText }}</b>
        </div>
      </template>
    </div>
    <div v-if="$slots.actions" class="book-overview__actions">
      <slot name="actions" />
    </div>
    <div v-if="hasExtra()" class="book-overview__extra">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.book-overview {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px 16px;
  padding: 16px 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.book-overview__badge {
  display: flex;
  width: 56px;
  height: 56px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.book-overview__badge b {
  font-size: 20px;
  font-weight: var(--fw-700);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.book-overview__badge small {
  margin-top: 2px;
  font-size: 10px;
  opacity: 0.8;
}

.book-overview__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.book-overview__heading {
  display: flex;
  min-width: 0;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.book-overview__heading h3 {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
  line-height: 1.3;
}

.book-overview__heading h3 > span {
  color: var(--ui-primary);
  font-size: 16px;
}

.book-overview__caption {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.book-overview__track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.book-overview__track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ui-primary);
  transition: width var(--spring-drag-duration) var(--spring-drag);
}

.book-overview__foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-subtle);
  font-size: 12px;
}

.book-overview__foot b {
  color: var(--ui-muted);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.book-overview__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.book-overview__extra {
  display: flex;
  grid-column: 1 / -1;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}

:slotted(.book-chip) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  line-height: 18px;
}

:slotted(.book-chip-label) {
  margin-right: 2px;
  color: var(--ui-subtle);
  font-size: 12px;
  line-height: 24px;
}

@media (max-width: 639px) {
  .book-overview {
    grid-template-columns: 48px minmax(0, 1fr);
    gap: 12px;
    padding: 14px;
  }

  .book-overview__badge {
    width: 48px;
    height: 48px;
    border-radius: 12px;
  }

  .book-overview__actions {
    grid-column: 1 / -1;
  }

  .book-overview__actions > :deep(*) {
    flex: 1;
  }
}
</style>
