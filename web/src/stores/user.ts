import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export interface AdminInfo {
  username: string
  role: 'admin'
  avatar?: string
  mustChangePassword?: boolean
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials'
  remainingMs?: number
  data?: {
    token: string
    role: 'admin'
    user: { username: string }
    mustChangePassword?: boolean
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const apiToken = ref('')
  const apiTokenLoading = ref(false)
  const userInfo = useStorage<AdminInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')

  async function login(username: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username, password })
      if (res.data.ok) {
        token.value = res.data.data.token
        userInfo.value = {
          username: res.data.data.user.username,
          role: 'admin',
          mustChangePassword: res.data.data.mustChangePassword,
        }
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: data.error, errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: error.message || '网络错误' }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      apiToken.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok)
        userInfo.value = res.data.data
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    return res.data
  }

  async function fetchApiToken() {
    apiTokenLoading.value = true
    try {
      const res = await api.get('/api/user/api-token')
      apiToken.value = String(res.data?.data?.token || '')
      return res.data
    }
    catch (error: any) {
      return { ok: false, error: error.message || '获取 Token 失败' }
    }
    finally {
      apiTokenLoading.value = false
    }
  }

  async function resetApiToken() {
    apiTokenLoading.value = true
    try {
      const res = await api.post('/api/user/api-token/reset')
      apiToken.value = String(res.data?.data?.token || '')
      return res.data
    }
    catch (error: any) {
      return { ok: false, error: error.message || '重置 Token 失败' }
    }
    finally {
      apiTokenLoading.value = false
    }
  }

  return {
    token,
    apiToken,
    apiTokenLoading,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    login,
    logout,
    fetchUserInfo,
    changePassword,
    fetchApiToken,
    resetApiToken,
  }
})
