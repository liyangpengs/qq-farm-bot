<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import {
  LOG_CACHE_LIMIT,
  LOG_EVENTS,
  LOG_LEVELS,
  LOG_MODULES,
  PARENT_MODULE_QUERY,
  SUBMODULES_BY_PARENT,
  SUBMODULE_BY_MODULE,
  SUBMODULE_BY_TAG,
  SUBMODULE_EVENTS,
  buildEventLabelMap,
  getModulePath,
} from '@/constants/log-filters'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

// 两个页面（农场概览 / 牧场面板）共用同一套日志视图，避免两处逻辑不同步
const props = withDefaults(defineProps<{
  maxLogs?: number
  listClass?: string
  levelInSignature?: boolean
  defaultModule?: string
}>(), {
  maxLogs: 300,
  listClass: '',
  levelInSignature: false,
  defaultModule: '',
})

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const toastStore = useToastStore()
const { logs: statusLogs, realtimeConnected, realtimeLogsEnabled } = storeToRefs(statusStore)
const { currentAccountId } = storeToRefs(accountStore)

const modules = LOG_MODULES
const events = LOG_EVENTS
const levels = LOG_LEVELS
const eventLabelMap = buildEventLabelMap()

const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const clearingLogs = ref(false)

const filter = reactive({ module: '', submodule: '', event: '', keyword: '', level: '' })
const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.submodule || filter.event || filter.keyword || filter.level),
)

// 二级子模块选项：有父模块时跟随父模块；无父模块时展示全部子模块（去重）
const submoduleOptions = computed(() => {
  if (filter.module) return SUBMODULES_BY_PARENT[filter.module] || []
  const seen = new Set<string>()
  const all: typeof LOG_MODULES = [{ label: '所有子模块', value: '' }]
  for (const list of Object.values(SUBMODULES_BY_PARENT)) {
    for (const opt of list) {
      if (!opt.value || seen.has(opt.value)) continue
      seen.add(opt.value)
      all.push(opt)
    }
  }
  return all
})
watch(() => filter.module, () => {
  // 父模块变化时，若当前子模块不属于新父模块则重置
  if (filter.submodule && !submoduleOptions.value.some(s => s.value === filter.submodule))
    filter.submodule = ''
})

// 二级子模块匹配：按 module 或 event 白名单（前端过滤，后端接口不变）
function logMatchesSubmoduleKey(log: any, key: string): boolean {
  const byModule = SUBMODULE_BY_MODULE[key]
  if (byModule && String(log?.meta?.module || '') === byModule) return true
  const byTag = SUBMODULE_BY_TAG[key]
  if (byTag && String(log?.tag || '') === byTag) return true
  const events = SUBMODULE_EVENTS[key]
  if (events && events.includes(String(log?.meta?.event || ''))) return true
  return false
}
function matchSubmodule(log: any): boolean {
  if (!filter.submodule) return true
  if (filter.module) return logMatchesSubmoduleKey(log, `${filter.module}:${filter.submodule}`)
  // 未指定父模块：跨所有父模块按子模块 value 匹配
  return Object.keys(SUBMODULE_EVENTS).concat(Object.keys(SUBMODULE_BY_MODULE))
    .some(key => key.endsWith(`:${filter.submodule}`) && logMatchesSubmoduleKey(log, key))
}

// 不在聚合前截断：逐块务农日志密集，先截断会把可聚合的原始行切掉，
// 导致聚合后实际日志远少于 maxLogs。这里取缓存的全部（最多 LOG_CACHE_LIMIT），
// 聚合完成后再由 logGroups 截到实际显示上限。
const allLogs = computed(() => {
  return [...(statusLogs.value || [])]
    .filter(matchSubmodule)
    .filter(l => !filter.level || getLogLevel(l) === filter.level)
    .sort((a: any, b: any) => a.ts - b.ts)
})

type LogLevel = 'error' | 'warn' | 'success' | 'info'
function getLogLevel(log: any): LogLevel {
  const result = String(log?.meta?.result || '')
  if (log?.tag === '错误' || result === 'error' || result === 'failed')
    return 'error'
  if (log?.isWarn || log?.tag === '警告' || result === 'defer' || result === 'skip')
    return 'warn'
  if (['ok', 'success', 'done', 'resume', 'resumed'].includes(result))
    return 'success'
  return 'info'
}

function isRanchLog(log: any) {
  return log.meta?.module === 'ranch' || String(log.meta?.event || '').startsWith('ranch_') || log.tag === '牧场'
}
function getEventLabel(event?: string) {
  const key = event || ''
  return eventLabelMap[key] || (/[\u3400-\u9FFF]/u.test(key) ? key : '')
}

function logDateKey(log: any): string {
  const raw = String(log?.time || '')
  const d = raw ? new Date(raw.replace(' ', 'T')) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-')
  if (!y || !m || !d) return dateKey
  const today = logDateKey({ time: new Date().toISOString() })
  return dateKey === today ? `今天 · ${Number(m)}月${Number(d)}日` : `${y}年${Number(m)}月${Number(d)}日`
}

interface LogGroup {
  key: string
  uid: string
  log: any
  level: LogLevel
  count: number
  firstTime: string
  logs: any[]
  dateKey: string
}
// 文本聚合：相邻 1 分钟内重复的「选择种子→购买种子→种植种子→农场循环」逐块循环，
// 把同 event 的正文合并成一条（数字累加、土地号拼接），输出成和一键收货一样的文本。
// 例如 5 次「已在 1 块地种植 (N)」→「已在 5 块地种植 (1,2,3,4,5)」。
// 一键收货那种一次种 24 块（没有配套逐次购种）不在此列，保持原样。
const CYCLE_EVENTS = ['选择种子', '购买种子', '种植种子', '农场循环']
const CYCLE_WINDOW_MS = 60_000

function cycleTs(log: any): number {
  return Number(log?.ts) || Date.parse(String(log?.time || '').replace(' ', 'T')) || 0
}

// 找出从 i 开始的一个完整循环块 {logs, endIdx, inners}，失败返回 null。
// inners = 块内被跳过的非循环日志，必须随聚合一起保留，否则会吞日志。
function findCycle(logs: any[], i: number): { logs: any[], endIdx: number, inners: any[] } | null {
  if (String(logs[i]?.meta?.event || '') !== CYCLE_EVENTS[0]) return null
  const block: any[] = [logs[i]]
  const inners: any[] = []
  let j = i + 1
  for (let step = 1; step < CYCLE_EVENTS.length && j < logs.length; step++) {
    let found = -1
    for (let k = j; k < logs.length; k++) {
      if (String(logs[k]?.meta?.event || '') === CYCLE_EVENTS[step]) { found = k; break }
    }
    if (found < 0) return null
    // j..found-1 是被跳过的非循环日志，收集起来
    for (let k = j; k < found; k++) inners.push(logs[k])
    block.push(logs[found])
    j = found + 1
  }
  if (block.length !== CYCLE_EVENTS.length) return null
  if (cycleTs(block[block.length - 1]) - cycleTs(block[0]) > CYCLE_WINDOW_MS) return null
  return { logs: block, endIdx: j, inners }
}

// 把若干个循环块按 event 归并成 4 条合并日志
function mergeCycles(blocks: any[][]): any[] {
  const pick = (idx: number) => blocks.map(b => b[idx])
  const pickMsg = (idx: number) => String(pick(idx)[0]?.msg || '')
  const base = (idx: number) => pick(idx)[0]
  const out: any[] = []

  const cycles = pick(3)
  const harvest = cycles.find(l => /收获/.test(String(l?.msg || '')))
  const last = cycles[cycles.length - 1]

  // 收获循环放最前（铲除植物之后、选择种子之前）：它是本轮先收获上一批的状态
  if (harvest) out.push({ ...harvest })

  // 选择种子：取第一条（各轮相同）
  out.push({ ...base(0), msg: pickMsg(0) })
  // 购买种子：累加 xN 与花费
  const buyMsgs = pick(1).map(l => String(l?.msg || ''))
  const buyCount = buyMsgs.reduce((s, m) => s + (Number(/x(\d+)/.exec(m)?.[1]) || 0), 0)
  const buyGold = buyMsgs.reduce((s, m) => s + (Number(/花费\s*([\d,]+)/.exec(m)?.[1]?.replace(/,/g, '')) || 0), 0)
  const buyName = /已购买(.+?)种子/.exec(buyMsgs[0] || '')?.[1] || ''
  out.push({ ...base(1), msg: `已购买${buyName}种子 x${buyCount}, 花费 ${buyGold.toLocaleString('zh-CN')} 金币` })
  // 种植种子：合并土地号列表
  const plantMsgs = pick(2).map(l => String(l?.msg || ''))
  const landNums: string[] = []
  for (const m of plantMsgs) {
    const list = /\(([^)]+)\)/.exec(m)?.[1] || ''
    for (const n of list.split(',').map(s => s.trim()).filter(Boolean)) landNums.push(n)
  }
  const total = landNums.length
  out.push({ ...base(2), msg: `已在 ${total} 块地种植 (${landNums.join(',')})` })

  // 最后的种植循环：把「种植1」改成合并后的实际数量「种植N」，与上面的种植种子一致
  if (last && last !== harvest) {
    const lastMsg = String(last?.msg || '').replace(/种植\d+/, `种植${total}`)
    out.push({ ...last, msg: lastMsg })
  }
  return out
}

function collapseCycles(logs: any[]): any[] {
  const out: any[] = []
  let i = 0
  while (i < logs.length) {
    const first = findCycle(logs, i)
    if (first) {
      const blocks = [first.logs]
      let cursor = first.endIdx
      // 所有被聚合跳过的非循环日志都要保留，否则日志条数会莫名变少
      const skipped: any[] = [...first.inners]
      // 归并后续循环块（允许中间夹非循环日志），1 分钟内
      while (cursor < logs.length) {
        const next = findCycle(logs, cursor)
        if (next) {
          if (cycleTs(next.logs[0]) - cycleTs(first.logs[0]) <= CYCLE_WINDOW_MS) {
            blocks.push(next.logs)
            skipped.push(...next.inners)
            cursor = next.endIdx
            continue
          }
          break // 超出窗口
        }
        // 非循环日志：暂存并跳过，继续找下一个循环
        skipped.push(logs[cursor])
        cursor++
      }
      out.push(...mergeCycles(blocks))
      out.push(...skipped)
      i = cursor
      continue
    }
    out.push(logs[i])
    i++
  }
  return out
}

const logGroups = computed<LogGroup[]>(() => {
  const groups: LogGroup[] = []
  // 先聚合、后截断：保证显示的是 maxLogs 条「聚合后的实际日志」
  const collapsed = collapseCycles(allLogs.value).slice(-props.maxLogs)
  for (const log of collapsed) {
    const level = getLogLevel(log)
    const signature = `${props.levelInSignature ? level + '|' : ''}${log.tag}|${log.meta?.event || ''}|${String(log.msg || '').replace(/\d+/g, '#')}`
    const last = groups[groups.length - 1]
    if (last && last.key === signature) {
      last.count += 1
      last.log = log
      last.logs.push(log)
      continue
    }
    groups.push({ key: signature, uid: `${log.ts}|${signature}`, log, level, count: 1, firstTime: log.time, logs: [log], dateKey: logDateKey(log) })
  }
  return groups
})

// 跨天分隔：每个 group 前判断日期是否变化
function showDateDivider(index: number): boolean {
  if (index === 0) return true
  const cur = logGroups.value[index]
  const prev = logGroups.value[index - 1]
  return !!cur && !!prev && cur.dateKey !== prev.dateKey
}

const expandedGroups = reactive<Record<string, boolean>>({})
function toggleGroup(key: string) { expandedGroups[key] = !expandedGroups[key] }

// 关键词输入即筛（防抖 300ms）
let keywordTimer: ReturnType<typeof setTimeout> | undefined
watch(() => filter.keyword, () => {
  if (keywordTimer) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => { loadLogs(true) }, 300)
})

interface ActiveFilterChip { key: keyof typeof filter, label: string }
const activeFilterChips = computed<ActiveFilterChip[]>(() => {
  const chips: ActiveFilterChip[] = []
  if (filter.module) chips.push({ key: 'module', label: `模块：${modules.find(m => m.value === filter.module)?.label || filter.module}` })
  if (filter.submodule) chips.push({ key: 'submodule', label: `子模块：${submoduleOptions.value.find(s => s.value === filter.submodule)?.label || filter.submodule}` })
  if (filter.event) chips.push({ key: 'event', label: `事件：${events.find(e => e.value === filter.event)?.label || filter.event}` })
  if (filter.level) chips.push({ key: 'level', label: `等级：${levels.find(l => l.value === filter.level)?.label || filter.level}` })
  if (filter.keyword) chips.push({ key: 'keyword', label: `关键词：${filter.keyword}` })
  return chips
})
function removeFilter(key: keyof typeof filter) {
  filter[key] = ''
  loadLogs(true)
}
function clearAllLogFilters() {
  filter.module = ''
  filter.submodule = ''
  filter.event = ''
  filter.keyword = ''
  filter.level = ''
  loadLogs(true)
}

async function loadLogs(force = false) {
  if (!currentAccountId.value) return
  if (force || hasActiveLogFilter.value || !realtimeConnected.value) {
    // 子模块是事件级归类：对 byEvents 型子模块不传 event 给后端，改为拉全量后前端过滤
    const submoduleKey = `${filter.module}:${filter.submodule}`
    const byEvents = filter.submodule && (
      SUBMODULE_EVENTS[submoduleKey]
      || (!filter.module && Object.keys(SUBMODULE_EVENTS).some(k => k.endsWith(`:${filter.submodule}`)))
    )
    await statusStore.fetchLogs(currentAccountId.value, {
      // 拉满缓存冗余，保证聚合前有足够原始行；聚合后再截到 maxLogs
      limit: LOG_CACHE_LIMIT,
      module: filter.module ? (PARENT_MODULE_QUERY[filter.module] || filter.module) : undefined,
      event: filter.event && !byEvents ? filter.event : undefined,
      keyword: filter.keyword || undefined,
      // success/error 无后端布尔映射，靠前端 getLogLevel 过滤（拉全量）
      isWarn: filter.level === 'warn' ? true : filter.level === 'info' ? false : undefined,
    })
  }
}
function onLogFilterChange() { loadLogs(true) }
function onLogSearchTrigger() { loadLogs(true) }

watch(currentAccountId, async () => {
  // 强制重拉：否则「所有模块 + 实时连接」时 loadLogs 不会走 HTTP，
  // 切账号后列表停留在旧账号数据 / 部分 WS 推送上，小号会只显示农场日志
  await loadLogs(true)
  scrollToBottom()
})
watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
  loadLogs()
})

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el) return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 50
}

async function clearLogs() {
  if (!currentAccountId.value) return
  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await loadLogs(true)
    } else {
      toastStore.error(`清空失败: ${data?.error || '未知错误'}`)
    }
  } catch (e: any) {
    toastStore.error(`清空失败: ${e?.response?.data?.error || e?.message || '请求失败'}`)
  } finally {
    clearingLogs.value = false
  }
}

let logScrollFrame: number | undefined
function scheduleLogScroll(force = false) {
  nextTick(() => {
    if (!logContainer.value || (!force && !autoScroll.value) || logScrollFrame !== undefined) return
    logScrollFrame = window.requestAnimationFrame(() => {
      if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight
      logScrollFrame = undefined
    })
  })
}
watch(allLogs, () => { scheduleLogScroll() })
function scrollToBottom() { scheduleLogScroll(true) }

onMounted(async () => {
  // 农牧场页面各自默认筛选对应模块；用户手动删除胶囊后当前保持，
  // 但下次切换页面（组件重新挂载）或换账号会重新套用默认筛选。
  if (props.defaultModule) filter.module = props.defaultModule
  const filteredBefore = !realtimeLogsEnabled.value
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  await loadLogs(filteredBefore)
  scrollToBottom()
})
onBeforeUnmount(() => {
  if (keywordTimer) clearTimeout(keywordTimer)
  if (logScrollFrame !== undefined) window.cancelAnimationFrame(logScrollFrame)
})
useIntervalFn(loadLogs, 10000)

function formatLogTime(timeStr: string) {
  if (!timeStr) return ''
  const parts = String(timeStr).split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}
</script>

<template>
  <div class="run-log-panel flex min-h-0 flex-1 flex-col">
    <div class="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
      <h3 class="flex shrink-0 items-center gap-2 whitespace-nowrap text-lg font-bold">
        <span class="i-carbon-document" /> <span>运行日志</span>
      </h3>

      <div class="run-log-filters">
        <BaseSelect v-model="filter.module" :options="modules" @change="onLogFilterChange" />
        <BaseSelect v-model="filter.submodule" :options="submoduleOptions" @change="onLogFilterChange" />
        <BaseSelect v-model="filter.event" :options="events" @change="onLogFilterChange" />
        <BaseSelect v-model="filter.level" :options="levels" @change="onLogFilterChange" />
        <BaseInput v-model="filter.keyword" placeholder="关键词" clearable @keyup.enter="onLogSearchTrigger" @clear="onLogSearchTrigger" />
        <div class="run-log-filters__buttons">
          <BaseButton variant="primary" class="run-log-filters__icon" title="搜索日志" aria-label="搜索日志" @click="onLogSearchTrigger">
            <span class="i-carbon-search" />
          </BaseButton>
          <BaseButton variant="secondary" class="run-log-filters__icon" title="清空日志" aria-label="清空日志" :loading="clearingLogs" @click="clearLogs">
            <template #icon><span class="i-carbon-trash-can" /></template>
          </BaseButton>
        </div>
      </div>
    </div>

    <div v-if="activeFilterChips.length" class="run-log-chips">
      <span class="text-gray-400">筛选中</span>
      <button v-for="chip in activeFilterChips" :key="chip.key" class="run-log-chip" :title="`移除筛选：${chip.label}`" @click="removeFilter(chip.key)">
        {{ chip.label }} <span class="opacity-60">×</span>
      </button>
      <button class="run-log-chip-clear" @click="clearAllLogFilters">清除全部</button>
    </div>

    <div class="run-log-list" :class="listClass">
      <div ref="logContainer" class="run-log-scroll" @scroll="onLogScroll">
        <div v-if="!allLogs.length" class="py-8 text-center text-gray-400">暂无日志</div>
        <template v-for="(group, index) in logGroups" :key="group.uid">
          <div v-if="showDateDivider(index)" class="run-log-date">{{ dateLabel(group.dateKey) }}</div>
          <div class="log-row" :class="[`log-row--${group.level}`, { 'log-row--ranch': isRanchLog(group.log) }]">
            <span class="log-row__time">{{ formatLogTime(group.log.time) }}</span>
            <span class="log-row__tag">{{ getModulePath(group.log) }}</span>
            <span class="log-row__body">
              <span v-if="getEventLabel(group.log.meta?.event)" class="log-row__event">{{ getEventLabel(group.log.meta.event) }}</span>
              <span class="log-row__msg">{{ group.log.msg }}</span>
              <button v-if="group.count > 1" class="log-row__repeat" :title="`${formatLogTime(group.firstTime)} 起重复 ${group.count} 次`" @click="toggleGroup(group.uid)">
                ×{{ group.count }} · {{ expandedGroups[group.uid] ? '收起' : '展开' }}
              </button>
            </span>
          </div>
          <div v-if="group.count > 1 && expandedGroups[group.uid]" class="run-log-expanded">
            <div v-for="(sub, si) in group.logs" :key="si" class="run-log-expanded__row">
              <span class="log-row__time">{{ formatLogTime(sub.time) }}</span>
              <span class="run-log-expanded__path">{{ getModulePath(sub) }}</span>
              <span class="log-row__msg">{{ getEventLabel(sub.meta?.event) }} {{ sub.msg }}</span>
            </div>
          </div>
        </template>
      </div>
      <button v-if="!autoScroll && allLogs.length" class="run-log-to-latest" title="回到最新日志" @click="scrollToBottom">
        <span class="i-carbon-arrow-down" /> 回到最新
      </button>
    </div>
  </div>
</template>

<style scoped>
.run-log-filters { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.run-log-filters__buttons { display: flex; grid-column: 1 / -1; justify-content: flex-end; gap: 8px; }
.run-log-filters__icon { width: 38px; min-width: 38px; height: 38px; padding: 0 !important; }
@media (min-width: 640px) {
  .run-log-filters { grid-template-columns: repeat(5, minmax(0, 8rem)) auto; align-items: center; }
  .run-log-filters__buttons { grid-column: auto; }
}
.run-log-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 12px; }
.run-log-chip { border-radius: 9999px; padding: 3px 9px; font-size: 12px; background: color-mix(in srgb, var(--ui-primary) 12%, transparent); color: var(--ui-primary); }
.run-log-chip-clear { margin-left: 4px; font-size: 12px; color: var(--ui-primary); }
.run-log-scroll { min-height: 0; height: 100%; overflow-y: auto; padding: 6px; border-radius: var(--ui-radius-control); background: var(--ui-surface-soft); font-size: 13px; line-height: 1.55; }
.run-log-list { position: relative; min-height: 0; }
.run-log-date { padding: 6px 10px 4px; color: var(--ui-subtle); font-size: 11px; font-weight: 600; }
.log-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: baseline; gap: 10px; padding: 5px 8px 5px 10px; border-left: 3px solid transparent; border-radius: 6px; content-visibility: auto; contain-intrinsic-size: auto 28px; }
.log-row + .log-row { margin-top: 2px; }
.log-row__time { color: var(--ui-subtle); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; white-space: nowrap; user-select: none; }
.log-row__tag { min-width: 2.5em; color: var(--ui-muted); font-size: 12px; font-weight: var(--fw-600); white-space: nowrap; }
.log-row__body { min-width: 0; color: var(--ui-ink); overflow-wrap: anywhere; }
.log-row__event { margin-right: 6px; color: var(--ui-muted); font-size: 12px; }
.log-row__event::after { margin-left: 6px; color: var(--ui-subtle); content: '·'; }
.log-row__repeat { display: inline-block; margin-left: 8px; padding: 0 6px; border-radius: 999px; background: var(--ui-surface-strong); color: var(--ui-muted); font-size: 11px; white-space: nowrap; cursor: pointer; }
.log-row__repeat:hover { color: var(--ui-primary); }
.run-log-expanded { margin: 0 8px 6px 40px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, var(--ui-surface-strong) 60%, transparent); }
.run-log-expanded__row { display: flex; gap: 10px; padding: 2px 0; font-size: 12px; }
.run-log-expanded__path { color: var(--ui-muted); white-space: nowrap; }
.log-row--success { border-left-color: var(--ui-primary); }
.log-row--success.log-row--ranch { border-left-color: var(--ui-violet); }
.log-row--warn { border-left-color: var(--ui-warning); background: color-mix(in srgb, var(--ui-warning-soft) 70%, transparent); }
.log-row--warn .log-row__tag { color: var(--ui-warning); }
.log-row--error { border-left-color: var(--ui-danger); background: color-mix(in srgb, var(--ui-danger-soft) 80%, transparent); }
.log-row--error .log-row__tag, .log-row--error .log-row__msg { color: var(--ui-danger); }
.run-log-to-latest { position: absolute; right: 16px; bottom: 14px; display: flex; align-items: center; gap: 4px; padding: 5px 12px; border-radius: 999px; font-size: 12px; color: var(--ui-ink); background: color-mix(in srgb, var(--ui-surface-strong) 82%, transparent); border: 1px solid var(--ui-border); backdrop-filter: blur(4px); }
.run-log-to-latest:hover { background: var(--ui-surface-strong); }
@media (max-width: 640px) {
  .log-row { grid-template-columns: auto minmax(0, 1fr); gap: 2px 8px; }
  .log-row__body { grid-column: 1 / -1; }
  .run-log-expanded { margin-left: 8px; }
}
</style>
