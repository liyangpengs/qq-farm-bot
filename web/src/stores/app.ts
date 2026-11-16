import { usePreferredDark, useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  // 活动详情有自己的标题栏，打开时布局隐藏通用页头并让活动外壳撑满内容区。
  const activityDetailOpen = ref(false)
  const spaceSwitching = ref(false)
  const sidebarCollapsed = useStorage('sidebar_collapsed', false)
  // 默认跟随系统；index.html 中的内联脚本在首屏渲染前读取同一个键，避免闪烁。
  const themeMode = useStorage<ThemeMode>('theme_mode', 'system')
  const preferredDark = usePreferredDark()
  const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'system' && preferredDark.value))

  watch(isDark, (dark) => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, { immediate: true })

  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return {
    themeMode,
    isDark,
    setThemeMode,
    sidebarOpen,
    sidebarCollapsed,
    activityDetailOpen,
    spaceSwitching,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    toggleSidebarCollapsed,
  }
})
