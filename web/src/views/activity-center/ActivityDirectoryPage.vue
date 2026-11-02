<script setup lang="ts">
import type { ActivityDirectoryItemDto } from '@/stores/activity-center'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { activityHasGameplay } from '@/components/activity/gameplays'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'
import PetMascot from './PetMascot.vue'
import { useActivityClock } from './useActivityClock'

const emit = defineEmits<{
  back: []
  open: [activity: ActivityDirectoryItemDto]
}>()

const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const { currentAccountId } = storeToRefs(accountStore)
const { activities, season, shop, solarTerms, constellation, qixi, qingMei, charity, weather, loading, error, loadedAccountId } = storeToRefs(activityStore)
const { serverNow } = useActivityClock()

type ActivityStatus = 'active' | 'upcoming' | 'ended'

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const accountDataLoaded = computed(() => !!currentAccountId.value && loadedAccountId.value === String(currentAccountId.value))
const stellarDetailsAvailable = computed(() => !!(season.value || shop.value || constellation.value || solarTerms.value))
const displayActivities = computed<ActivityDirectoryItemDto[]>(() => {
  const entries: ActivityDirectoryItemDto[] = activities.value.length > 0
    ? [...activities.value]
    : stellarDetailsAvailable.value
      ? [{
        id: season.value?.pass?.activityId || season.value?.id || 'stellar',
        activityIds: [season.value?.pass?.activityId || season.value?.id || 'stellar'],
        name: season.value?.title || '千星游记',
        startTime: season.value?.startTime || null,
        endTime: season.value?.endTime || null,
        gameplayKey: 'stellar',
        gameplayTargets: ['travel', 'constellation', 'shop', 'solar'],
        detailTarget: season.value?.pass ? 'travel' : constellation.value ? 'constellation' : shop.value ? 'shop' : 'solar',
      } satisfies ActivityDirectoryItemDto]
      : []

  const appendDetailEntry = (entry: ActivityDirectoryItemDto) => {
    if (!entries.some(item => item.activityIds.some(id => entry.activityIds.includes(id))))
      entries.push(entry)
  }
  if (qixi.value) {
    appendDetailEntry({
      id: qixi.value.groupId || qixi.value.activityId,
      activityIds: [qixi.value.groupId, qixi.value.bridgeActivityId, qixi.value.giftActivityId].filter(Boolean),
      name: qixi.value.title,
      startTime: qixi.value.startTime,
      endTime: qixi.value.endTime,
      gameplayKey: 'qixi',
      gameplayTargets: ['qixi'],
      detailTarget: 'qixi',
    })
  }
  if (qingMei.value) {
    appendDetailEntry({
      id: qingMei.value.activityId,
      activityIds: [qingMei.value.dailyActivityId, qingMei.value.activityId].filter(Boolean),
      name: qingMei.value.title,
      startTime: qingMei.value.startTime,
      endTime: qingMei.value.endTime,
      gameplayKey: 'qingmei',
      gameplayTargets: ['qingmei'],
      detailTarget: 'qingmei',
    })
  }
  if (charity.value) {
    appendDetailEntry({
      id: charity.value.groupId || charity.value.activityId,
      activityIds: [charity.value.groupId, charity.value.activityId].filter(Boolean),
      name: charity.value.title,
      startTime: charity.value.startTime,
      endTime: charity.value.endTime,
      gameplayKey: 'charity',
      gameplayTargets: ['charity'],
      detailTarget: 'charity',
    })
  }
  if (weather.value) {
    appendDetailEntry({
      id: weather.value.groupId || weather.value.activityId,
      activityIds: [weather.value.groupId, weather.value.catalogActivityId, weather.value.taskActivityId, weather.value.researchActivityId].filter(Boolean),
      name: weather.value.title,
      startTime: weather.value.startTime,
      endTime: weather.value.endTime,
      gameplayKey: 'weather',
      gameplayTargets: ['weather'],
      detailTarget: 'weather',
    })
  }

  const statusRank: Record<ActivityStatus, number> = { active: 0, upcoming: 1, ended: 2 }
  return entries.sort((left, right) => {
    const leftStatus = activityStatus(left)
    const rightStatus = activityStatus(right)
    if (leftStatus !== rightStatus)
      return statusRank[leftStatus] - statusRank[rightStatus]
    if (leftStatus === 'ended')
      return (right.endTime || 0) - (left.endTime || 0)
    return (left.startTime || 0) - (right.startTime || 0)
  })
})
const hasActivities = computed(() => displayActivities.value.length > 0)

function accountId() {
  return String(currentAccountId.value || '')
}
function load(force = false) {
  return force ? activityStore.refresh(accountId()) : activityStore.lazyLoad(accountId())
}
function validActivityTime(value: unknown): number | null {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null
}
function activityStatus(activity: ActivityDirectoryItemDto): ActivityStatus {
  const startTime = validActivityTime(activity.startTime)
  const endTime = validActivityTime(activity.endTime)
  if (endTime !== null && serverNow.value >= endTime)
    return 'ended'
  if (startTime !== null && serverNow.value < startTime)
    return 'upcoming'
  return 'active'
}
function activityStatusLabel(activity: ActivityDirectoryItemDto) {
  return { active: '进行中', upcoming: '未开始', ended: '已结束' }[activityStatus(activity)]
}
function isNewbieActivity(activity: ActivityDirectoryItemDto) {
  return activity.activityIds.some(id => id === '2026092200' || id === '2026092201')
}
const LONG_TERM_MS = 365 * 24 * 60 * 60 * 1000
/**
 * 常驻条目：新手福利，或开放期超过一年且工具没有对应玩法的条目。
 * 目录里的日期只是全局开放期，不代表账号有资格，所以不和限时活动混排，也不显示“进行中”。
 */
function isStandingActivity(activity: ActivityDirectoryItemDto) {
  if (activityStatus(activity) === 'ended')
    return false
  if (isNewbieActivity(activity))
    return true
  const startTime = validActivityTime(activity.startTime)
  const endTime = validActivityTime(activity.endTime)
  return !activityHasGameplay(activity) && startTime !== null && endTime !== null && endTime - startTime > LONG_TERM_MS
}
const timedActivities = computed(() => displayActivities.value.filter(activity => !isStandingActivity(activity)))
const standingActivities = computed(() => displayActivities.value.filter(isStandingActivity))
/** 进行中与即将开始的限时活动用大卡片；已结束的折叠到往期列表。 */
const currentActivities = computed(() => timedActivities.value.filter(activity => activityStatus(activity) !== 'ended'))
interface PastActivityRow { key: string, name: string, activity: ActivityDirectoryItemDto, ids: string[] }
/** 同名同时间的往期条目（同一活动的多个子 ID）合并成一行。顺序沿用目录排序：结束越晚越靠前。 */
const pastActivities = computed(() => {
  const rows = new Map<string, PastActivityRow>()
  for (const activity of timedActivities.value) {
    if (activityStatus(activity) !== 'ended')
      continue
    const name = activityDisplayName(activity)
    const key = `${name}|${activity.startTime ?? ''}|${activity.endTime ?? ''}`
    const row = rows.get(key)
    if (row)
      row.ids.push(activity.id)
    else
      rows.set(key, { key, name, activity, ids: [activity.id] })
  }
  return [...rows.values()]
})
const pastGroups = computed(() => {
  const groups: Array<{ key: string, label: string, rows: PastActivityRow[] }> = []
  for (const row of pastActivities.value) {
    const endTime = validActivityTime(row.activity.endTime)
    const date = endTime === null ? null : new Date(endTime)
    const key = date ? `${date.getFullYear()}-${date.getMonth()}` : 'unknown'
    let group = groups.find(entry => entry.key === key)
    if (!group) {
      group = { key, label: date ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月结束` : '结束时间未知', rows: [] }
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
})
/**
 * 同名活动通常是同一玩法在不同时期复办。按“名称 + 起止时间”去重后统计期数，
 * 只统计当前目录里能看到的期次（包括进行中的那一期）。
 */
const editionCounts = computed(() => {
  const periods = new Map<string, Set<string>>()
  for (const activity of timedActivities.value) {
    const name = activityDisplayName(activity)
    const set = periods.get(name) || new Set<string>()
    set.add(`${activity.startTime ?? ''}|${activity.endTime ?? ''}`)
    periods.set(name, set)
  }
  return new Map([...periods].map(([name, set]) => [name, set.size]))
})
const pastOpen = ref(false)
const pickerSummary = computed(() => {
  if (!hasActivities.value)
    return '按当前账号读取活动'
  const parts = [`${currentActivities.value.length} 个进行中`]
  if (standingActivities.value.length)
    parts.push(`${standingActivities.value.length} 项常驻`)
  if (pastActivities.value.length)
    parts.push(`${pastActivities.value.length} 个往期`)
  return parts.join(' · ')
})
function activityDisplayName(activity: ActivityDirectoryItemDto) {
  return activity.gameplayKey === 'pet' ? '萌宠日记' : activity.name
}
function activityIconSrc(activity: ActivityDirectoryItemDto) {
  if (activity.gameplayKey === 'pet')
    return '/activity-assets/pet-diary/S3Open_dog_1.png'
  if (activity.gameplayKey === 'milk')
    return '/activity-assets/milk-tea/logo.png'
  if (activity.gameplayKey === 'wish' || activity.gameplayKey === 'happy')
    return `/activity-assets/autumn/${activity.gameplayKey}.png`
  return ''
}
const shortDateFormatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' })
function formatShortPeriod(activity: ActivityDirectoryItemDto) {
  const startTime = validActivityTime(activity.startTime)
  const endTime = validActivityTime(activity.endTime)
  const start = startTime === null ? '?' : shortDateFormatter.format(startTime)
  const end = endTime === null ? '?' : shortDateFormatter.format(endTime)
  return `${start} – ${end}`
}
function standingDescription(activity: ActivityDirectoryItemDto) {
  return isNewbieActivity(activity) ? '新手开园福利：签到、开园特权与引导奖励' : '长期开放的常驻内容'
}
function standingPeriod(activity: ActivityDirectoryItemDto) {
  const endTime = validActivityTime(activity.endTime)
  if (activityStatus(activity) === 'active' && (endTime === null || endTime - serverNow.value > LONG_TERM_MS))
    return '长期开放'
  return formatActivityPeriod(activity)
}
function activityCanOpen(activity: ActivityDirectoryItemDto) {
  return activityHasGameplay(activity) && activityStatus(activity) === 'active'
}
function formatActivityPeriod(activity: ActivityDirectoryItemDto) {
  const startTime = validActivityTime(activity.startTime)
  const endTime = validActivityTime(activity.endTime)
  const start = startTime === null ? '' : dateFormatter.format(startTime)
  const end = endTime === null ? '' : dateFormatter.format(endTime)
  if (start && end)
    return `${start} - ${end}`
  if (start)
    return `${start} 开始`
  if (end)
    return `${end} 结束`
  return '活动时间待定'
}
function openActivity(activity: ActivityDirectoryItemDto) {
  if (activityCanOpen(activity))
    emit('open', activity)
}
</script>

<template>
  <section class="activity-picker page-stack">
    <div class="page-toolbar">
      <span class="text-sm text-gray-500">{{ pickerSummary }}</span>
      <NButton :loading="loading" :disabled="!currentAccountId" @click="load(true)">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
        刷新
      </NButton>
    </div>
    <div v-if="!currentAccountId" class="picker-state">
      <div class="i-carbon-user-avatar" />
      <strong>请先选择账号</strong>
      <span>选择账号后查看当前活动</span>
    </div>
    <div v-else-if="loading && !accountDataLoaded" class="picker-state">
      <div class="activity-spinner picker-spinner" />
      <strong>正在加载活动</strong>
    </div>
    <div v-else-if="error && !hasActivities" class="picker-state">
      <div class="i-carbon-warning-alt" />
      <strong>活动加载失败</strong>
      <span>{{ error }}</span>
      <button type="button" :disabled="loading" @click="load(true)">
        重新加载
      </button>
    </div>
    <div v-else-if="accountDataLoaded && !loading && !hasActivities" class="picker-state empty-activities">
      <div class="i-carbon-calendar" />
      <strong>当前无活动</strong>
      <span>服务器暂未返回活动配置</span>
      <button type="button" @click="load(true)">
        刷新活动
      </button>
    </div>
    <div v-else class="picker-sections">
      <section class="picker-section" aria-labelledby="current-activities-title">
        <h3 id="current-activities-title" class="picker-section__title">
          进行中<small>{{ currentActivities.length }}</small>
        </h3>
        <div v-if="currentActivities.length" class="picker-list">
          <button
            v-for="activity in currentActivities"
            :key="activity.id"
            type="button"
            class="activity-entry"
            :class="[`activity-entry--${activityStatus(activity)}`, { 'activity-entry--supported': activityCanOpen(activity) }]"
            :disabled="!activityCanOpen(activity)"
            @click="openActivity(activity)"
          >
            <span class="activity-entry__topline">
              <span class="activity-entry__icon"><PetMascot v-if="activity.gameplayKey === 'pet'" stage="puppy" class="activity-entry__pet" /><img v-else-if="activityIconSrc(activity)" :src="activityIconSrc(activity)" alt="" width="36" height="36" style="object-fit: contain"><span v-else class="i-carbon-calendar" /></span>
              <span class="activity-entry__status">{{ activityStatusLabel(activity) }}</span>
            </span>
            <strong>{{ activityDisplayName(activity) }}</strong>
            <span class="activity-entry__period">{{ formatActivityPeriod(activity) }}</span>
            <span class="activity-entry__footer">
              <small>{{ activity.id }}</small>
              <span v-if="activityCanOpen(activity)">查看详情 <span class="i-carbon-arrow-right" /></span>
              <span v-else-if="activityStatus(activity) === 'upcoming'">活动未开始 <span class="i-carbon-locked" /></span>
              <span v-else>暂未支持详情 <span class="i-carbon-locked" /></span>
            </span>
          </button>
        </div>
        <p v-else class="picker-section__empty">
          当前没有进行中的限时活动
        </p>

        <!-- 常驻条目不是限时活动：用一条窄提示带挂在进行中下方，按内容宽度排列。 -->
        <div v-if="standingActivities.length" class="standing-strip" aria-label="常驻与福利">
          <span class="standing-strip__label">常驻</span>
          <component
            :is="activityCanOpen(activity) ? 'button' : 'span'"
            v-for="activity in standingActivities"
            :key="activity.id"
            :type="activityCanOpen(activity) ? 'button' : undefined"
            class="standing-chip"
            :class="{ 'standing-chip--supported': activityCanOpen(activity) }"
            @click="activityCanOpen(activity) && openActivity(activity)"
          >
            <span class="standing-chip__icon" :class="isNewbieActivity(activity) ? 'i-carbon-gift' : 'i-carbon-calendar'" aria-hidden="true" />
            <strong>{{ activity.name }}</strong>
            <span class="standing-chip__desc">{{ standingDescription(activity) }}</span>
            <span class="standing-chip__meta">{{ standingPeriod(activity) }}<template v-if="isNewbieActivity(activity) && !activityCanOpen(activity)"> · 资格以游戏内为准</template></span>
            <span v-if="activityCanOpen(activity)" class="i-carbon-arrow-right" aria-hidden="true" />
          </component>
        </div>
      </section>

      <section v-if="pastActivities.length" class="picker-section" aria-labelledby="past-activities-title">
        <button
          id="past-activities-title"
          type="button"
          class="picker-section__title picker-section__toggle"
          :aria-expanded="pastOpen"
          aria-controls="past-activities-list"
          @click="pastOpen = !pastOpen"
        >
          往期活动<small>{{ pastActivities.length }}</small>
          <span class="picker-section__chevron i-carbon-chevron-down" :class="{ 'is-open': pastOpen }" aria-hidden="true" />
        </button>
        <div v-if="pastOpen" id="past-activities-list" class="past-list">
          <div v-for="group in pastGroups" :key="group.key" class="past-group">
            <h4>{{ group.label }}</h4>
            <ul>
              <li v-for="row in group.rows" :key="row.key" class="past-row">
                <span class="past-row__icon"><img v-if="activityIconSrc(row.activity)" :src="activityIconSrc(row.activity)" alt=""><span v-else class="i-carbon-calendar" /></span>
                <span class="past-row__name">
                  <strong>{{ row.name }}</strong>
                  <span v-if="(editionCounts.get(row.name) || 0) > 1" class="past-row__edition" title="目录中同名活动的不同期次数">共 {{ editionCounts.get(row.name) }} 期</span>
                </span>
                <span class="past-row__period">{{ formatShortPeriod(row.activity) }}</span>
                <span class="past-row__ids" :title="row.ids.join('、')">{{ row.ids[0] }}<template v-if="row.ids.length > 1"> 等 {{ row.ids.length }} 个</template></span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.activity-picker {
  width: 100%;
  min-width: 0;
  color: var(--ui-ink);
}

.picker-sections {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 24px;
}

.picker-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.picker-section__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.picker-section__title small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
  font-variant-numeric: tabular-nums;
}

.picker-section__empty {
  margin: 0;
  padding: 18px 16px;
  border: 1px dashed var(--ui-border-strong);
  border-radius: var(--ui-radius-card);
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}

.standing-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.standing-strip__label {
  color: var(--ui-subtle);
  font-size: 12px;
}

.standing-chip {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 22%, var(--ui-border));
  border-radius: 999px;
  color: var(--ui-ink);
  background: var(--ui-warning-soft);
  font-size: 12px;
  line-height: 18px;
  text-align: left;
}

.standing-chip--supported {
  cursor: pointer;
}

.standing-chip--supported:hover {
  border-color: var(--ui-warning);
}

.standing-chip:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.standing-chip__icon {
  flex: none;
  color: var(--ui-warning);
  font-size: 15px;
}

.standing-chip strong {
  flex: none;
  font-size: 13px;
  font-weight: var(--fw-650);
}

.standing-chip__desc {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.standing-chip__meta {
  flex: none;
  color: var(--ui-subtle);
  font-size: 11px;
  white-space: nowrap;
}

.picker-section__toggle {
  align-self: flex-start;
  align-items: center;
  padding: 4px 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.picker-section__toggle:hover {
  color: var(--ui-primary);
}

.picker-section__toggle:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

.picker-section__chevron {
  color: var(--ui-subtle);
  font-size: 14px;
  transition: transform var(--spring-drag-duration) var(--spring-drag);
}

.picker-section__chevron.is-open {
  transform: rotate(180deg);
}

/* 往期活动：按结束月份分组的紧凑列表，一条一行，信息按列对齐。 */
.past-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.past-group h4 {
  margin: 0 0 6px;
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-500);
}

.past-group ul {
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ui-surface) 70%, transparent);
  list-style: none;
}

.past-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 120px 150px;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  color: var(--ui-muted);
  font-size: 12px;
}

.past-row + .past-row {
  border-top: 1px solid var(--ui-border);
}

.past-row__icon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 6px;
  color: var(--ui-subtle);
  background: var(--ui-bg-soft);
  font-size: 13px;
}

.past-row__icon img {
  width: 22px;
  height: 22px;
  object-fit: contain;
  filter: saturate(0.6);
}

.past-row__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.past-row__edition {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
  font-size: 10px;
  line-height: 16px;
}

.past-row strong {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-500);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.past-row__period,
.past-row__ids {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.past-row__ids {
  overflow: hidden;
  color: var(--ui-subtle);
  font-size: 11px;
  text-align: right;
  text-overflow: ellipsis;
}

.picker-list {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.picker-state {
  width: 100%;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 auto;
  padding: 30px;
  color: var(--ui-muted);
  text-align: center;
}

.picker-state > div {
  font-size: 38px;
}

.picker-state strong {
  color: var(--ui-ink);
  font-size: 18px;
}

.picker-state span {
  max-width: 420px;
  color: var(--ui-muted);
  font-size: 12px;
}

.picker-state button {
  min-height: 36px;
  margin-top: 8px;
  padding: 0 15px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  color: var(--ui-primary);
  background: var(--ui-surface);
  font-weight: var(--fw-700);
  cursor: pointer;
}

.picker-state button:disabled {
  opacity: 0.55;
  cursor: wait;
}

.picker-state .picker-spinner {
  width: 42px;
  height: 42px;
  font-size: 0;
}

.activity-entry {
  position: relative;
  min-height: 168px;
  display: flex;
  overflow: hidden;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 0;
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-ink);
  text-align: left;
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm);
  cursor: pointer;
  appearance: none;
}

.activity-entry--supported:hover {
  border-color: rgba(67, 141, 99, 0.3);
  box-shadow: var(--ui-shadow-md);
  transform: translateY(-1px);
}

.activity-entry--upcoming {
  border-color: rgba(186, 125, 27, 0.3);
}

.activity-entry--ended {
  border-color: rgba(89, 102, 97, 0.18);
  background: color-mix(in srgb, var(--ui-surface-soft) 70%, transparent);
}

.activity-entry:disabled {
  cursor: default;
  opacity: 1;
}

.activity-entry__topline,
.activity-entry__footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.activity-entry__topline {
  margin-bottom: 17px;
}

.activity-entry__icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.activity-entry__icon > span {
  font-size: 16px;
}

.activity-entry__status {
  padding: 3px 8px;
  border: 1px solid rgba(67, 141, 99, 0.18);
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 10px;
  font-weight: var(--fw-700);
}

.activity-entry--upcoming .activity-entry__icon,
.activity-entry--upcoming .activity-entry__status {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.activity-entry--ended .activity-entry__icon,
.activity-entry--ended .activity-entry__status {
  color: var(--ui-muted);
  background: var(--ui-bg-soft);
}

.activity-entry > strong {
  width: 100%;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 17px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-entry__period {
  margin-top: 5px;
  color: var(--ui-muted);
  font-size: 11px;
}

.activity-entry__footer {
  margin-top: auto;
  padding-top: 15px;
  color: var(--ui-muted);
}

.activity-entry__footer > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: var(--fw-700);
}

.activity-entry--supported .activity-entry__footer > span {
  color: var(--ui-primary);
}

.activity-entry__footer small {
  color: var(--ui-muted);
  font-size: 10px;
}

.activity-entry__footer .i-carbon-arrow-right,
.activity-entry__footer .i-carbon-locked {
  font-size: 13px;
}

@media (max-width: 1100px) and (min-width: 621px) {
  .picker-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .past-row {
    grid-template-columns: 24px minmax(0, 1fr) auto;
    gap: 2px 10px;
  }

  .past-row__ids {
    display: none;
  }

  .standing-chip {
    flex-wrap: wrap;
    border-radius: 12px;
  }

  .standing-chip__desc {
    flex-basis: 100%;
    white-space: normal;
  }

  .picker-list {
    grid-template-columns: 1fr;
  }

  .activity-entry {
    min-height: 164px;
  }
}
.activity-entry__icon .activity-entry__pet {
  width: 26px;
  height: 26px;
}
</style>
