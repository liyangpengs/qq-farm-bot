<script setup lang="ts">
import type { ThemeMode } from '@/stores/app'
import { NButton } from 'naive-ui/es/button'
import { NDropdown } from 'naive-ui/es/dropdown'
import { storeToRefs } from 'pinia'
import { computed, h } from 'vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const { themeMode } = storeToRefs(appStore)

const MODES: Array<{ key: ThemeMode, label: string, icon: string }> = [
  { key: 'system', label: '跟随系统', icon: 'i-carbon-screen' },
  { key: 'light', label: '浅色', icon: 'i-carbon-sun' },
  { key: 'dark', label: '深色', icon: 'i-carbon-moon' },
]

const current = computed(() => MODES.find(mode => mode.key === themeMode.value) || MODES[0]!)

const options = computed(() => MODES.map(mode => ({
  key: mode.key,
  label: mode.label,
  icon: () => h('span', { class: mode.icon }),
  props: { class: mode.key === themeMode.value ? 'theme-switcher__option--active' : '' },
})))
</script>

<template>
  <NDropdown trigger="click" placement="bottom-end" :options="options" @select="appStore.setThemeMode">
    <NButton quaternary circle :title="`主题：${current.label}`" :aria-label="`切换主题，当前${current.label}`">
      <span class="text-lg" :class="current.icon" />
    </NButton>
  </NDropdown>
</template>

<style>
.theme-switcher__option--active {
  color: var(--ui-primary) !important;
  font-weight: var(--fw-600);
}
</style>
