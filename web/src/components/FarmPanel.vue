<script setup lang="ts">
import type { FertilizerType } from '@/stores/farm'
import type { FriendInteractionItemDto, FriendInteractionResultDto } from '@/stores/friend'
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { interactionItemTargetReason } from '@/utils/interaction-item-rules'

const farmStore = useFarmStore()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const route = useRoute()
const {
  lands,
  summary,
  socialEvents,
  career,
  loading,
  loaded,
  error,
  interactionItems,
  interactionItemsLoading,
  interactionItemsError,
  interactionUsePending,
  interactionUseError,
  fertilizePending,
  fertilizeError,
} = storeToRefs(farmStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { settings } = storeToRefs(settingStore)
const { status } = storeToRefs(statusStore)

const currentAccountConnected = computed(() => {
  const accountId = String(currentAccountId.value || '')
  return !!accountId
    && String(status.value?.accountId || '') === accountId
    && !!status.value?.connection?.connected
})
const currentAccountRunning = computed(() => (
  !!currentAccount.value?.running || currentAccountConnected.value
))

const operating = ref(false)
const fertilizingLandId = ref<number | null>(null)
const farmingLandId = ref<number | null>(null)
const manualRefreshing = ref(false)
const refreshIconClass = 'i-carbon-renew'
const confirmVisible = ref(false)
const confirmConfig = ref({
  title: '',
  message: '',
  opType: '',
})

const selectedInteractionItemId = ref('')
const selectedInteractionLandIds = ref<Record<string, string[]>>({})
const lastInteractionResults = ref<Record<string, FriendInteractionResultDto[]>>({})
const interactionConfirmVisible = ref(false)
const interactionConfirmMessage = ref('')

const selectedInteractionItem = computed<FriendInteractionItemDto | null>(() => (
  interactionItems.value.find(item => String(item.itemId) === selectedInteractionItemId.value) || null
))

const showManualFertilizerButtons = computed(() => settings.value.automation?.show_manual_fertilizer !== false)

const cleanableFarmSocialEvents = computed(() => (
  (Array.isArray(socialEvents.value) ? socialEvents.value : []).filter((event: any) => event?.cleanable)
))
const cleanableFarmSocialEventNames = computed(() => cleanableFarmSocialEvents.value
  .map((event: any) => String(event?.itemName || event?.itemId || '').trim())
  .filter(Boolean)
  .join('、'))

function isValidFarmingLand(land: any) {
  return !!land?.unlocked
    && !land?.occupiedByMaster
    && !!String(land?.plantName || '').trim()
    && !['locked', 'empty'].includes(String(land?.status || ''))
}

const socialCleanupLandId = computed(() => {
  if (cleanableFarmSocialEvents.value.length === 0)
    return 0
  return Number(lands.value.find(isValidFarmingLand)?.id) || 0
})

function isLandFarmingCandidate(land: any) {
  if (!isValidFarmingLand(land))
    return false
  return !!land?.needWater
    || !!land?.needWeed
    || !!land?.needBug
    || !!land?.needInteractionCleanup
    || Number(land?.id) === socialCleanupLandId.value
}

async function executeOperate() {
  if (!currentAccountId.value || !confirmConfig.value.opType)
    return
  confirmVisible.value = false
  operating.value = true
  try {
    await farmStore.operate(currentAccountId.value, confirmConfig.value.opType)
  }
  finally {
    operating.value = false
  }
}

function handleOperate(opType: string) {
  if (!currentAccountId.value)
    return

  const confirmMap: Record<string, string> = {
    harvest: '确定要收获所有成熟作物吗？',
    clear: '确定要一键务农吗？（除草、除虫、浇水并清理黄金虫、足球、乌云和青蛙）',
    plant: '确定要一键种植吗？(根据策略配置)',
    upgrade: '确定要升级所有可升级的土地吗？(消耗金币)',
    all: '确定要一键全收吗？(包含收获、除草、种植等)',
  }

  confirmConfig.value = {
    title: '确认操作',
    message: confirmMap[opType] || '确定执行此操作吗？',
    opType,
  }
  confirmVisible.value = true
}

const operations = [
  { type: 'harvest', label: '收获', icon: 'i-carbon-wheat', buttonType: 'info' },
  { type: 'clear', label: '一键务农', icon: 'i-carbon-clean', buttonType: 'success' },
  { type: 'plant', label: '种植', icon: 'i-carbon-sprout', buttonType: 'primary' },
  { type: 'upgrade', label: '升级土地', icon: 'i-carbon-upgrade', buttonType: 'warning' },
  { type: 'all', label: '一键全收', icon: 'i-carbon-flash', buttonType: 'primary' },
] as const

function interactionSelectionKey(itemId: unknown = selectedInteractionItemId.value) {
  return String(itemId || '')
}

function selectedInteractionIds(itemId: unknown = selectedInteractionItemId.value) {
  return selectedInteractionLandIds.value[interactionSelectionKey(itemId)] || []
}

function usedInteractionIdSet(itemId: unknown = selectedInteractionItemId.value) {
  if (!currentAccountId.value || !itemId)
    return new Set<string>()
  return new Set(farmStore.getInteractionUsedLandIds(currentAccountId.value, itemId))
}

function hasConfirmedInteractionEffect(land: any, itemId: unknown = selectedInteractionItemId.value) {
  const normalizedItemId = String(itemId || '')
  return !!normalizedItemId && (Array.isArray(land?.interactionEffects) ? land.interactionEffects : [])
    .some((effect: any) => effect?.confirmed && String(effect?.itemId || '') === normalizedItemId)
}

// 与好友页保持同一口径：只有仍在生长期的作物才允许提交道具使用。
function isInteractionLandCandidate(land: any) {
  return !!selectedInteractionItem.value
    && !interactionItemTargetReason(selectedInteractionItem.value.itemId, land)
}

function isInteractionLandSelected(land: any) {
  return selectedInteractionIds().includes(String(land?.id || ''))
}

function isInteractionLandDisabled(land: any) {
  const item = selectedInteractionItem.value
  return !item
    || item.count < 1
    || interactionUsePending.value
    || !isInteractionLandCandidate(land)
    || hasConfirmedInteractionEffect(land, item.itemId)
    || usedInteractionIdSet(item.itemId).has(String(land?.id || ''))
}

function interactionLandSelectionLabel(land: any) {
  const landId = String(land?.id || '')
  if (hasConfirmedInteractionEffect(land))
    return '已生效'
  if (usedInteractionIdSet().has(landId))
    return '本次已用'
  return selectedInteractionItem.value
    ? interactionItemTargetReason(selectedInteractionItem.value.itemId, land)
    : ''
}

function setSelectedInteractionIds(ids: string[], itemId: unknown = selectedInteractionItemId.value) {
  selectedInteractionLandIds.value = {
    ...selectedInteractionLandIds.value,
    [interactionSelectionKey(itemId)]: [...new Set(ids.map(String))].sort((left, right) => Number(left) - Number(right)),
  }
}

function toggleInteractionLand(land: any) {
  const item = selectedInteractionItem.value
  if (!item || isInteractionLandDisabled(land))
    return
  const landId = String(land?.id || '')
  const next = new Set(selectedInteractionIds(item.itemId))
  if (next.has(landId)) {
    next.delete(landId)
  }
  else {
    if (next.size >= item.count) {
      toast.info(`当前只有 ${item.count} 个${item.name}`)
      return
    }
    next.add(landId)
  }
  setSelectedInteractionIds([...next], item.itemId)
}

function selectAllInteractionLands() {
  const item = selectedInteractionItem.value
  if (!item)
    return
  const used = usedInteractionIdSet(item.itemId)
  const candidates = (lands.value || [])
    .filter(land => isInteractionLandCandidate(land) && !hasConfirmedInteractionEffect(land, item.itemId) && !used.has(String(land.id)))
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(0, item.count)
    .map(land => String(land.id))
  setSelectedInteractionIds(candidates, item.itemId)
}

function interactionFailures() {
  const results = lastInteractionResults.value[interactionSelectionKey()] || []
  return results.filter(result => !result.ok)
}

function isFertilizeCandidate(land: any) {
  return !!land?.unlocked
    && !land?.occupiedByMaster
    && String(land?.status || '') === 'growing'
    && Number(land?.matureInSec) > 0
}

function canOrganicFertilize(land: any) {
  const left = land?.leftInorcFertTimes
  return left == null || Number(left) > 0
}

function organicFertilizerLabel(land: any) {
  const left = land?.leftInorcFertTimes
  if (left != null && Number(left) <= 0)
    return '已无法再施有机肥'
  return ''
}

function formatFertilizerRemaining(sec: number) {
  const remaining = Number(sec) || 0
  if (remaining <= 0)
    return ''
  return `剩余 ${(remaining / 3600).toFixed(1)}h`
}

async function handleFertilize(land: any, fertilizerType: FertilizerType) {
  if (!currentAccountId.value || fertilizePending.value || !isFertilizeCandidate(land))
    return
  if (fertilizerType === 'organic' && !canOrganicFertilize(land)) {
    toast.info('该地块已无法再施有机肥')
    return
  }

  const typeName = fertilizerType === 'organic' ? '有机化肥' : '普通化肥'
  const landId = Number(land.id)
  fertilizingLandId.value = landId
  try {
    const result = await farmStore.fertilizeLand(currentAccountId.value, landId, fertilizerType)
    if (!result) {
      toast.error(fertilizeError.value || `${typeName}使用失败`)
      return
    }
    const remainingText = formatFertilizerRemaining(Number(result.fertilizerRemainingSec || 0))
    toast.success(remainingText ? `已施${typeName}，${remainingText}` : `已施${typeName}`)
  }
  finally {
    if (fertilizingLandId.value === landId)
      fertilizingLandId.value = null
  }
}

async function handleFarmLand(land: any) {
  if (!currentAccountId.value || farmingLandId.value !== null || operating.value || !isLandFarmingCandidate(land))
    return
  const landId = Number(land?.id) || 0
  if (!landId)
    return
  farmingLandId.value = landId
  try {
    const result = await farmStore.operate(currentAccountId.value, 'clear', landId)
    if (result?.hadWork)
      toast.success(`第 ${landId} 块土地务农完成`)
    else
      toast.info(`第 ${landId} 块土地当前无需务农`)
  }
  catch (cause: any) {
    toast.error(String(cause?.response?.data?.error || cause?.message || '单点务农失败'))
  }
  finally {
    if (farmingLandId.value === landId)
      farmingLandId.value = null
  }
}

function requestUseInteractionItem() {
  const item = selectedInteractionItem.value
  if (!currentAccountId.value || !item || selectedInteractionIds(item.itemId).length === 0)
    return
  const count = selectedInteractionIds(item.itemId).length
  const saleConditionWarning = item.saleConditionSatisfiedCount > 0
    ? `该道具库存中有 ${item.saleConditionSatisfiedCount} 个已满足游戏配置的出售条件，可能已过活动或有效期，`
    : ''
  interactionConfirmMessage.value = `${saleConditionWarning}将在自己农场的 ${count} 块土地上按编号依次使用“${item.name}”。若期间作物状态发生变化，部分地块可能使用失败；是否继续？`
  interactionConfirmVisible.value = true
}

async function executeUseInteractionItem() {
  const accountId = currentAccountId.value
  const item = selectedInteractionItem.value
  interactionConfirmVisible.value = false
  if (!accountId || !item)
    return
  const landIds = selectedInteractionIds(item.itemId)
  if (landIds.length === 0)
    return

  const result = await farmStore.useInteractionItemBatch(accountId, item.itemId, landIds)
  if (!result) {
    toast.error(interactionUseError.value || `${item.name}使用失败`)
    return
  }
  lastInteractionResults.value = {
    ...lastInteractionResults.value,
    [interactionSelectionKey(item.itemId)]: result.results || [],
  }
  const used = new Set(result.usedLandIds || [])
  setSelectedInteractionIds(landIds.filter(landId => !used.has(landId)), item.itemId)
  const successCount = Number(result.successCount || 0)
  const failureCount = Number(result.failureCount || 0)
  if (successCount > 0 && failureCount === 0)
    toast.success(result.message || `已按顺序使用 ${successCount} 个${item.name}`)
  else if (successCount > 0)
    toast.warning(result.message || `成功 ${successCount} 块，跳过 ${failureCount} 块`)
  else
    toast.warning(result.message || `所选地块当前均不可使用${item.name}`)
}

async function refreshFarmData() {
  const accountId = currentAccountId.value
  if (!accountId || !currentAccountRunning.value)
    return
  await Promise.all([
    farmStore.fetchLands(accountId),
    farmStore.fetchInteractionItems(accountId),
    settingStore.fetchSettings(accountId),
  ])
}

async function refreshFarm() {
  const accountId = currentAccountId.value
  if (!accountId || !currentAccountRunning.value)
    return

  manualRefreshing.value = true
  try {
    await Promise.all([
      farmStore.fetchLands(accountId),
      farmStore.fetchInteractionItems(accountId),
      settingStore.fetchSettings(accountId),
    ])
  }
  finally {
    if (currentAccountId.value === accountId)
      manualRefreshing.value = false
  }
}

watch(currentAccountId, () => {
  farmStore.resetLandState()
  fertilizingLandId.value = null
  farmingLandId.value = null
  selectedInteractionItemId.value = ''
  selectedInteractionLandIds.value = {}
  lastInteractionResults.value = {}
})

watch(interactionItems, (items) => {
  const first = items[0]
  if (!first) {
    selectedInteractionItemId.value = ''
    return
  }
  const requestedItemId = String(route.query.interactionItem || '')
  if (requestedItemId && items.some(item => String(item.itemId) === requestedItemId)) {
    selectedInteractionItemId.value = requestedItemId
    return
  }
  if (!items.some(item => String(item.itemId) === selectedInteractionItemId.value))
    selectedInteractionItemId.value = String(first.itemId)
})

watch([currentAccountId, () => currentAccount.value?.running, currentAccountConnected], () => {
  if (!currentAccountRunning.value) {
    farmStore.resetLandState()
    return
  }
  void refreshFarm()
}, { immediate: true })

const { pause, resume } = useIntervalFn(() => {
  for (const land of lands.value || []) {
    if (land.matureInSec > 0)
      land.matureInSec--
  }
}, 1000)

const { pause: pauseRefresh, resume: resumeRefresh } = useIntervalFn(refreshFarmData, 60000)

onMounted(() => {
  resume()
  resumeRefresh()
})

onUnmounted(() => {
  pause()
  pauseRefresh()
})
</script>

<template>
  <div class="space-y-5">
    <div class="cartoon-card farm-card rounded-2xl bg-white shadow-lg dark:bg-gray-800">
      <!-- Header with Title and Actions -->
      <div class="flex flex-col items-center justify-between gap-4 border-b border-gray-100 p-5 sm:flex-row dark:border-gray-700">
        <div class="w-full flex items-center justify-between gap-3 sm:w-auto">
          <h3 class="flex items-center gap-2 text-xl font-bold font-display">
            <span class="i-carbon-sprout text-green-600" /> 土地详情
          </h3>
          <NButton
            circle
            quaternary
            title="刷新土地"
            :loading="manualRefreshing"
            :disabled="!currentAccountId || !currentAccountRunning"
            @click="refreshFarm"
          >
            <span :class="refreshIconClass" />
          </NButton>
        </div>
        <div class="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
          <NButton
            v-for="op in operations"
            :key="op.type"
            :type="op.buttonType"
            :disabled="operating || farmingLandId !== null || !currentAccountRunning"
            @click="handleOperate(op.type)"
          >
            <span :class="op.icon" />
            {{ op.label }}
          </NButton>
        </div>
      </div>

      <!-- Summary -->
      <div class="flex flex-wrap gap-x-5 gap-y-2 border-b border-gray-100 px-5 py-3 text-sm dark:border-gray-700">
        <div class="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          <div class="i-carbon-clean" />
          <span class="font-body font-semibold">可收: {{ loaded && !error ? (summary?.harvestable || 0) : '--' }}</span>
        </div>
        <div class="flex items-center gap-1.5 text-green-700 dark:text-green-300">
          <div class="i-carbon-sprout" />
          <span class="font-body font-semibold">生长: {{ loaded && !error ? (summary?.growing || 0) : '--' }}</span>
        </div>
        <div class="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
          <div class="i-carbon-checkbox" />
          <span class="font-body font-semibold">空闲: {{ loaded && !error ? (summary?.empty || 0) : '--' }}</span>
        </div>
        <div class="flex items-center gap-1.5 text-red-700 dark:text-red-300">
          <div class="i-carbon-warning" />
          <span class="font-body font-semibold">枯萎: {{ loaded && !error ? (summary?.dead || 0) : '--' }}</span>
        </div>
        <CareerHarvestSteal v-if="loaded && !error" :career="career" />
      </div>

      <!-- Grid -->
      <div class="p-5">
        <div v-if="loading" class="flex justify-center py-12">
          <div class="i-svg-spinners-90-ring-with-bg text-4xl text-green-500" />
        </div>

        <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 farm-card rounded-2xl bg-white p-12 text-center text-gray-500 shadow-md dark:bg-gray-800">
          <div class="i-carbon-user-avatar text-5xl" />
          <div>
            <div class="text-lg text-gray-700 font-medium font-display dark:text-gray-300">
              未登录账号
            </div>
            <div class="font-body mt-1 text-sm text-gray-400">
              请先添加农场账号开始种田吧!
            </div>
          </div>
        </div>

        <div v-else-if="!currentAccountRunning" class="flex flex-col items-center justify-center gap-4 farm-card rounded-2xl bg-white p-12 text-center text-gray-500 shadow-md dark:bg-gray-800">
          <div class="i-carbon-network-4 text-5xl" />
          <div>
            <div class="text-lg text-gray-700 font-medium font-display dark:text-gray-300">
              账号未运行
            </div>
            <div class="font-body mt-1 text-sm text-gray-400">
              请先启动账号；启动后会立即读取土地
            </div>
          </div>
        </div>

        <div v-else-if="error" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-red-600 dark:text-red-300">
          <div class="i-carbon-warning-alt text-5xl" />
          <div class="max-w-xl text-sm">
            {{ error }}
          </div>
          <NButton secondary type="error" @click="refreshFarm">
            重新读取
          </NButton>
        </div>

        <div v-else-if="!loaded" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-gray-500">
          <div class="i-carbon-data-view-alt text-5xl" />
          <div class="text-lg font-display">
            尚未读取土地详情
          </div>
          <NButton secondary @click="refreshFarm">
            立即读取
          </NButton>
        </div>

        <div v-else-if="!lands || lands.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-gray-500">
          <div class="i-carbon-sprout text-5xl text-green-500" />
          <div class="text-lg font-display">
            当前没有可展示的土地
          </div>
          <div class="font-body text-sm text-gray-400">
            暂未读取到可展示的土地，可重新读取确认
          </div>
          <NButton secondary @click="refreshFarm">
            重新读取
          </NButton>
        </div>

        <div v-else>
          <div v-if="cleanableFarmSocialEvents.length > 0" class="mb-4 flex flex-wrap items-center justify-between gap-2 border border-emerald-200 rounded-xl bg-emerald-50/85 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
            <span class="flex items-center gap-2">
              <span class="i-carbon-pedestrian-child" />
              好友放置了 {{ cleanableFarmSocialEventNames }}，可一键务农或点击下方标记地块的“务农”清理。
            </span>
          </div>

          <div v-if="interactionItemsLoading || interactionItemsError || interactionItems.length > 0" class="mb-4 border border-amber-200 rounded-xl bg-amber-50/80 p-3 dark:border-amber-800 dark:bg-amber-950/25">
            <div v-if="interactionItemsLoading" class="flex items-center justify-center gap-2 py-2 text-sm text-amber-700 dark:text-amber-300">
              <span class="i-svg-spinners-90-ring-with-bg" />
              正在读取可用的互动道具
            </div>
            <div v-else-if="interactionItemsError" class="flex flex-wrap items-center justify-between gap-2 text-sm text-red-600 dark:text-red-300">
              <span>{{ interactionItemsError }}</span>
              <NButton size="small" secondary type="error" @click="currentAccountId && farmStore.fetchInteractionItems(currentAccountId)">
                重新读取
              </NButton>
            </div>
            <template v-else>
              <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div class="min-w-0 flex-1">
                  <div class="mb-2 flex items-center gap-2 text-sm text-amber-950 font-bold dark:text-amber-100">
                    <span class="i-carbon-game-console" />
                    可对自己农场使用的道具
                    <span class="text-xs text-amber-700 font-normal dark:text-amber-300">种草、黄金虫、足球等仅可放置到好友农场，清理由农场主完成</span>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="item in interactionItems"
                      :key="item.itemId"
                      type="button"
                      class="flex items-center gap-2 border rounded-lg bg-white px-2.5 py-2 text-left transition dark:bg-gray-900"
                      :class="selectedInteractionItemId === item.itemId
                        ? 'border-amber-500 ring-2 ring-amber-200 dark:ring-amber-800'
                        : 'border-amber-200 hover:border-amber-400 dark:border-amber-800'"
                      :aria-pressed="selectedInteractionItemId === item.itemId"
                      @click="selectedInteractionItemId = item.itemId"
                    >
                      <img :src="item.image" alt="" class="h-8 w-8 object-contain">
                      <span>
                        <span class="block text-sm text-gray-800 font-semibold dark:text-gray-100">{{ item.name }}</span>
                        <span class="block text-xs text-amber-700 dark:text-amber-300">库存 {{ item.count }}</span>
                      </span>
                    </button>
                  </div>
                  <div v-if="selectedInteractionItem" class="mt-2 text-xs text-amber-800 dark:text-amber-200">
                    {{ selectedInteractionItem.description || '选择土地后按编号依次使用。' }}
                    <div v-if="selectedInteractionItem.saleConditionSatisfiedCount > 0" class="mt-1 text-red-700 font-medium dark:text-red-300">
                      其中 {{ selectedInteractionItem.saleConditionSatisfiedCount }} 个已满足游戏配置中的出售条件，可能已过活动或有效期，使用时可能失败。
                    </div>
                    <div class="mt-1 text-gray-600 dark:text-gray-300">
                      仅可选择生长期作物。
                    </div>
                  </div>
                </div>
                <div class="flex shrink-0 flex-wrap gap-2 xl:max-w-72 xl:justify-end">
                  <NButton size="small" secondary :disabled="!selectedInteractionItem || interactionUsePending" @click="selectAllInteractionLands()">
                    全选可用
                  </NButton>
                  <NButton size="small" secondary :disabled="selectedInteractionIds().length === 0 || interactionUsePending" @click="setSelectedInteractionIds([])">
                    清空
                  </NButton>
                  <NButton type="warning" size="small" :loading="interactionUsePending" :disabled="!selectedInteractionItem || selectedInteractionIds().length === 0" @click="requestUseInteractionItem()">
                    按顺序使用 {{ selectedInteractionIds().length || '' }} 个
                  </NButton>
                </div>
              </div>
              <div v-if="interactionFailures().length > 0" class="mt-3 rounded-lg bg-white/75 px-3 py-2 text-xs text-red-700 dark:bg-gray-900/60 dark:text-red-300">
                <div class="mb-1 font-semibold">
                  未成功的地块
                </div>
                <div v-for="result in interactionFailures()" :key="`${result.landId}:${result.message}`">
                  第 {{ result.landId }} 块：{{ result.message }}
                </div>
              </div>
            </template>
          </div>

          <div class="grid grid-cols-2 gap-4 lg:grid-cols-6 md:grid-cols-4 sm:grid-cols-3">
            <LandCard
              v-for="land in lands"
              :key="land.id"
              :land="land"
              :selectable="!!selectedInteractionItem"
              :selected="isInteractionLandSelected(land)"
              :selection-disabled="isInteractionLandDisabled(land)"
              :selection-label="interactionLandSelectionLabel(land)"
              :show-fertilizer-actions="showManualFertilizerButtons && isFertilizeCandidate(land)"
              :fertilizer-pending="fertilizePending && fertilizingLandId === land.id"
              :normal-fertilizer-disabled="fertilizePending"
              :organic-fertilizer-disabled="fertilizePending || !canOrganicFertilize(land)"
              :organic-fertilizer-label="organicFertilizerLabel(land)"
              :show-farming-action="isLandFarmingCandidate(land)"
              :farming-pending="farmingLandId === land.id"
              :farming-disabled="farmingLandId !== null || operating"
              @select="toggleInteractionLand(land)"
              @fertilize="handleFertilize"
              @farm="handleFarmLand"
            />
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmConfig.title"
      :message="confirmConfig.message"
      @confirm="executeOperate"
      @cancel="confirmVisible = false"
    />

    <ConfirmModal
      :show="interactionConfirmVisible"
      title="确认使用互动道具"
      :message="interactionConfirmMessage"
      :loading="interactionUsePending"
      @confirm="executeUseInteractionItem"
      @cancel="interactionConfirmVisible = false"
    />
  </div>
</template>
