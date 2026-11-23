<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppUpdateStore } from '@/stores/app-update'

const route = useRoute()
const appUpdateStore = useAppUpdateStore()
const { reconnecting, updatePromptVisible } = storeToRefs(appUpdateStore)

const showReconnect = computed(() => route.name !== 'login' && reconnecting.value)
const showRefreshPrompt = computed(() => !showReconnect.value && route.name !== 'login' && updatePromptVisible.value)
</script>

<template>
  <div class="panel-status-host">
    <Transition name="panel-banner">
      <div
        v-if="showReconnect"
        key="reconnecting"
        class="panel-status-pill panel-status-pill--warn"
        role="status"
        aria-live="polite"
      >
        <span class="panel-status-pill__icon i-svg-spinners-90-ring-with-bg" aria-hidden="true" />
        <span>正在重新连接</span>
      </div>
      <button
        v-else-if="showRefreshPrompt"
        key="refresh-prompt"
        type="button"
        class="panel-status-pill panel-status-pill--action"
        aria-live="polite"
        @click="appUpdateStore.applyPendingUpdate()"
      >
        <span class="panel-status-pill__icon i-carbon-renew" aria-hidden="true" />
        <span>新版已就绪，点击刷新</span>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.panel-status-host {
  position: fixed;
  top: 12px;
  left: 50%;
  z-index: 90;
  transform: translateX(-50%);
  pointer-events: none;
  max-width: calc(100vw - 24px);
}

.panel-status-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 14px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 999px;
  background: var(--ui-surface-strong);
  box-shadow: var(--ui-shadow-md);
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-500);
  line-height: 1.2;
  white-space: nowrap;
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}

.panel-status-pill--warn .panel-status-pill__icon {
  color: var(--ui-warning);
  font-size: 15px;
}

.panel-status-pill--action {
  cursor: pointer;
  border-color: color-mix(in srgb, var(--ui-primary) 42%, var(--ui-border));
  transition:
    transform 0.16s ease,
    border-color 0.16s ease,
    background-color 0.16s ease;
}

.panel-status-pill--action:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 65%, var(--ui-border));
  transform: translateY(-1px);
}

.panel-status-pill--action:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.panel-status-pill--action .panel-status-pill__icon {
  color: var(--ui-primary);
  font-size: 15px;
}

.panel-banner-enter-active,
.panel-banner-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.panel-banner-enter-from,
.panel-banner-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  .panel-status-pill--action:hover {
    transform: none;
  }

  .panel-banner-enter-active,
  .panel-banner-leave-active {
    transition: none;
  }
}
</style>
