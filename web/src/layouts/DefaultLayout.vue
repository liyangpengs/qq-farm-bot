<script setup lang="ts">
import { NButton } from 'naive-ui'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import MobileBottomNav from '@/components/MobileBottomNav.vue'
import Sidebar from '@/components/Sidebar.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const route = useRoute()
const { sidebarOpen } = storeToRefs(appStore)
</script>

<template>
  <div class="liquid-layout w-screen flex overflow-hidden">
    <div
      v-if="sidebarOpen"
      class="navigation-overlay fixed inset-0 z-40 lg:hidden"
      @click="appStore.closeSidebar"
    />

    <Sidebar />

    <main class="app-main relative h-full min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
      <header v-if="!route.meta.fullBleed" class="glass-mobile-header lg:hidden">
        <div class="mobile-heading min-w-0">
          <span class="mobile-heading__brand">
            <span class="i-carbon-sprout" />
            QQ农场智能助手
          </span>
        </div>
        <NButton quaternary circle aria-label="打开全部导航" @click="appStore.toggleSidebar">
          <div class="i-carbon-menu text-xl" />
        </NButton>
      </header>

      <div class="app-content flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          class="page-scroll custom-scrollbar flex flex-1 flex-col"
          :class="route.meta.fullBleed ? 'overflow-hidden p-0' : 'overflow-y-auto'"
        >
          <RouterView v-slot="{ Component, route: currentRoute }">
            <Transition name="page-fade" mode="out-in">
              <component :is="Component" :key="currentRoute.path" />
            </Transition>
          </RouterView>
        </div>
      </div>
    </main>

    <MobileBottomNav v-if="!route.meta.fullBleed" />
  </div>
</template>

<style scoped>
.liquid-layout {
  height: 100dvh;
}

.navigation-overlay {
  background: rgba(30, 39, 32, 0.32);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.glass-mobile-header {
  display: flex;
  min-height: 58px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 10px 0;
  padding: 8px 9px 8px 13px;
  border: 1px solid var(--ui-border);
  border-radius: 18px;
  background: rgba(250, 251, 247, 0.82);
  box-shadow:
    var(--ui-shadow-sm),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: blur(20px) saturate(135%);
  backdrop-filter: blur(20px) saturate(135%);
}

.mobile-heading {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mobile-heading__brand {
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  color: var(--ui-primary);
  font-size: 11px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-scroll {
  min-height: 0;
  padding: 22px clamp(16px, 2.4vw, 34px) 28px;
}

.page-scroll > :deep(*) {
  flex: 0 0 auto;
  width: 100%;
  max-width: 1580px;
  margin-inline: auto;
}

.page-fade-enter-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.page-fade-leave-active {
  transition: opacity 0.1s ease;
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(3px);
}

.page-fade-leave-to {
  opacity: 0;
}

@media (max-width: 1023px) {
  .page-scroll {
    /* Keep the last card/button above the fixed mobile navigation bar. */
    padding: 14px 12px calc(132px + env(safe-area-inset-bottom));
    scroll-padding-bottom: calc(132px + env(safe-area-inset-bottom));
  }
}

@media (max-width: 480px) {
  .glass-mobile-header {
    margin-inline: 8px;
  }

  .page-scroll {
    padding-inline: 8px;
  }
}
</style>
