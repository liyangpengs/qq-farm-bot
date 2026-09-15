import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export type UserRole = 'admin' | 'super_admin' | 'user'

export interface UserCard {
  code: string
  description?: string
  days?: number
  durationValue?: number
  durationUnit?: string
  durationMs?: number
  isPermanent?: boolean
  expiresAt?: number | null
  enabled?: boolean
}

export interface AdminInfo {
  username: string
  role: UserRole
  qq?: string
  avatar?: string
  card?: UserCard | null
  accountLimit?: number
  mustChangePassword?: boolean
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials' | string
  remainingMs?: number
  data?: {
    token: string
    role: UserRole
    user: { username: string }
    qq?: string
    card?: UserCard | null
    accountLimit?: number
    mustChangePassword?: boolean
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<AdminInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')
  const role = computed<UserRole>(() => userInfo.value?.role || 'user')
  const isAdmin = computed(() => role.value === 'admin' || role.value === 'super_admin')

  async function login(usernameInput: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username: usernameInput, password })
      if (res.data.ok) {
        token.value = res.data.data.token
        userInfo.value = {
          username: res.data.data.user.username,
          role: res.data.data.role || 'user',
          qq: res.data.data.qq || '',
          card: res.data.data.card || null,
          accountLimit: res.data.data.accountLimit,
          mustChangePassword: res.data.data.mustChangePassword,
        }
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function register(payload: { username: string, password: string, cardCode: string, qq?: string }) {
    const res = await api.post('/api/register', payload)
    return res.data
  }

  async function renew(cardCode: string) {
    const res = await api.post('/api/user/renew', { cardCode })
    if (res.data.ok && userInfo.value) {
      userInfo.value.card = res.data.data.card
      userInfo.value.accountLimit = res.data.data.accountLimit
    }
    return res.data
  }

  async function fetchCardInfo(code: string) {
    const res = await api.get(`/api/card/info/${encodeURIComponent(code)}`)
    return res.data
  }

  async function publicRenew(usernameInput: string, cardCode: string) {
    const res = await api.post('/api/public/renew', { username: usernameInput, cardCode })
    return res.data
  }

  async function resetPassword(usernameInput: string, cardCode: string, newPassword: string) {
    const res = await api.post('/api/public/reset-password/confirm', { username: usernameInput, cardCode, newPassword })
    return res.data
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
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

  return {
    token,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    role,
    isAdmin,
    login,
    register,
    renew,
    fetchCardInfo,
    publicRenew,
    resetPassword,
    logout,
    fetchUserInfo,
    changePassword,
  }
})
