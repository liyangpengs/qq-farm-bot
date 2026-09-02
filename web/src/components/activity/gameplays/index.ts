import type { ActivityGameplayModule, ResolvedActivityGameplay } from './types'
import type { ActivityDirectoryItemDto, ActivityGameplayKey } from '@/stores/activity-center'
import { charityGameplay } from './charity'
import { qingMeiGameplay } from './qingmei'
import { qixiGameplay } from './qixi'
import { stellarGameplay } from './stellar'
import { weatherGameplay } from './weather'

const gameplayModules: Record<ActivityGameplayKey, ActivityGameplayModule> = {
  stellar: stellarGameplay,
  qixi: qixiGameplay,
  qingmei: qingMeiGameplay,
  charity: charityGameplay,
  weather: weatherGameplay,
}

function inferGameplayKey(activity: ActivityDirectoryItemDto): ActivityGameplayKey | null {
  if (activity.gameplayKey)
    return activity.gameplayKey
  if (activity.detailTarget === 'weather')
    return 'weather'
  if (activity.detailTarget === 'charity')
    return 'charity'
  if (activity.detailTarget === 'qixi')
    return 'qixi'
  if (activity.detailTarget === 'qingmei')
    return 'qingmei'
  if (activity.detailTarget)
    return 'stellar'

  const activityIds = new Set(activity.activityIds.map(id => id.trim()))
  if (['2026072700', '2026072701'].some(id => activityIds.has(id)))
    return 'stellar'
  if (['2026070300', '2026070301', '2026070302', '2026070303', '2026070304', '2026070305'].some(id => activityIds.has(id)))
    return 'weather'
  if (['2026081800', '2026081801', '2026081802'].some(id => activityIds.has(id)))
    return 'qixi'
  if (['2026081200', '2026081201', '2026081202'].some(id => activityIds.has(id)))
    return 'qingmei'
  if (['2026090900', '2026090901'].some(id => activityIds.has(id)))
    return 'charity'

  const name = activity.name.trim()
  if (name.includes('雨落成诗'))
    return 'weather'
  if (name.includes('鹊桥寄情'))
    return 'qixi'
  if (name.includes('青梅') || name.includes('青酿'))
    return 'qingmei'
  if (name.includes('公益小红花'))
    return 'charity'
  if (/千星|星砂|星宿|节令/.test(name))
    return 'stellar'
  return null
}

export function resolveActivityGameplay(activity: ActivityDirectoryItemDto): ResolvedActivityGameplay | null {
  const gameplayKey = inferGameplayKey(activity)
  if (!gameplayKey)
    return null
  const module = gameplayModules[gameplayKey]
  if (!module)
    return null
  const entryTab = activity.detailTarget && module.tabs.includes(activity.detailTarget)
    ? activity.detailTarget
    : activity.gameplayTargets.find(tab => module.tabs.includes(tab)) || module.defaultTab
  return { module, entryTab, activity }
}

export function activityHasGameplay(activity: ActivityDirectoryItemDto) {
  return resolveActivityGameplay(activity) !== null
}
