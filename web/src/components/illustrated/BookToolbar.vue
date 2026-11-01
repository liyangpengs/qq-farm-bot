<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'

/** 图鉴筛选条：左侧状态分段（带数量），右侧搜索；桌面端吸附在页签下方。 */
defineProps<{
  filters: Array<{ value: string, label: string, count?: number }>
  placeholder: string
  label: string
}>()

const filter = defineModel<string>('filter', { required: true })
const query = defineModel<string>('query', { default: '' })
</script>

<template>
  <section class="book-toolbar" :aria-label="label">
    <div class="book-toolbar__chips" role="group" :aria-label="`${label}状态`">
      <NButton
        v-for="entry in filters"
        :key="entry.value"
        size="small"
        :type="filter === entry.value ? 'primary' : 'default'"
        :secondary="filter !== entry.value"
        :aria-pressed="filter === entry.value"
        @click="filter = entry.value"
      >
        {{ entry.label }}<span v-if="entry.count !== undefined" class="book-toolbar__count">{{ entry.count }}</span>
      </NButton>
    </div>
    <slot />
    <label class="book-toolbar__search">
      <span class="i-carbon-search" aria-hidden="true" />
      <input v-model="query" type="search" :placeholder="placeholder" :aria-label="placeholder">
    </label>
  </section>
</template>

<style scoped>
.book-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

@media (min-width: 1024px) {
  .book-toolbar {
    position: sticky;
    top: var(--sticky-top, 0px);
    z-index: 5;
    margin-block: -8px;
    padding-block: 8px;
    background: var(--chrome-bg);
  }
}

.book-toolbar__chips {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.book-toolbar__chips::-webkit-scrollbar {
  display: none;
}

.book-toolbar__chips :deep(.n-button) {
  flex: none;
}

.book-toolbar__count {
  margin-left: 5px;
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
}

.book-toolbar__search {
  display: flex;
  width: min(240px, 36vw);
  height: 32px;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  color: var(--ui-subtle);
  background: var(--glass-input);
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.book-toolbar__search:focus-within {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-primary) 14%, transparent);
}

.book-toolbar__search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: var(--ui-ink);
  background: transparent;
  font-size: 13px;
}

@media (max-width: 639px) {
  .book-toolbar {
    flex-wrap: wrap;
  }

  .book-toolbar__chips {
    flex-basis: 100%;
  }

  .book-toolbar__search {
    width: auto;
    flex: 1 1 160px;
  }
}
</style>
