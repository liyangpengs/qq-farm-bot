import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface LoginConfig {
  logoUrl: string
  loginSubtitle: string
  registerSubtitle: string
  purchaseUrl: string
  qqGroupUrl: string
}

export interface Announcement {
  content: string
  showOnce: boolean
  updatedAt: number
  shouldShow: boolean
}

const DEFAULT_LOGIN_CONFIG: LoginConfig = {
  logoUrl: '',
  loginSubtitle: '',
  registerSubtitle: '',
  purchaseUrl: '',
  qqGroupUrl: '',
}

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  const sidebarCollapsed = useStorage('sidebar_collapsed', false)
  const loginConfig = ref<LoginConfig>({ ...DEFAULT_LOGIN_CONFIG })
  const announcement = ref<Announcement>({ content: '', showOnce: true, updatedAt: 0, shouldShow: false })
  const announcementVisible = ref(false)

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

  async function fetchLoginConfig() {
    try {
      const res = await api.get('/api/public/login-config')
      if (res.data.ok && res.data.data)
        loginConfig.value = { ...DEFAULT_LOGIN_CONFIG, ...res.data.data }
    }
    catch {
      // 忽略：使用默认配置
    }
  }

  async function fetchAnnouncement() {
    try {
      const res = await api.get('/api/announcement')
      if (res.data.ok && res.data.data) {
        announcement.value = res.data.data
        announcementVisible.value = !!res.data.data.shouldShow && !!res.data.data.content
      }
    }
    catch {
      // 忽略
    }
  }

  async function markAnnouncementRead() {
    announcementVisible.value = false
    try {
      await api.post('/api/announcement/read')
    }
    catch {
      // 忽略
    }
  }

  return {
    sidebarOpen,
    sidebarCollapsed,
    loginConfig,
    announcement,
    announcementVisible,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    toggleSidebarCollapsed,
    fetchLoginConfig,
    fetchAnnouncement,
    markAnnouncementRead,
  }
})
