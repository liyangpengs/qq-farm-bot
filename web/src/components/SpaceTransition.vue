<script setup lang="ts">
import { computed } from 'vue'
import { SPACE_TRANSITION_STYLE, spaceTransition } from '@/components/space-transition'

const inRanch = computed(() => spaceTransition.value?.target === 'ranch')
</script>

<template>
  <Teleport to="body">
    <div
      v-if="spaceTransition"
      class="space-transition"
      :data-target="spaceTransition.target"
      :data-phase="spaceTransition.phase"
      :style="SPACE_TRANSITION_STYLE"
    >
      <div class="space-transition__destination" role="status" aria-live="polite">
        <span class="space-transition__icon" :class="inRanch ? 'i-fa-solid-paw' : 'i-fa-solid-seedling'" aria-hidden="true" />
        <span>{{ inRanch ? '牧场' : '农场' }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style>
.space-transition {
  --space-accent: var(--ui-primary);

  position: fixed;
  z-index: 4000;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--ui-bg);
  opacity: 0;
  cursor: progress;
}

.space-transition[data-target='ranch'] {
  --space-accent: var(--ui-warning);
}

.space-transition[data-phase='hold'] {
  opacity: 1;
}

.space-transition__destination {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--ui-muted);
  font-size: 14px;
  font-weight: var(--fw-500);
  letter-spacing: 0.12em;
  opacity: 0;
}

.space-transition__icon {
  width: 30px;
  height: 30px;
  color: var(--space-accent);
}

.liquid-layout[data-space-phase='hold'] {
  opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .liquid-layout[data-space-phase='leave'] {
    animation: space-page-leave var(--space-leave-duration) ease-in both;
  }

  .liquid-layout[data-space-phase='enter'] {
    animation: space-page-enter var(--space-enter-duration) cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }

  .space-transition[data-phase='leave'] {
    animation: space-veil-in var(--space-leave-duration) ease-in both;
  }

  .space-transition[data-phase='hold'] .space-transition__destination {
    animation: space-destination-in 180ms ease-out both;
  }

  .space-transition[data-phase='enter'] {
    animation: space-veil-out var(--space-enter-duration) ease-out both;
  }
}

@keyframes space-page-leave {
  to {
    opacity: 0;
    transform: translateY(-6px);
  }
}

@keyframes space-page-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes space-veil-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes space-veil-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes space-destination-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
