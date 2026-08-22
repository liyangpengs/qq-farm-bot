<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()

const items = [
  { path: '/', label: '首页', icon: 'i-carbon-home' },
  { path: '/game-mall', label: '商城', icon: 'i-carbon-shopping-cart' },
  { path: '/personal', label: '农场', icon: 'i-carbon-sprout' },
  { path: '/activity', label: '活动', icon: 'i-carbon-events' },
  { path: '/settings', label: '设置', icon: 'i-carbon-settings' },
]

function isActive(path: string) {
  if (path === '/') {
    // 首页仅精确匹配，避免 '/' 作为所有路径前缀导致一直高亮
    return route.path === '/'
  }
  return route.path === path || route.path.startsWith(path)
}
</script>

<template>
  <nav class="mobile-bottom-nav lg:hidden" aria-label="主要导航">
    <RouterLink
      v-for="item in items"
      :key="item.path"
      :to="item.path"
      class="mobile-bottom-nav__item"
      :class="{
        'mobile-bottom-nav__item--active': isActive(item.path),
        'mobile-bottom-nav__item--home': item.path === '/',
      }"
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
  background: rgba(250, 251, 247, 0.84);
  box-shadow:
    0 16px 42px rgba(55, 75, 61, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
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
  background: rgba(225, 241, 230, 0.82);
  box-shadow: none !important;
}

.mobile-bottom-nav__item--home.mobile-bottom-nav__item--active {
  color: var(--ui-ink);
}
</style>
