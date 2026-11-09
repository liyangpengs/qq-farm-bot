<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  dailyGifts: any
  emptyText?: string
}>(), { emptyText: '暂无每日奖励数据' })

const GIFT_ICONS: Record<string, string> = {
  task_claim: 'i-carbon-task-complete',
  email_rewards: 'i-carbon-email',
  mall_free_gifts: 'i-carbon-shopping-bag',
  daily_share: 'i-carbon-share',
  vip_daily_gift: 'i-carbon-star',
  month_card_gift: 'i-carbon-calendar',
}

function getGiftIcon(key: string) {
  return GIFT_ICONS[key] || 'i-carbon-gift'
}

const hasDailyData = computed(() => !!props.dailyGifts)
const gifts = computed(() => props.dailyGifts?.gifts || [])

function formatTime(timestamp: number) {
  if (!timestamp)
    return '未领取'
  const d = new Date(timestamp)
  const timeZone = props.dailyGifts?.timeZone
  if (timeZone) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
  }
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function getGiftStatusText(gift: any) {
  if (!gift)
    return '未知'
  if (gift.key === 'email_rewards') {
    if (gift.result === 'running')
      return '正在检查'
    if (gift.result === 'error')
      return '检查失败（今日跳过）'
    if (gift.result === 'partial')
      return '部分领取失败（今日跳过）'
    if (gift.result === 'none' && gift.doneToday)
      return '今日已检查（无奖励）'
  }
  if (gift.result === 'error')
    return '领取失败'
  if (gift.result === 'partial')
    return '部分领取失败'
  if (gift.key === 'daily_share' && gift.mode === 'check_only')
    return '仅检测/待人工确认'
  if (gift.key === 'vip_daily_gift' && (gift.isVip === false || (gift.isVip == null && gift.hasGift === false)))
    return '未开通'
  if (gift.key === 'vip_daily_gift' && gift.isVip === true && gift.hasGift === false)
    return '暂无礼包'
  if (gift.key === 'month_card_gift' && gift.hasCard === false)
    return '未开通'
  if (gift.doneToday)
    return '今日已完成'
  if (gift.enabled)
    return '等待执行'
  return '未开启'
}

function formatGiftSubText(gift: any) {
  if (!gift)
    return ''
  if (gift.key === 'email_rewards') {
    const hour = Number(gift.scheduledHour)
    const scheduleText = Number.isFinite(hour) ? `每天 ${String(hour).padStart(2, '0')}:00 检查` : '每天定时检查'
    if (gift.result === 'running')
      return '正在检查邮箱奖励…'
    if (gift.result === 'error' || gift.result === 'partial')
      return gift.lastAt ? `最近检查 ${formatTime(Number(gift.lastAt))}，今日不再重试` : '今日检查未完成'
    if (gift.result === 'none' && gift.doneToday)
      return gift.lastAt ? `检查时间 ${formatTime(Number(gift.lastAt))}，暂无可领取邮件` : '今日暂无可领取邮件'
    if (!gift.doneToday)
      return scheduleText
  }
  if (gift.result === 'error' || gift.result === 'partial')
    return gift.lastAt ? `最近检查 ${formatTime(Number(gift.lastAt))}` : '等待下次检查'
  if (gift.key === 'daily_share' && gift.mode === 'check_only') {
    const checkedAt = Number(gift.lastAt || 0)
    const timeText = checkedAt ? `，最近检测 ${formatTime(checkedAt)}` : ''
    if (gift.checkStatus === 'entry_available')
      return `入口可用${timeText}`
    if (gift.checkStatus === 'entry_unavailable')
      return `入口暂不可用${timeText}`
    if (gift.checkStatus === 'check_failed')
      return `检测失败，待下次重试${timeText}`
    return '尚未检测'
  }
  if (gift.key === 'vip_daily_gift' && (gift.isVip === false || (gift.isVip == null && gift.hasGift === false)))
    return '未开通QQ会员或无每日礼包'
  if (gift.key === 'vip_daily_gift' && gift.isVip === true && gift.hasGift === false)
    return '已开通会员，当前没有可领取礼包'
  if (gift.key === 'month_card_gift' && gift.hasCard === false)
    return '未购买月卡或已过期'
  const ts = Number(gift.lastAt || 0)
  if (!ts)
    return ''
  if (gift.doneToday)
    return `完成时间 ${formatTime(ts)}`
  if (gift.enabled)
    return `上次执行 ${formatTime(ts)}`
  return `上次检测 ${formatTime(ts)}`
}

function formatGiftProgress(gift: any) {
  if (!gift)
    return ''
  const total = Number(gift.totalCount || 0)
  const current = Number(gift.completedCount || 0)
  if (!total)
    return ''
  return `进度：${current}/${total}`
}
</script>

<template>
  <section class="personal-panel__card farm-card rounded-xl p-4">
    <h3 class="mb-3 flex shrink-0 items-center gap-2 font-medium" style="color: var(--theme-primary, #ec4899)">
      <span class="i-carbon-gift" />
      <span>每日礼包 & 任务</span>
    </h3>
    <div class="personal-panel__scroll custom-scrollbar" role="region" aria-label="每日礼包与任务列表" tabindex="0">
      <div
        v-if="!hasDailyData"
        class="rounded-xl p-6 text-center text-sm"
        style="background: color-mix(in srgb, var(--theme-bg, #fff) 90%, var(--theme-primary, #3b82f6)); color: var(--theme-text, #6b7280); opacity: 0.7"
      >
        {{ emptyText }}
      </div>
      <div
        v-else-if="!gifts.length"
        class="rounded-xl p-6 text-center text-sm"
        style="background: color-mix(in srgb, var(--theme-bg, #fff) 90%, var(--theme-primary, #3b82f6)); color: var(--theme-text, #6b7280); opacity: 0.7"
      >
        {{ emptyText }}
      </div>
      <div v-else class="grid grid-cols-2 gap-3 2xl:grid-cols-3 sm:grid-cols-3 2xl:gap-4">
        <div
          v-for="gift in gifts"
          :key="gift.key"
          class="flex flex-col justify-between farm-card rounded-xl p-3 2xl:p-4"
        >
          <div class="mb-2 flex items-center gap-2">
            <div
              class="h-7 w-7 flex flex-shrink-0 items-center justify-center rounded-lg text-base 2xl:h-8 2xl:w-8 2xl:text-lg"
              :class="gift.result === 'error' || gift.result === 'partial'
                ? 'bg-red-100 dark:bg-red-900/30'
                : gift.key === 'daily_share' && gift.mode === 'check_only'
                  ? 'bg-blue-100 dark:bg-blue-900/30'
                  : (gift.doneToday ? 'bg-green-100 dark:bg-green-900/30' : (gift.enabled ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-gray-100 dark:bg-gray-700'))"
            >
              <span :class="getGiftIcon(gift.key)" />
            </div>
            <span class="text-sm leading-tight font-medium 2xl:text-base" style="color: var(--theme-text, #374151)">
              {{ gift.label }}
            </span>
          </div>

          <div class="flex flex-col items-start gap-1">
            <span
              class="text-xs 2xl:text-sm"
              :class="gift.result === 'error' || gift.result === 'partial'
                ? 'text-red-500'
                : gift.key === 'daily_share' && gift.mode === 'check_only'
                  ? 'text-blue-500'
                  : (gift.doneToday ? 'text-green-500' : (gift.enabled ? 'text-blue-500' : 'text-gray-400'))"
            >
              {{ getGiftStatusText(gift) }}
            </span>

            <div class="flex flex-col items-start">
              <span v-if="formatGiftProgress(gift)" class="text-xs font-bold 2xl:text-sm" style="color: var(--theme-secondary, #6b7280)">
                {{ formatGiftProgress(gift) }}
              </span>
              <span
                v-if="formatGiftSubText(gift)"
                class="mt-0.5 text-[10px] text-gray-400 2xl:text-xs"
              >
                {{ formatGiftSubText(gift) }}
              </span>
            </div>
          </div>
          <p
            v-if="(gift.result === 'error' || gift.result === 'partial') && gift.lastError"
            class="line-clamp-3 mt-2 break-all text-xs text-red-500"
            :title="gift.lastError"
          >
            {{ gift.lastError }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
