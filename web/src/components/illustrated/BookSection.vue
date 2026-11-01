<script setup lang="ts">
/** 图鉴分组：标题行（色标、名称、进度计数、附加操作）+ 等宽条目网格。 */
withDefaults(defineProps<{
  title: string
  count?: string
  description?: string
  tag?: string
  /** 分组色标，例如藏品稀有度颜色；默认主色。 */
  accent?: string
}>(), { count: '', description: '', tag: '', accent: '' })
</script>

<template>
  <section class="book-section" :style="accent ? { '--tile-accent': accent } : undefined">
    <header class="book-section__head">
      <div class="book-section__title">
        <span class="book-section__mark" aria-hidden="true" />
        <h3>{{ title }}</h3>
        <span v-if="tag" class="book-section__tag">{{ tag }}</span>
        <span v-if="count" class="book-section__count">{{ count }}</span>
        <slot name="title-extra" />
      </div>
      <slot name="actions" />
    </header>
    <p v-if="description" class="book-section__desc">
      {{ description }}
    </p>
    <div class="book-section__grid">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.book-section {
  --tile-accent: var(--ui-primary);
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.book-section__head {
  display: flex;
  min-height: 24px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.book-section__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.book-section__mark {
  width: 3px;
  height: 14px;
  flex: none;
  border-radius: 2px;
  background: var(--tile-accent);
}

.book-section__title h3 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-section__tag {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--tile-accent);
  background: color-mix(in srgb, var(--tile-accent) 13%, transparent);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
}

.book-section__count {
  flex: none;
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.book-section__desc {
  margin: -4px 0 2px 11px;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
}

/* 固定最小列宽自动排列：同一行卡片等宽等高，窄屏 320px 仍能放下三列。 */
.book-section__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 10px;
}

@media (max-width: 639px) {
  .book-section__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
}
</style>
