export const AUTO_RELOAD_STORAGE_KEY = 'qq_farm_auto_reloaded_build'

export type WebBuildDecision = 'none' | 'auto_reload' | 'prompt_refresh'

export interface EvaluateWebBuildInput {
  currentBuildId: string
  observedBuildId: string
  hasUnsavedEdits: boolean
  lastAutoReloadedBuildId?: string | null
}

export function evaluateWebBuildChange(input: EvaluateWebBuildInput): WebBuildDecision {
  const current = String(input.currentBuildId || '').trim()
  const observed = String(input.observedBuildId || '').trim()
  if (!current || current === 'dev' || !observed || observed === 'dev' || observed === current)
    return 'none'

  if (input.hasUnsavedEdits || String(input.lastAutoReloadedBuildId || '').trim() === observed)
    return 'prompt_refresh'

  return 'auto_reload'
}

export function isTransientNetworkError(error: any): boolean {
  if (!error || typeof error !== 'object')
    return false
  if (error.code === 'ERR_CANCELED')
    return false
  const status = Number(error?.response?.status || 0)
  if (status === 502 || status === 503 || status === 504)
    return true
  return Boolean(error.request && !error.response)
}
