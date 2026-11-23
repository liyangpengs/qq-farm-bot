import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { useAppUpdateStore } from '@/stores/app-update'
import { useToastStore } from '@/stores/toast'
import { isTransientNetworkError } from '@/utils/panel-update'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')

const api = axios.create({
  baseURL: '/',
  timeout: 10000,
})

export function normalizeApiErrorMessage(raw: unknown): string {
  const text = String(raw || '').trim()
  if (!text)
    return ''

  const codeMatch = text.match(/\bcode=\d+\b\s*(.*)$/)
  const codeIndex = codeMatch?.index ?? -1
  if (codeMatch?.[1] && codeIndex >= 0 && text.slice(0, codeIndex).includes('.'))
    return codeMatch[1].trim()
  return text
}

export function getApiErrorMessage(error: unknown, fallback = '请求失败'): string {
  const candidate = error as any
  const data = candidate?.response?.data
    || (candidate && typeof candidate === 'object' ? candidate : null)
  const raw = data?.errorMessage
    || data?.error
    || data?.message
    || candidate?.message
    || (typeof error === 'string' ? error : '')
  return normalizeApiErrorMessage(raw) || fallback
}

api.interceptors.request.use((config) => {
  const token = tokenRef.value
  if (token) {
    config.headers['x-admin-token'] = token
  }
  const accountId = accountIdRef.value
  if (accountId && !config.headers.has('x-account-id')) {
    config.headers.set('x-account-id', accountId)
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

api.interceptors.response.use((response) => {
  const appUpdate = useAppUpdateStore()
  appUpdate.notifyBackendReachable()
  const observedBuildId = response?.data?.data?.webBuildId
  if (typeof observedBuildId === 'string' && observedBuildId)
    appUpdate.observeBuildId(observedBuildId)

  const responseData = response?.data
  const skipToast = (response?.config as any)?.skipErrorToast
  if (responseData && typeof responseData === 'object' && responseData.ok === false) {
    const message = getApiErrorMessage(responseData, '')
    if (message) {
      responseData.error = message
      if (!skipToast)
        useToastStore().error(message)
    }
  }
  return response
}, (error) => {
  // Aborting an in-flight request is expected when a modal closes or a QR flow restarts.
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED')
    return Promise.reject(error)

  const toast = useToastStore()
  const appUpdate = useAppUpdateStore()
  const isLoginRequest = String(error.config?.url || '').includes('/api/login')
  const transient = isTransientNetworkError(error)
  if (error.response && Number(error.response.status) < 500)
    appUpdate.notifyBackendReachable()
  if (transient && !isLoginRequest)
    appUpdate.notifyBackendUnavailable()
  const suppressTransientToast = transient && !isLoginRequest && appUpdate.reconnecting

  const normalizedMessage = getApiErrorMessage(error, '')
  if (normalizedMessage) {
    error.message = normalizedMessage
    if (error.response?.data && typeof error.response.data === 'object')
      error.response.data.error = normalizedMessage
  }

  // 支持 skipErrorToast 配置，让调用方自行处理错误
  const skipToast = error.config?.skipErrorToast

  if (error.response) {
    if (error.response.status === 401) {
      // Avoid redirect loop or multiple redirects
      if (!window.location.pathname.includes('/login')) {
        tokenRef.value = ''
        window.location.href = '/login'
        toast.warning('登录已过期，请重新登录')
      }
    }
    else if (error.response.status >= 500) {
      const backendError = getApiErrorMessage(error, '')
      // 后端运行态可预期错误：不弹全局500，交给页面状态处理
      if (backendError === '账号未运行' || backendError === 'API Timeout') {
        return Promise.reject(error)
      }
      if (!skipToast && !suppressTransientToast) {
        toast.error(backendError || '请求失败，请稍后重试')
      }
    }
    else {
      if (!skipToast) {
        toast.error(getApiErrorMessage(error, `请求失败，请联系管理员！`))
      }
    }
  }
  else if (error.request) {
    if (!skipToast && !suppressTransientToast) {
      toast.error('网络错误，无法连接到服务器')
    }
  }
  else {
    if (!skipToast) {
      toast.error(`错误: ${getApiErrorMessage(error, '请求失败')}`)
    }
  }

  return Promise.reject(error)
})

export default api
