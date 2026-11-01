<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NConfigProvider } from 'naive-ui/es/config-provider'
import { computed } from 'vue'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'

const props = defineProps<{
  title: string
  remaining?: string
  balance?: string
  currencyImage?: string
  currencyName?: string
  loading?: boolean
  showRefresh?: boolean
}>()

defineEmits<{
  back: []
  refresh: []
}>()

// 活动页只有浅色设计，标题栏跟随活动保持浅色，不随全站深色切换。
const lightOverrides = createNaiveThemeOverrides(false)

const DAY_MS = 86400000

function daysLeftUntil(month: number, day: number, startMonth: number): number | null {
  const now = new Date()
  let year = now.getFullYear()
  // 跨年活动（如 12/20 — 1/10）的结束日期落在下一年。
  if (month < startMonth && now.getMonth() + 1 >= startMonth)
    year += 1
  const end = new Date(year, month - 1, day)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((end.getTime() - today.getTime()) / DAY_MS)
  return Number.isFinite(diff) ? diff : null
}

// 各活动传入的时间文案格式不一，这里统一成易读的中文写法。
const meta = computed(() => {
  const raw = String(props.remaining || '').trim()
  const range = raw.match(/^(\d{1,2})\/(\d{1,2})\s*[—–~-]+\s*(\d{1,2})\/(\d{1,2})$/)
  if (range) {
    const [startMonth, startDay, endMonth, endDay] = range.slice(1).map(Number) as [number, number, number, number]
    const left = daysLeftUntil(endMonth, endDay, startMonth)
    let badge = ''
    if (left !== null && left >= 0)
      badge = left === 0 ? '今天结束' : `还剩 ${left} 天`
    else if (left !== null)
      badge = '已结束'
    return { text: `${startMonth}月${startDay}日 – ${endMonth}月${endDay}日`, badge, icon: 'i-carbon-calendar' }
  }
  const countdown = raw.replace(/^剩余[：:]\s*/, '')
  if (countdown !== raw)
    return { text: `还剩 ${countdown.replace(/(\d+)\s*(天|小时|分钟)/g, '$1 $2 ').trim()}`, badge: '', icon: 'i-carbon-time' }
  return { text: raw, badge: '', icon: 'i-carbon-time' }
})
</script>

<template>
  <NConfigProvider :theme="null" :theme-overrides="lightOverrides" abstract>
    <header class="activity-header">
      <NButton secondary circle class="activity-header__back" title="返回活动列表" aria-label="返回活动列表" @click="$emit('back')">
        <template #icon>
          <span class="i-carbon-arrow-left" />
        </template>
      </NButton>

      <div class="activity-header__title">
        <h1>{{ title || '活动详情' }}</h1>
        <p v-if="meta.text" class="activity-header__meta">
          <span class="activity-header__meta-icon" :class="meta.icon" aria-hidden="true" />
          <span class="activity-header__meta-text">{{ meta.text }}</span>
          <span v-if="meta.badge" class="activity-header__badge">{{ meta.badge }}</span>
        </p>
      </div>

      <div class="activity-header__actions">
        <div v-if="balance !== undefined" class="activity-header__balance" :title="currencyName">
          <img v-if="currencyImage" :src="currencyImage" alt="">
          <b>{{ balance || '--' }}</b>
        </div>
        <NButton v-if="showRefresh" secondary circle :loading="loading" title="刷新活动数据" aria-label="刷新活动数据" @click="$emit('refresh')">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </header>
  </NConfigProvider>
</template>

<style scoped>
.activity-header {
  --ui-bg: #f3f5ef;
  --ui-ink: #243028;
  --ui-muted: #6d776f;
  --ui-border: rgba(58, 86, 68, 0.1);
  --ui-warning: #b07a32;
  --ui-warning-soft: #fbf2e3;

  position: absolute;
  z-index: 20;
  inset: 0 0 auto;
  height: calc(86px + env(safe-area-inset-top));
  display: flex;
  align-items: center;
  gap: 12px;
  padding: env(safe-area-inset-top) 22px 0 18px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-ink);
  background: color-mix(in srgb, var(--ui-bg) 84%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(135%);
  backdrop-filter: blur(20px) saturate(135%);
}

.activity-header__back {
  flex: none;
  font-size: 18px;
}

.activity-header__title {
  min-width: 0;
  flex: 1;
}

h1 {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 20px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-header__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.activity-header__meta-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-header__meta-icon {
  flex: none;
  font-size: 13px;
}

.activity-header__badge {
  flex: none;
  margin-left: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  color: #2f7a52;
  background: #e4f1e7;
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
}

.activity-header__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.activity-header__balance {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px 0 5px;
  border-radius: 999px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.activity-header__balance img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

@media (max-width: 900px) {
  .activity-header {
    height: calc(72px + env(safe-area-inset-top));
    gap: 6px;
    padding-right: 10px;
    padding-left: 6px;
  }

  h1 {
    font-size: 17px;
  }

  .activity-header__meta {
    font-size: 11px;
  }

  .activity-header__balance {
    height: 30px;
    padding-right: 9px;
  }
}
</style>
