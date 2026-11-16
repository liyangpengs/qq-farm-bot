<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { getSpaceMenu } from '@/router/menu'

const route = useRoute()

// 与侧栏使用同一份名称和图标，只在底栏放最常用的五项。
const MOBILE_ITEMS: Array<[string, string?]> = [['dashboard'], ['personal'], ['activity-center'], ['game-mall', '商城'], ['Settings']]
const items = computed(() => MOBILE_ITEMS.flatMap(([name, shortLabel]) => {
  const inRanch = route.meta.gameSpace === 'ranch'
  const item = getSpaceMenu(inRanch).find(item => item.name === `${inRanch ? 'ranch-' : ''}${name}`)
  return item ? [{ path: `/${item.path}`, label: shortLabel || item.label, icon: item.icon }] : []
}))
</script>

<template>
  <nav class="mobile-bottom-nav lg:hidden" aria-label="主要导航">
    <RouterLink
      v-for="item in items"
      :key="item.path"
      :to="item.path"
      class="mobile-bottom-nav__item"
      exact-active-class="mobile-bottom-nav__item--active"
    >
      <div :class="item.icon" class="mobile-bottom-nav__icon" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.mobile-bottom-nav {
  position: fixed;
  z-index: 35;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  left: max(14px, env(safe-area-inset-left));
  display: none;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  min-height: 66px;
  padding: 7px 8px;
  border: 1px solid rgba(58, 86, 68, 0.12);
  border-radius: 24px;
  background: color-mix(in srgb, var(--ui-bg) 84%, transparent);
  box-shadow:
    0 16px 42px rgba(55, 75, 61, 0.16),
    inset 0 1px 0 var(--glass-highlight);
  -webkit-backdrop-filter: blur(22px) saturate(135%);
  backdrop-filter: blur(22px) saturate(135%);
}

@media (max-width: 1023px) {
  .mobile-bottom-nav {
    display: grid;
  }
}

.mobile-bottom-nav__item {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 3px;
  border-radius: 17px;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.1;
  text-decoration: none;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}

.mobile-bottom-nav__icon {
  width: 22px;
  height: 22px;
}

.mobile-bottom-nav__item--active {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  box-shadow: none !important;
}
</style>
