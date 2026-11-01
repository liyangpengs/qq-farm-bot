<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import { menuRoutes } from '@/router/menu'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const appStore = useAppStore()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const { sidebarOpen, sidebarCollapsed } = storeToRefs(appStore)
const currentPage = computed(() => menuRoutes.find(item => item.name === route.name))
const navigationExpanded = computed(() => isDesktop.value ? !sidebarCollapsed.value : sidebarOpen.value)
const navigationToggleLabel = computed(() => navigationExpanded.value ? '收起侧栏' : '展开侧栏')
const navigationIcon = computed(() => {
  if (!isDesktop.value)
    return 'i-carbon-menu'
  return navigationExpanded.value ? 'i-carbon-side-panel-close' : 'i-carbon-side-panel-open'
})

function toggleNavigation() {
  if (isDesktop.value)
    appStore.toggleSidebarCollapsed()
  else
    appStore.toggleSidebar()
}
</script>

<template>
  <header class="page-header">
    <div class="page-heading min-w-0">
      <span v-if="currentPage" class="page-heading__icon" :class="currentPage.icon" />
      <h1 class="page-heading__title">
        {{ currentPage?.label || 'QQ农场智能助手' }}
      </h1>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <ThemeSwitcher />
      <NButton quaternary circle aria-controls="app-sidebar" :aria-expanded="navigationExpanded" :aria-label="navigationToggleLabel" :title="navigationToggleLabel" @click="toggleNavigation">
        <div class="text-xl" :class="navigationIcon" />
      </NButton>
    </div>
  </header>
</template>

<style scoped>
.page-header {
  min-height: 44px;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
}

.page-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-heading__icon {
  flex-shrink: 0;
  color: var(--ui-primary);
  font-size: 22px;
}

.page-heading__title {
  overflow: hidden;
  margin: 0;
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1023px) {
  .page-heading__title {
    font-size: 19px;
  }
}
</style>
