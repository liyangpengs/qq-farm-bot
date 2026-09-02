<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { usePlantBlacklistStore } from '@/stores/plant-blacklist'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import ConfigManage from '@/views/ConfigManage.vue'

const accountStore = useAccountStore()
const plantBlacklistStore = usePlantBlacklistStore()
const settingStore = useSettingStore()
const toast = useToastStore()
const statusStore = useStatusStore()
const { currentAccountId } = storeToRefs(accountStore)
const { blacklist } = storeToRefs(plantBlacklistStore)
const { settings } = storeToRefs(settingStore)
const { status } = storeToRefs(statusStore)

const loading = ref(false)
const list = ref<any[]>([])
const sortKey = ref('exp')
const imageErrors = ref<Record<string | number, boolean>>({})
const batchLoading = ref(false)

type AnalysisTab = 'strategy' | 'blacklist' | 'seeds' | 'fruits' | 'items'
type ConfigSection = 'seeds' | 'fruits' | 'items'

const activeTab = ref<AnalysisTab>('strategy')
const isConfigTab = computed(() => ['seeds', 'fruits', 'items'].includes(activeTab.value))
const configSection = computed(() => activeTab.value as ConfigSection)
const configTabs: Array<{ key: ConfigSection, icon: string, label: string }> = [
  { key: 'seeds', icon: 'i-carbon-sprout', label: '种子' },
  { key: 'fruits', icon: 'i-carbon-apple', label: '果实' },
  { key: 'items', icon: 'i-carbon-tool-box', label: '道具' },
]

const strategyLevel = ref(1)

watch(() => status.value?.status?.level, (newLevel) => {
  if (newLevel && Number(newLevel) > 0) {
    strategyLevel.value = Number(newLevel)
  }
}, { immediate: true })

const strategies = [
  {
    key: 'max_exp',
    label: '经验/时',
    metric: 'expPerHour',
    color: 'purple',
    icon: 'i-carbon-chart-line',
    unit: 'EXP',
    desc: '每小时经验收益最高',
  },
  {
    key: 'max_profit',
    label: '利润/时',
    metric: 'profitPerHour',
    color: 'amber',
    icon: 'i-carbon-currency-dollar',
    unit: '金币',
    desc: '每小时净利润最高',
  },
  {
    key: 'max_fert_exp',
    label: '普肥经验/时',
    metric: 'normalFertilizerExpPerHour',
    color: 'blue',
    icon: 'i-carbon-chemistry',
    unit: 'EXP',
    desc: '使用普通化肥后经验最高',
  },
  {
    key: 'max_fert_profit',
    label: '普肥利润/时',
    metric: 'normalFertilizerProfitPerHour',
    color: 'green',
    icon: 'i-carbon-money',
    unit: '金币',
    desc: '使用普通化肥后利润最高',
  },
  {
    key: 'level',
    label: '最高等级',
    metric: 'level',
    color: 'rose',
    icon: 'i-carbon-star',
    unit: 'Lv',
    desc: '等级最高的作物',
  },
]

const strategyLabelMap: Record<string, string> = {
  preferred: '优先种植种子',
  level: '最高等级作物',
  max_exp: '最大经验/时',
  max_fert_exp: '最大普通肥经验/时',
  max_profit: '最大净利润/时',
  max_fert_profit: '最大普通肥净利润/时',
  bag_priority: '背包种子优先',
}

const currentStrategy = computed(() => settings.value?.plantingStrategy || 'max_exp')
const currentStrategyLabel = computed(() => strategyLabelMap[currentStrategy.value] || currentStrategy.value)
const preferredSeedId = computed(() => settings.value?.preferredSeedId || 0)

const currentStrategyBestPlant = computed(() => {
  if (currentStrategy.value === 'preferred' && preferredSeedId.value > 0) {
    const found = list.value.find((item: any) => item.seedId === preferredSeedId.value)
    if (found)
      return found
  }
  if (currentStrategy.value === 'bag_priority') {
    return null
  }
  return getStrategyBestPlant(currentStrategy.value)
})

function getStrategyBestPlant(strategyKey: string) {
  const strategy = strategies.find(s => s.key === strategyKey)
  if (!strategy)
    return null

  const metric = strategy.metric
  const filtered = list.value.filter((item) => {
    const level = item.level
    if (level === null || level === undefined)
      return true
    return Number(level) <= strategyLevel.value
  })

  if (filtered.length === 0)
    return null

  if (strategyKey === 'level') {
    return [...filtered].sort((a, b) => {
      const av = a.level ?? -1
      const bv = b.level ?? -1
      return bv - av
    })[0]
  }

  return [...filtered].sort((a, b) => {
    const av = Number(a[metric])
    const bv = Number(b[metric])
    if (!Number.isFinite(av) && !Number.isFinite(bv))
      return 0
    if (!Number.isFinite(av))
      return 1
    if (!Number.isFinite(bv))
      return -1
    return bv - av
  })[0]
}

function getStrategyAvailableCount() {
  return list.value.filter((item) => {
    const level = item.level
    if (level === null || level === undefined)
      return true
    return Number(level) <= strategyLevel.value
  }).length
}

function getColorClass(color: string, type: 'bg' | 'text' | 'border' | 'gradient') {
  const colorMap: Record<string, Record<string, string>> = {
    purple: {
      bg: 'bg-purple-100 dark:bg-purple-900/30',
      text: 'text-purple-600 dark:text-purple-400',
      border: 'border-purple-200 dark:border-purple-800',
      gradient: 'from-purple-500 to-purple-600',
    },
    blue: {
      bg: 'bg-blue-100 dark:bg-blue-900/30',
      text: 'text-blue-600 dark:text-blue-400',
      border: 'border-blue-200 dark:border-blue-800',
      gradient: 'from-blue-500 to-blue-600',
    },
    amber: {
      bg: 'bg-amber-100 dark:bg-amber-900/30',
      text: 'text-amber-600 dark:text-amber-400',
      border: 'border-amber-200 dark:border-amber-800',
      gradient: 'from-amber-500 to-amber-600',
    },
    green: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-600 dark:text-green-400',
      border: 'border-green-200 dark:border-green-800',
      gradient: 'from-green-500 to-green-600',
    },
    rose: {
      bg: 'bg-rose-100 dark:bg-rose-900/30',
      text: 'text-rose-600 dark:text-rose-400',
      border: 'border-rose-200 dark:border-rose-800',
      gradient: 'from-rose-500 to-rose-600',
    },
  }
  return colorMap[color]?.[type] || ''
}

async function loadAnalytics() {
  if (!currentAccountId.value)
    return
  loading.value = true
  try {
    const res = await api.get(`/api/analytics`, {
      params: { sort: sortKey.value },
      headers: { 'x-account-id': currentAccountId.value },
    })
    const data = res.data.data
    if (Array.isArray(data)) {
      list.value = data
    }
    else {
      list.value = []
    }
  }
  catch (e) {
    console.error(e)
    list.value = []
  }
  finally {
    loading.value = false
  }
}

async function handleAddAllToBlacklist() {
  if (batchLoading.value)
    return
  batchLoading.value = true
  try {
    const allSeedIds = list.value.map((item: any) => item.seedId)
    await plantBlacklistStore.addAllToBlacklist(allSeedIds)
    toast.success(`已将 ${allSeedIds.length} 种作物加入偷菜黑名单`)
  }
  finally {
    batchLoading.value = false
  }
}

async function handleClearBlacklist() {
  if (batchLoading.value)
    return
  batchLoading.value = true
  try {
    await plantBlacklistStore.clearBlacklist()
    toast.success('已清空偷菜黑名单')
  }
  finally {
    batchLoading.value = false
  }
}

onMounted(() => {
  loadAnalytics()
  plantBlacklistStore.fetchBlacklist()
  if (currentAccountId.value) {
    settingStore.fetchSettings(currentAccountId.value)
  }
})

watch([currentAccountId, sortKey], () => {
  loadAnalytics()
  if (currentAccountId.value) {
    settingStore.fetchSettings(currentAccountId.value)
  }
})

function formatLv(level: any) {
  if (level === null || level === undefined || level === '' || Number(level) < 0)
    return '未知'
  return String(level)
}

function getSeedNameById(seedId: number) {
  const item = list.value.find((i: any) => i.seedId === seedId)
  return item?.name || `蔬菜ID:${seedId}`
}
</script>

<template>
  <div class="page-stack space-y-4">
    <NTabs v-model:value="activeTab" type="line">
      <NTab name="strategy">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-chart-line" />种植策略</span>
      </NTab>
      <NTab name="blacklist">
        <span class="inline-flex items-center gap-2">
          <span class="i-carbon-user-x-ray" />黑名单
          <span v-if="blacklist.length" class="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/50 dark:text-red-300">
            {{ blacklist.length }}
          </span>
        </span>
      </NTab>
      <NTab v-for="tab in configTabs" :key="tab.key" :name="tab.key">
        <span class="inline-flex items-center gap-2"><span :class="tab.icon" />{{ tab.label }}</span>
      </NTab>
    </NTabs>

    <div>
      <div v-if="activeTab === 'strategy'" class="space-y-4">
        <div class="overflow-hidden border farm-card border-blue-200 rounded-2xl from-blue-50 to-indigo-50 bg-gradient-to-r shadow-md dark:border-blue-800 dark:from-blue-900/20 dark:to-indigo-900/20">
          <div class="p-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="i-carbon-center-circle text-xl text-blue-500" />
                <div>
                  <h3 class="text-gray-700 font-semibold dark:text-gray-300">
                    当前策略: {{ currentStrategyLabel }}
                  </h3>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    与设置页种植策略同步
                  </p>
                </div>
              </div>
            </div>

            <div v-if="currentStrategy === 'bag_priority'" class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              背包种子优先策略：优先使用背包中的种子，按背包优先级排序，用完后回退到商店购买。具体种植内容取决于背包中实际持有的种子。
            </div>
            <div v-else-if="currentStrategyBestPlant" class="mt-3 flex items-center gap-3">
              <div class="h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden border border-blue-200 rounded-lg bg-white dark:border-blue-700 dark:bg-gray-800">
                <img
                  v-if="currentStrategyBestPlant.image && !imageErrors[currentStrategyBestPlant.seedId]"
                  :src="currentStrategyBestPlant.image"
                  class="h-10 w-10 object-contain"
                  loading="lazy"
                  @error="imageErrors[currentStrategyBestPlant.seedId] = true"
                >
                <span v-else class="i-carbon-sprout text-2xl text-gray-400" />
              </div>
              <div class="flex-1">
                <div class="text-gray-800 font-bold dark:text-gray-100">
                  {{ currentStrategyBestPlant.name }}
                  <span class="ml-1 text-xs text-gray-500">Lv{{ formatLv(currentStrategyBestPlant.level) }}</span>
                  <span class="ml-1 text-xs text-gray-400">{{ currentStrategyBestPlant.seasons }}季</span>
                </div>
                <div class="mt-1 flex flex-wrap gap-3 text-xs">
                  <span v-if="currentStrategyBestPlant.expPerHour" class="text-purple-600 dark:text-purple-400">经验/时: {{ currentStrategyBestPlant.expPerHour }}</span>
                  <span v-if="currentStrategyBestPlant.profitPerHour" class="text-amber-600 dark:text-amber-400">利润/时: {{ currentStrategyBestPlant.profitPerHour }}</span>
                  <span v-if="currentStrategyBestPlant.normalFertilizerExpPerHour" class="text-blue-600 dark:text-blue-400">普肥经验/时: {{ currentStrategyBestPlant.normalFertilizerExpPerHour }}</span>
                  <span v-if="currentStrategyBestPlant.normalFertilizerProfitPerHour" class="text-green-600 dark:text-green-400">普肥利润/时: {{ currentStrategyBestPlant.normalFertilizerProfitPerHour }}</span>
                </div>
              </div>
            </div>
            <div v-else class="mt-3 text-sm text-gray-400">
              暂无可种植作物
            </div>
          </div>
        </div>

        <div class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
          <div class="border-b border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-700/50">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="i-carbon-chart-line text-xl text-blue-500" />
                <div>
                  <h3 class="text-gray-700 font-semibold dark:text-gray-300">
                    策略对比
                  </h3>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    各策略下可种植的最优作物
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-sm text-gray-500">参考等级:</span>
                <NInputNumber
                  v-model:value="strategyLevel"
                  class="w-24"
                  :min="1"
                  :max="100"
                  :show-button="false"
                  size="small"
                />
              </div>
            </div>
          </div>

          <div class="p-4">
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div
                v-for="strategy in strategies"
                :key="strategy.key"
                class="overflow-hidden border cartoon-card rounded-2xl bg-white transition-shadow dark:bg-gray-800 hover:shadow-md"
                :class="[
                  getColorClass(strategy.color, 'border'),
                  currentStrategy === strategy.key ? 'ring-2 ring-blue-400 dark:ring-blue-500' : '',
                ]"
              >
                <div class="p-3">
                  <div class="mb-2 flex items-center gap-2">
                    <div
                      class="h-7 w-7 flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white"
                      :class="getColorClass(strategy.color, 'gradient')"
                    >
                      <div class="text-sm" :class="strategy.icon" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm font-semibold" :class="getColorClass(strategy.color, 'text')">
                        {{ strategy.label }}
                      </div>
                      <div v-if="currentStrategy === strategy.key" class="text-[10px] text-blue-500 font-medium dark:text-blue-400">
                        当前策略
                      </div>
                    </div>
                  </div>

                  <div v-if="getStrategyBestPlant(strategy.key)" class="space-y-2">
                    <div class="flex items-center gap-2">
                      <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border rounded-lg bg-gray-50 dark:border-gray-600 dark:bg-gray-700" :class="getColorClass(strategy.color, 'border')">
                        <img
                          v-if="getStrategyBestPlant(strategy.key)?.image && !imageErrors[getStrategyBestPlant(strategy.key)?.seedId]"
                          :src="getStrategyBestPlant(strategy.key)?.image"
                          class="h-8 w-8 object-contain"
                          loading="lazy"
                          @error="imageErrors[getStrategyBestPlant(strategy.key)?.seedId] = true"
                        >
                        <span v-else class="i-carbon-sprout text-lg text-gray-400" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm text-gray-800 font-medium dark:text-gray-200">
                          {{ getStrategyBestPlant(strategy.key)?.name }}
                        </div>
                        <div class="text-xs text-gray-500">
                          Lv{{ formatLv(getStrategyBestPlant(strategy.key)?.level) }}
                        </div>
                      </div>
                    </div>
                    <div class="rounded-md bg-gray-50 px-2 py-1.5 dark:bg-gray-900/50">
                      <div class="flex items-baseline justify-between">
                        <span class="text-xs text-gray-500">{{ strategy.unit }}/时</span>
                        <span class="text-base font-bold" :class="getColorClass(strategy.color, 'text')">
                          {{ getStrategyBestPlant(strategy.key)?.[strategy.metric] }}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div v-else class="py-3 text-center text-xs text-gray-400">
                    暂无可种植作物
                  </div>
                </div>
              </div>
            </div>

            <div class="mt-3 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span class="i-carbon-idea" />
              <span>可种植 {{ getStrategyAvailableCount() }}/{{ list.length }} 种作物 · 蓝色边框为当前设置的种植策略</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'blacklist'" class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
        <div class="border-b border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-700/50 sm:p-4">
          <div class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0 flex items-start gap-3 sm:items-center">
              <span class="i-carbon-user-x-ray text-xl text-red-500" />
              <div class="min-w-0">
                <h3 class="text-gray-700 font-semibold dark:text-gray-300">
                  偷菜黑名单
                </h3>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  加入黑名单的蔬菜在自动偷菜时会被跳过，但不会影响自己种植
                </p>
              </div>
            </div>
            <div class="w-full flex flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <NButton
                class="w-full sm:w-auto"
                type="warning"
                secondary
                :disabled="batchLoading || list.length === 0"
                :loading="batchLoading"
                @click="handleAddAllToBlacklist"
              >
                <span class="i-carbon-add" />
                一键全部加入黑名单
              </NButton>
              <NButton
                v-if="blacklist.length > 0"
                class="w-full sm:w-auto"
                type="error"
                secondary
                :disabled="batchLoading"
                @click="handleClearBlacklist"
              >
                <span class="i-carbon-trash-can" />
                清空黑名单
              </NButton>
            </div>
          </div>
        </div>

        <div class="p-4">
          <div v-if="blacklist.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            暂无黑名单蔬菜
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="seedId in blacklist"
              :key="seedId"
              class="flex flex-col items-stretch gap-3 rounded-lg bg-gray-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between dark:bg-gray-700/50 sm:px-4"
            >
              <div class="min-w-0 flex items-center gap-3">
                <div class="relative h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                  <img
                    v-if="list.find(i => i.seedId === seedId)?.image"
                    :src="list.find(i => i.seedId === seedId)?.image"
                    class="h-8 w-8 object-contain"
                    loading="lazy"
                  >
                  <span v-else class="i-carbon-sprout text-xl text-gray-400" />
                </div>
                <div class="min-w-0">
                  <div class="truncate text-sm text-gray-900 font-medium dark:text-white">
                    {{ getSeedNameById(seedId) }}
                  </div>
                  <div class="text-xs text-gray-400">
                    ID: {{ seedId }}
                  </div>
                </div>
              </div>
              <NButton
                class="w-full sm:w-auto"
                type="error"
                secondary
                size="small"
                @click="plantBlacklistStore.removeFromBlacklist(seedId)"
              >
                移出黑名单
              </NButton>
            </div>
          </div>
        </div>
      </div>

      <ConfigManage v-if="isConfigTab" :section="configSection" />
    </div>
  </div>
</template>
