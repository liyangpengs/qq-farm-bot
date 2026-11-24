// 运行日志的模块与事件筛选项（Dashboard 与 RunLogCard 共用，避免两处不同步）

// 日志缓存冗余上限：逐块务农日志密集，缓存比实际显示行数多，
// 保证聚合前不被截断、聚合成四条后有足够多的实际日志可显示。
export const LOG_CACHE_LIMIT = 500

export interface LogFilterOption {
  label: string
  value: string
}

// 一级模块：好友/仓库已降为「农场」下的子模块，不再单列
export const LOG_MODULES: LogFilterOption[] = [
  { label: '所有模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '牧场', value: 'ranch' },
  { label: '任务', value: 'task' },
  { label: '系统', value: 'system' },
]

// 二级子模块：按一级模块动态显示
export const SUBMODULES_BY_PARENT: Record<string, LogFilterOption[]> = {
  farm: [
    { label: '所有子模块', value: '' },
    { label: '好友', value: 'friend' },
    { label: '仓库', value: 'warehouse' },
    { label: '土地', value: 'land' },
  ],
  ranch: [
    { label: '所有子模块', value: '' },
    { label: '好友', value: 'friend' },
    { label: '仓库', value: 'warehouse' },
  ],
}

// 子模块过滤规则：
//  - byModule：按日志 meta.module / tag 匹配（好友/仓库整个模块降级为农场子模块）
//  - byEvents：按 event 白名单匹配（土地、牧场下的好友/仓库）
// 注意：日志里的 event 既有英文 code 也有中文（多为中文），两种都要能匹配
export const SUBMODULE_BY_MODULE: Record<string, string> = {
  'farm:friend': 'friend',
  'farm:warehouse': 'warehouse',
}
export const SUBMODULE_BY_TAG: Record<string, string> = {
  'farm:friend': '好友',
  'farm:warehouse': '仓库',
}
export const SUBMODULE_EVENTS: Record<string, string[]> = {
  'farm:land': ['farm_cycle', 'plant_seed', '土地推送通知', '种植种子', '农场循环', '铲除植物', '收获后状态分类'],
  'ranch:friend': ['ranch_cleanFriend', 'ranch_steal', '好友牧场清理', '牧场产物偷取'],
  'ranch:warehouse': ['ranch_sell', 'ranch_feed', '出售牧场产物', '牧场罐头喂养'],
}

// 一级模块 -> 后端 module 参数（逗号分隔支持多选）；农场需含降级为子模块的 friend/warehouse
export const PARENT_MODULE_QUERY: Record<string, string> = {
  farm: 'farm,friend,warehouse',
  ranch: 'ranch',
  task: 'task',
  system: 'system',
}

export const LOG_EVENTS: LogFilterOption[] = [
  { label: '所有事件', value: '' },
  { label: '农场巡查', value: 'farm_cycle' },
  { label: '收获作物', value: 'harvest_crop' },
  { label: '清理枯株', value: 'remove_plant' },
  { label: '种植种子', value: 'plant_seed' },
  { label: '施加化肥', value: 'fertilize' },
  { label: '土地推送', value: 'lands_notify' },
  { label: '选择种子', value: 'seed_pick' },
  { label: '购买种子', value: 'seed_buy' },
  { label: '购买化肥', value: 'fertilizer_buy' },
  { label: '开启礼包', value: 'fertilizer_gift_open' },
  { label: '获取任务', value: 'task_scan' },
  { label: '完成任务', value: 'task_claim' },
  { label: '免费礼包', value: 'mall_free_gifts' },
  { label: '分享奖励', value: 'daily_share' },
  { label: '会员礼包', value: 'vip_daily_gift' },
  { label: '月卡礼包', value: 'month_card_gift' },
  { label: '图鉴奖励', value: 'illustrated_rewards' },
  { label: '邮箱领取', value: 'email_rewards' },
  { label: '出售成功', value: 'sell_success' },
  { label: '土地升级', value: 'upgrade_land' },
  { label: '土地解锁', value: 'unlock_land' },
  { label: '好友巡查', value: 'friend_cycle' },
  { label: '访问好友', value: 'visit_friend' },
  { label: '牧场巡查', value: 'ranch_automation' },
  { label: '购买牧场商品', value: 'ranch_buy' },
  { label: '放养幼崽', value: 'ranch_place' },
  { label: '补充牧草', value: 'ranch_addGrass' },
  { label: '填充罐头', value: 'ranch_useCan' },
  { label: '牧场罐头喂养', value: 'ranch_feed' },
  { label: '牧场生产', value: 'ranch_produce' },
  { label: '牧场收获', value: 'ranch_harvest' },
  { label: '出售牧场产物', value: 'ranch_sell' },
  { label: '清理牧场', value: 'ranch_clean' },
  { label: '解锁牧场棚', value: 'ranch_activateShed' },
  { label: '升级牧场建筑', value: 'ranch_upgrade' },
  { label: '完成建筑升级', value: 'ranch_completeUpgrade' },
  { label: '领取牧场任务', value: 'ranch_claimTasks' },
  { label: '牧场成长任务', value: 'ranch_reportEntry' },
  { label: '牧场集市兑换', value: 'ranch_exchange' },
  { label: '牧场图鉴奖励', value: 'ranch_claimIllustrated' },
  { label: '牧场每日分享', value: 'ranch_claimDailyShare' },
  { label: '购买牧场罐头', value: 'ranch_buyCan' },
  { label: '牧场产物偷取', value: 'ranch_steal' },
  { label: '抚摸好友动物', value: 'ranch_stroke' },
  { label: '放生动物', value: 'ranch_release' },
  { label: '放蚊子', value: 'ranch_putMosquito' },
  { label: '好友牧场清理', value: 'ranch_cleanFriend' },
  { label: '拜访好友牧场', value: 'ranch_friend' },
  { label: '离开好友牧场', value: 'ranch_friend_leave' },
  { label: '恢复场景', value: 'ranch_scene_restore' },
  { label: '牧场任务', value: 'ranch_task_claim' },
  { label: '牧场分享礼包', value: 'ranch_daily_share' },
  { label: '牧场每日福利', value: 'ranch_daily_benefit' },
]

export const LOG_LEVELS: LogFilterOption[] = [
  { label: '所有等级', value: '' },
  { label: '成功', value: 'success' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' },
]

export function buildEventLabelMap(): Record<string, string> {
  return Object.fromEntries(LOG_EVENTS.filter(e => e.value).map(e => [e.value, e.label]))
}

// 日志的模块路径标签（一级/二级），与筛选分类保持一致
export function getModulePath(log: any): string {
  const module = String(log?.meta?.module || '')
  const event = String(log?.meta?.event || '')
  const tag = String(log?.tag || '')
  // 二级（先判事件白名单，再判降级模块）
  for (const [key, events] of Object.entries(SUBMODULE_EVENTS)) {
    if (events.includes(event)) {
      const [parent = '', child = ''] = key.split(':')
      return `${moduleLabel(parent)} / ${submoduleLabel(child)}`
    }
  }
  for (const [key, mod] of Object.entries(SUBMODULE_BY_MODULE)) {
    if (module === mod || tag === SUBMODULE_BY_TAG[key]) {
      const [parent = '', child = ''] = key.split(':')
      return `${moduleLabel(parent)} / ${submoduleLabel(child)}`
    }
  }
  if (module === 'ranch' || event.startsWith('ranch_') || tag === '牧场') return '牧场'
  if (module === 'task') return '任务'
  if (module === 'system' || tag === '系统' || tag === '错误') return '系统'
  if (module === 'friend') return '农场 / 好友'
  if (module === 'warehouse') return '农场 / 仓库'
  return '农场'
}

function moduleLabel(value: string): string {
  return LOG_MODULES.find(m => m.value === value)?.label || value
}
function submoduleLabel(value: string): string {
  for (const list of Object.values(SUBMODULES_BY_PARENT)) {
    const found = list.find(s => s.value === value)
    if (found) return found.label
  }
  return value
}
