<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import DailyOverview from '@/components/DailyOverview.vue'
import { useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'

/**
 * 牧场“我的任务”：与农场同一套展示，奖励由每日例程自动领取，这里只显示状态。
 * 每日任务、分享礼包是牧场自己的；邮箱、会员、月卡按账号与农场共用。
 */
const SHARED_GIFTS = ['email_rewards', 'vip_daily_gift', 'month_card_gift']

const statusStore = useStatusStore()
const { dailyGifts, dailyGiftsLoading, currentAccountConnected: isConnected } = storeToRefs(statusStore)
const { currentAccountId } = storeToRefs(useAccountStore())
const { state, loading } = storeToRefs(useRanchStore())
const { refresh: refreshRanch } = useRanchLoader('tasks')

const tab = ref<'daily' | 'growth'>('daily')
const tasks = computed<any[]>(() => state.value?.tasks || [])
const dailyTasks = computed(() => tasks.value.filter(task => task.category === 'daily'))
const growthTasks = computed(() => tasks.value.filter(task => task.category === 'growth'))
const growthDone = computed(() => growthTasks.value.filter(task => task.claimed).length)

const overview = computed(() => {
  const auto = (key: string): Record<string, any> => dailyGifts.value?.ranch?.gifts?.find(gift => gift.key === key) || {}
  const shared = (key: string) => dailyGifts.value?.gifts?.find((gift: any) => gift.key === key)
  const daily = dailyTasks.value
  const claimed = daily.filter(task => task.claimed).length
  const taskGift = {
    ...auto('task_claim'),
    key: 'task_claim',
    label: '每日任务',
    doneToday: daily.length > 0 && claimed === daily.length,
    completedCount: claimed,
    totalCount: daily.length,
  }
  const shareAuto = auto('daily_share')
  const shareGift = {
    enabled: true,
    mode: 'auto_claim',
    ...shareAuto,
    key: 'daily_share',
    label: '分享礼包',
    doneToday: !!state.value?.dailyShare?.claimed || !!shareAuto.doneToday,
  }
  const [email, vip, month] = SHARED_GIFTS.map(shared)
  const benefit = { enabled: true, ...auto('mall_free_gifts'), key: 'mall_free_gifts', label: '每日福利', doneToday: !!state.value?.dailyBenefit?.claimed || !!auto('mall_free_gifts').doneToday }
  return {
    timeZone: dailyGifts.value?.timeZone,
    gifts: [taskGift, benefit, email, shareGift, vip, month].filter(Boolean),
  }
})

function growthStatus(task: any) {
  if (task.claimed)
    return '已领取'
  if (task.canClaim)
    return '待领取'
  if (!task.unlocked)
    return '未解锁'
  return `进度：${task.progress}/${task.total}`
}

async function refreshGifts() {
  const id = String(currentAccountId.value || '')
  if (id && isConnected.value)
    await statusStore.fetchDailyGifts(id)
}
function refresh() {
  void refreshRanch()
  void refreshGifts()
}

watch([currentAccountId, isConnected], refreshGifts, { immediate: true })
</script>

<template>
  <div class="personal-panel">
    <div class="flex shrink-0 items-center gap-3">
      <NTabs v-model:value="tab" class="min-w-0 flex-1" type="line" animated>
        <NTab name="daily">
          每日礼包与任务
        </NTab>
        <NTab name="growth">
          成长任务
        </NTab>
      </NTabs>
      <NButton circle quaternary size="small" title="刷新任务" aria-label="刷新任务" :loading="loading || dailyGiftsLoading" @click="refresh">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </div>

    <RanchGate @retry="refreshRanch">
      <DailyOverview v-show="tab === 'daily'" :daily-gifts="overview" empty-text="暂无每日礼包与任务数据" />

      <!-- 成长任务：与农场同一张卡片 -->
      <section v-show="tab === 'growth'" class="personal-panel__card farm-card rounded-xl p-4">
        <div class="mb-3 flex shrink-0 items-center justify-between gap-3">
          <h3 class="flex items-center gap-2 font-medium" style="color: var(--theme-primary, #22c55e)">
            <span class="i-carbon-growth" />
            <span>成长任务</span>
          </h3>
          <span v-if="growthTasks.length" class="rounded-lg bg-blue-50 px-2.5 py-0.5 text-xs text-blue-600 font-bold dark:bg-blue-900/20 dark:text-blue-400">
            {{ growthDone }}/{{ growthTasks.length }}
          </span>
        </div>
        <div v-if="growthTasks.length" class="space-y-2">
          <div
            v-for="task in growthTasks"
            :key="task.id"
            class="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span class="min-w-0 break-words" style="color: var(--theme-text, #6b7280); opacity: 0.85">{{ task.desc }}</span>
            <span class="shrink-0 text-xs text-gray-500">{{ growthStatus(task) }}</span>
          </div>
        </div>
        <div v-else class="text-center text-sm text-gray-400">
          暂无成长任务
        </div>
      </section>
    </RanchGate>
  </div>
</template>
