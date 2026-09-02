import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  const sidebarCollapsed = useStorage('sidebar_collapsed', false)

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
    sidebarOpen,
    sidebarCollapsed,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    toggleSidebarCollapsed,
  }
})
