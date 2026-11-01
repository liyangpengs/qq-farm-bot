<script setup lang="ts">
import { NPopover } from 'naive-ui/es/popover'
import { ref } from 'vue'

defineProps<{ title: string, rules: Array<{ name: string, probability: number, guarantee: number }> }>()
const hovered = ref(false)
const pinned = ref(false)
function close() {
  pinned.value = false
  hovered.value = false
}
</script>

<template>
  <NPopover v-if="rules.length" trigger="hover" :show="hovered || pinned" @update:show="value => hovered = value" @clickoutside="close">
    <template #trigger>
      <button type="button" class="collection-help" :aria-label="`${title}变异说明`" :aria-expanded="hovered || pinned" @focus="hovered = true" @blur="hovered = false" @click.stop="pinned = !pinned" @keydown.esc="close">
        <span class="i-carbon-help" />
      </button>
    </template>
    <div class="collection-rules" @keydown.esc="close">
      <strong>藏品变异</strong>
      <div v-for="rule in rules" :key="rule.name" class="collection-rule">
        <span>{{ rule.name }}</span><span>概率 <b>{{ rule.probability }}%</b></span><span>保底 <b>{{ rule.guarantee }}</b> 次</span>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.collection-help {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--ui-muted);
  background: transparent;
  cursor: pointer;
}
.collection-help > span {
  width: 17px;
  height: 17px;
}
.collection-help:hover,
.collection-help:focus-visible {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}
.collection-help:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.collection-rules {
  display: flex;
  max-width: calc(100vw - 60px);
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.collection-rules > strong {
  font-size: 13px;
}
.collection-rule {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
}
.collection-rule > span:first-child {
  min-width: 80px;
}
.collection-rule b {
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}
</style>
