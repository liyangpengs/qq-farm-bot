<script setup lang="ts">
import type { FertilizerType } from '@/stores/farm'
import type { FriendInteractionItemDto, FriendInteractionResultDto } from '@/stores/friend'
import { useIntervalFn, useResizeObserver } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NPopover } from 'naive-ui/es/popover'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/FarmLandCard.vue'
import LandDetailModal from '@/components/LandDetailModal.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
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
const detailLandId = ref<number | null>(null)
const detailLand = computed(() => lands.value.find(land => land.id === detailLandId.value) || null)
watch(currentAccountId, () => {
  detailLandId.value = null
})

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
const fertilizerConfirmVisible = ref(false)
const bulkFertilizerType = ref<FertilizerType>('normal')
const bulkFertilizerOptions = [{ label: '普通化肥', value: 'normal' }, { label: '有机化肥', value: 'organic' }]
const bulkFertilizerCount = computed(() => lands.value.filter(isFertilizeCandidate).length)
let fertilizerUiSequence = 0
watch(currentAccountId, () => {
  fertilizerUiSequence++
  fertilizerConfirmVisible.value = false
})
const farmingLandId = ref<number | null>(null)
const manualRefreshing = ref(false)
const confirmVisible = ref(false)
const confirmConfig = ref({
  title: '',
  message: '',
  opType: '',
})

const selectedInteractionItemId = ref<string>()
const lastInteractionResults = ref<Record<string, FriendInteractionResultDto[]>>({})
const interactionConfirmVisible = ref(false)
const interactionConfirmMessage = ref('')

// ---- 选择土地：勾选后批量施肥、务农或使用道具 ----
const selecting = ref(!!route.query.interactionItem)
const selectedIds = ref<string[]>([])
const batchPending = ref(false)
type BatchAction = FertilizerType | 'farming' | 'item'
const batchAction = ref<BatchAction>(route.query.interactionItem ? 'item' : 'normal')

const selectedInteractionItem = computed<FriendInteractionItemDto | null>(() => (
  interactionItems.value.find(item => String(item.itemId) === selectedInteractionItemId.value) || null
))

const interactionItemPlaceholder = computed(() => {
  if (interactionItemsLoading.value)
    return '正在读取道具…'
  if (interactionItemsError.value)
    return '道具读取失败'
  return interactionItems.value.length ? '选择道具' : '背包暂无可用道具'
})

const showManualFertilizerButtons = computed(() => settings.value.automation?.show_manual_fertilizer !== false)
const selectionBusy = computed(() => batchPending.value || fertilizePending.value || interactionUsePending.value || operating.value)
const selectionLimit = computed(() => batchAction.value === 'item' ? Math.max(0, Math.floor(Number(selectedInteractionItem.value?.count) || 0)) : Infinity)
const selectionOptions = computed<Array<{ value: BatchAction, label: string, icon: string }>>(() => [
  ...(showManualFertilizerButtons.value
    ? [
        { value: 'normal' as const, label: '普通肥', icon: 'i-carbon-chemistry' },
        { value: 'organic' as const, label: '有机肥', icon: 'i-carbon-sprout' },
      ]
    : []),
  { value: 'farming', label: '务农', icon: 'i-carbon-clean' },
  { value: 'item', label: '道具', icon: 'i-carbon-game-console' },
])

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
    clear: '确定要一键务农吗？',
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

// 只有“一键全收”是主操作，其余保持同一层级，避免一排按钮各用一种颜色。
const operations = [
  { type: 'harvest', label: '收获', icon: 'i-carbon-wheat', buttonType: 'default' },
  { type: 'clear', label: '一键务农', icon: 'i-carbon-clean', buttonType: 'default' },
  { type: 'plant', label: '种植', icon: 'i-carbon-sprout', buttonType: 'default' },
  { type: 'upgrade', label: '升级土地', icon: 'i-carbon-upgrade', buttonType: 'default' },
  { type: 'all', label: '一键全收', icon: 'i-carbon-flash', buttonType: 'primary' },
] as const

function interactionSelectionKey(itemId: unknown = selectedInteractionItemId.value) {
  return String(itemId || '')
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

/** 合种副地代表其主地：勾选、显示都落在主地上。 */
function rootIdOf(land: any) {
  const master = Number(land?.masterLandId) || 0
  return String(land?.occupiedByMaster && master > 0 ? master : land?.id || '')
}

function landByRootId(id: string) {
  return (lands.value || []).find(land => String(land.id) === id)
}

function canSelectLand(land: any) {
  const root = land?.occupiedByMaster ? landByRootId(rootIdOf(land)) : land
  if (!isValidFarmingLand(root))
    return false
  if (batchAction.value === 'normal')
    return isFertilizeCandidate(root)
  if (batchAction.value === 'organic')
    return isFertilizeCandidate(root) && canOrganicFertilize(root)
  if (batchAction.value === 'farming')
    return isLandFarmingCandidate(root)
  const item = selectedInteractionItem.value
  return !!item && item.count > 0 && !interactionItemTargetReason(item.itemId, root)
    && !hasConfirmedInteractionEffect(root, item.itemId) && !usedInteractionIdSet(item.itemId).has(String(root.id))
}

function selectReason(land: any) {
  if (canSelectLand(land))
    return ''
  if (!land?.unlocked)
    return '未解锁'
  if (!String(land?.plantName || '').trim())
    return '空地无需操作'
  const root = landByRootId(rootIdOf(land))
  if (!root)
    return '合种主地状态待同步'
  if (batchAction.value === 'normal' || batchAction.value === 'organic')
    return isFertilizeCandidate(root) ? '有机化肥次数已用完' : '当前作物无需施肥'
  if (batchAction.value === 'farming')
    return '当前无需务农'
  return selectedInteractionItem.value ? '当前作物不可使用此道具，或已经使用过' : '请先选择道具'
}

function isLandSelected(land: any) {
  return selectedIds.value.includes(rootIdOf(land))
}

function toggleLand(land: any) {
  if (!canSelectLand(land) || selectionBusy.value)
    return
  const id = rootIdOf(land)
  if (!selectedIds.value.includes(id) && selectedIds.value.length >= selectionLimit.value) {
    toast.info(`道具库存为 ${selectionLimit.value} 个，最多选择 ${selectionLimit.value} 株作物`)
    return
  }
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(item => item !== id)
    : [...selectedIds.value, id].sort((a, b) => Number(a) - Number(b))
}

function selectAllLands() {
  if (selectionBusy.value)
    return
  selectedIds.value = [...new Set((lands.value || []).filter(land => !land.occupiedByMaster && canSelectLand(land)).map(land => String(land.id)))]
    .sort((a, b) => Number(a) - Number(b))
    .slice(0, selectionLimit.value)
}

function exitSelecting() {
  if (selectionBusy.value)
    return
  selecting.value = false
  selectedIds.value = []
}

function enterSelecting() {
  if (selectionBusy.value)
    return
  selecting.value = true
}

function chooseBatchAction(action: BatchAction) {
  if (selectionBusy.value)
    return
  batchAction.value = action
}

const selectedLands = computed(() => selectedIds.value.map(landByRootId).filter(Boolean) as any[])
const normalTargets = computed(() => selectedLands.value.filter(isFertilizeCandidate))
const organicTargets = computed(() => normalTargets.value.filter(canOrganicFertilize))
const farmingTargets = computed(() => selectedLands.value.filter(isLandFarmingCandidate))
// 道具：只取所选土地中对当前道具有效、未使用过的，按编号取前“库存”个。
const itemTargets = computed(() => {
  const item = selectedInteractionItem.value
  if (!item || item.count < 1)
    return [] as any[]
  const used = usedInteractionIdSet(item.itemId)
  return selectedLands.value
    .filter(land => !interactionItemTargetReason(item.itemId, land) && !hasConfirmedInteractionEffect(land, item.itemId) && !used.has(String(land.id)))
    .slice(0, item.count)
})

const availableSelectionCount = computed(() => lands.value.filter(land => !land.occupiedByMaster && canSelectLand(land)).length)
const selectedPlotCount = computed(() => lands.value.filter(isLandSelected).length)
const activeTargets = computed(() => ({ normal: normalTargets.value, organic: organicTargets.value, farming: farmingTargets.value, item: itemTargets.value })[batchAction.value])
const applyLabel = computed(() => ({ normal: '施用普通化肥', organic: '施用有机化肥', farming: '开始务农', item: '使用道具' })[batchAction.value])

watch([lands, batchAction, selectedInteractionItem, selectionBusy, showManualFertilizerButtons], () => {
  if (selectionBusy.value)
    return
  if (!selectionOptions.value.some(option => option.value === batchAction.value))
    batchAction.value = selectionOptions.value[0]!.value
  selectedIds.value = selectedIds.value.filter(id => canSelectLand(landByRootId(id))).slice(0, selectionLimit.value)
}, { deep: true })

async function applySelection() {
  if (selectionBusy.value || !currentAccountConnected.value || !activeTargets.value.length)
    return
  if (batchAction.value === 'normal' || batchAction.value === 'organic')
    await fertilizeSelected(batchAction.value)
  else if (batchAction.value === 'farming')
    await farmSelected()
  else
    requestUseInteractionItem()
}

function selectedInteractionIds() {
  return itemTargets.value.map(land => String(land.id))
}

function interactionFailures() {
  const results = lastInteractionResults.value[interactionSelectionKey()] || []
  return results.filter(result => !result.ok)
}

const summaryItems = computed(() => [
  { key: 'harvestable', label: '可收', icon: 'i-carbon-wheat text-amber-600 dark:text-amber-400', value: Number(summary.value?.harvestable) || 0 },
  { key: 'growing', label: '生长', icon: 'i-carbon-sprout text-green-600 dark:text-green-400', value: Number(summary.value?.growing) || 0 },
  { key: 'empty', label: '空闲', icon: 'text-gray-500', path: 'M12 4 22 9 12 14 2 9 12 4ZM2 14l10 5 10-5', value: Number(summary.value?.empty) || 0 },
  { key: 'dead', label: '枯萎', icon: 'text-red-600 dark:text-red-400', path: 'M12 21V11c0-4-2-6-5-6M7 5c-3 0-4 2-4 5 3 0 5-1 5-4M12 15c0-3 2-5 5-5m0 0c3 0 4 2 4 5-3 0-5-1-5-4M8 21h8', value: Number(summary.value?.dead) || 0 },
])

// 列数取土地数量的因数，让每一行都排满：24 块地可排成 8×3、6×4、4×6 等。
// 在卡片宽度落在合适区间的因数里取最大的；没有合适的因数（比如质数块数）时按宽度自然换行。
const gridEl = ref<HTMLElement | null>(null)
const gridWidth = ref(0)
let gridResizeFrame = 0
useResizeObserver(gridEl, ([entry]) => {
  window.cancelAnimationFrame(gridResizeFrame)
  if (!entry || entry.contentRect.width === gridWidth.value)
    return
  // 列数会改变网格高度，放到下一帧更新，避免在尺寸观察回调中再次触发布局通知。
  gridResizeFrame = window.requestAnimationFrame(() => {
    gridWidth.value = entry.contentRect.width
    gridResizeFrame = 0
  })
})
const GRID_GAP = 12
const CARD_MIN = 128
const CARD_MAX = 230
const gridColumns = computed(() => {
  const width = gridWidth.value
  const count = (lands.value || []).length
  if (!width || !count)
    return 2
  const fits = (cols: number) => (width - GRID_GAP * (cols - 1)) / cols
  const maxCols = Math.max(1, Math.floor((width + GRID_GAP) / (CARD_MIN + GRID_GAP)))
  for (let cols = Math.min(maxCols, count); cols >= 2; cols--) {
    if (count % cols === 0 && fits(cols) <= CARD_MAX)
      return cols
  }
  return maxCols
})

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

function formatFertilizerRemaining(sec: number) {
  const remaining = Number(sec) || 0
  if (remaining <= 0)
    return ''
  return `剩余 ${(remaining / 3600).toFixed(1)}h`
}

async function fertilizeSelected(fertilizerType: FertilizerType) {
  const targets = fertilizerType === 'organic' ? organicTargets.value : normalTargets.value
  if (!currentAccountId.value || fertilizePending.value || batchPending.value || !targets.length)
    return
  const typeName = fertilizerType === 'organic' ? '有机化肥' : '普通化肥'
  const sequence = ++fertilizerUiSequence
  const result = await farmStore.fertilizeAll(currentAccountId.value, fertilizerType, targets.map(land => Number(land.id)))
  if (sequence !== fertilizerUiSequence)
    return
  if (!result) {
    toast.error(fertilizeError.value || `${typeName}使用失败，请刷新土地确认最新状态`)
    return
  }
  if (!result.successCount) {
    toast.info('所选土地当前都无需施肥')
    return
  }
  const skipped = result.skippedCount ? `，${result.skippedCount} 株未施肥` : ''
  const remaining = formatFertilizerRemaining(Number(result.fertilizerRemainingSec || 0))
  toast.success(`已为 ${result.successCount} 株作物施${typeName}${skipped}${remaining ? `，${remaining}` : ''}`)
}

async function handleFertilizeAll() {
  if (!currentAccountId.value || !currentAccountRunning.value || fertilizePending.value || operating.value)
    return
  if (!bulkFertilizerCount.value) {
    fertilizerConfirmVisible.value = false
    toast.info('当前没有可施肥的作物')
    return
  }
  const sequence = ++fertilizerUiSequence
  const result = await farmStore.fertilizeAll(currentAccountId.value, bulkFertilizerType.value)
  if (sequence !== fertilizerUiSequence)
    return
  fertilizerConfirmVisible.value = false
  if (!result) {
    toast.error(fertilizeError.value || '一键施肥失败，请刷新土地确认最新状态')
    return
  }
  if (!result.successCount) {
    toast.info('当前没有可施肥的作物')
    return
  }
  const skipped = result.skippedCount ? `，${result.skippedCount} 株未施肥` : ''
  const remaining = formatFertilizerRemaining(Number(result.fertilizerRemainingSec || 0))
  toast.success(`已为 ${result.successCount} 株作物施肥${skipped}${remaining ? `，${remaining}` : ''}`)
}

/** 逐块务农，前一块结束再处理下一块；任一失败不影响其余地块。 */
async function farmSelected() {
  const targets = farmingTargets.value.map(land => Number(land.id)).filter(Boolean)
  if (!currentAccountId.value || batchPending.value || operating.value || !targets.length)
    return
  const accountId = currentAccountId.value
  batchPending.value = true
  let done = 0
  let idle = 0
  let failed = 0
  try {
    for (const landId of targets) {
      farmingLandId.value = landId
      try {
        const result = await farmStore.operate(accountId, 'clear', landId)
        if (result?.hadWork)
          done++
        else
          idle++
      }
      catch {
        failed++
      }
      if (currentAccountId.value !== accountId)
        return
    }
  }
  finally {
    farmingLandId.value = null
    batchPending.value = false
  }
  const parts = [done && `${done} 块务农完成`, idle && `${idle} 块无需处理`, failed && `${failed} 块失败`].filter(Boolean).join('，')
  if (failed)
    toast.warning(parts)
  else
    toast.success(parts || '所选土地无需务农')
}

function requestUseInteractionItem() {
  const item = selectedInteractionItem.value
  if (!currentAccountId.value || !item || selectedInteractionIds().length === 0)
    return
  const count = selectedInteractionIds().length
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
  const landIds = selectedInteractionIds()
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
  const used = new Set((result.usedLandIds || []).map(String))
  selectedIds.value = selectedIds.value.filter(landId => !used.has(landId))
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
  farmingLandId.value = null
  selectedInteractionItemId.value = undefined
  selecting.value = false
  selectedIds.value = []
  lastInteractionResults.value = {}
})

watch(interactionItems, (items) => {
  const first = items[0]
  if (!first) {
    selectedInteractionItemId.value = undefined
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
  window.cancelAnimationFrame(gridResizeFrame)
  pause()
  pauseRefresh()
})
</script>

<template>
  <div class="personal-panel">
    <div class="personal-panel__card cartoon-card farm-card rounded-2xl bg-white shadow-lg dark:bg-gray-800 !p-0">
      <!-- Header with Title and Actions -->
      <div class="farm-head panel-sticky flex shrink-0 flex-col gap-3 border-b border-gray-100 p-4 lg:flex-row lg:items-center lg:justify-between dark:border-gray-700 sm:p-5" :class="{ 'is-selecting': selecting }">
        <div class="farm-heading flex items-center justify-between gap-3">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <span class="i-carbon-sprout text-green-600" /> 土地详情
          </h3>
          <div class="farm-mobile-actions">
            <NButton size="small" :type="selecting ? 'default' : 'primary'" :secondary="!selecting" :disabled="selectionBusy || !currentAccountRunning || !loaded || !!error" @click="selecting ? exitSelecting() : enterSelecting()">
              {{ selecting ? '退出选择' : '批量操作' }}
            </NButton>
            <NPopover v-if="!selecting" trigger="click" placement="bottom-end" :show-arrow="false">
              <template #trigger>
                <NButton size="small" circle quaternary title="土地概况与操作" aria-label="土地概况与操作">
                  <template #icon>
                    <span class="i-carbon-overflow-menu-horizontal" />
                  </template>
                </NButton>
              </template>
              <div class="w-60 space-y-3">
                <div class="grid grid-cols-2 gap-2 text-xs text-gray-500">
                  <span>可收 {{ loaded && !error ? (summary?.harvestable || 0) : '--' }}</span>
                  <span>生长 {{ loaded && !error ? (summary?.growing || 0) : '--' }}</span>
                  <span>空闲 {{ loaded && !error ? (summary?.empty || 0) : '--' }}</span>
                  <span>枯萎 {{ loaded && !error ? (summary?.dead || 0) : '--' }}</span>
                </div>
                <div v-if="loaded && !error && career" class="flex flex-col gap-2 border-t border-gray-100 pt-3 text-xs dark:border-gray-700">
                  <CareerHarvestSteal :career="career" compact />
                </div>
                <div class="grid grid-cols-2 gap-2 border-t border-gray-100 pt-3 dark:border-gray-700">
                  <NButton size="small" :disabled="operating || fertilizePending || farmingLandId !== null || !currentAccountRunning || !loaded || !!error || !lands.some(isFertilizeCandidate)" @click="fertilizerConfirmVisible = true">
                    一键施肥
                  </NButton>
                  <NButton v-for="op in operations" :key="op.type" size="small" :disabled="operating || fertilizePending || farmingLandId !== null || !currentAccountRunning" @click="handleOperate(op.type)">
                    {{ op.label }}
                  </NButton>
                </div>
              </div>
            </NPopover>
          </div>
          <NButton
            circle
            quaternary
            title="刷新土地"
            aria-label="刷新土地"
            :loading="manualRefreshing"
            :disabled="selectionBusy || !currentAccountId || !currentAccountRunning"
            @click="refreshFarm"
          >
            <template #icon>
              <span class="i-carbon-renew" />
            </template>
          </NButton>
        </div>
        <div class="farm-actions" :class="{ 'is-selecting': selecting }">
          <NButton :type="selecting ? 'default' : 'primary'" :secondary="!selecting" :disabled="selectionBusy || !currentAccountRunning || !loaded || !!error" @click="selecting ? exitSelecting() : enterSelecting()">
            <span class="i-carbon-checkbox-checked" />
            {{ selecting ? '退出选择' : '批量操作' }}
          </NButton>
          <NButton
            v-if="!selecting"
            :disabled="operating || fertilizePending || farmingLandId !== null || !currentAccountRunning || !loaded || !!error || !lands.some(isFertilizeCandidate)"
            @click="fertilizerConfirmVisible = true"
          >
            <span class="i-carbon-soil-moisture" />
            一键施肥
          </NButton>
          <NButton
            v-for="op in (selecting ? [] : operations)"
            :key="op.type"
            :type="op.buttonType"
            :disabled="operating || fertilizePending || farmingLandId !== null || !currentAccountRunning"
            @click="handleOperate(op.type)"
          >
            <span :class="op.icon" />
            {{ op.label }}
          </NButton>
        </div>
      </div>

      <!-- Summary：左侧是当前土地状态，右侧是生涯数据；颜色只留给图标 -->
      <div class="farm-summary shrink-0 border-b border-gray-100 px-4 py-3 dark:border-gray-700 sm:px-5">
        <div class="farm-summary__states">
          <span v-for="item in summaryItems" :key="item.key" class="farm-state" :class="{ 'is-zero': item.value === 0 }">
            <svg v-if="item.path" :class="item.icon" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path :d="item.path" />
            </svg>
            <span v-else :class="item.icon" aria-hidden="true" />
            {{ item.label }}<b>{{ loaded && !error ? item.value : '--' }}</b>
          </span>
        </div>
        <template v-if="loaded && !error && career">
          <div class="farm-summary__career">
            <CareerHarvestSteal :career="career" compact />
          </div>
          <NPopover trigger="click" placement="bottom-end" :show-arrow="false">
            <template #trigger>
              <button type="button" class="farm-summary__career-toggle" aria-label="查看生涯统计">
                <span class="i-carbon-chart-relationship" />生涯
              </button>
            </template>
            <div class="flex flex-col gap-2 text-sm">
              <CareerHarvestSteal :career="career" compact />
            </div>
          </NPopover>
        </template>
      </div>

      <!-- Grid -->
      <div class="personal-panel__card p-4 sm:p-5">
        <div v-if="loading || !currentAccountId || !currentAccountRunning || error || !loaded || !lands?.length" class="personal-panel__scroll custom-scrollbar" role="region" aria-label="土地状态" tabindex="0">
          <div v-if="loading" class="flex justify-center py-12">
            <div class="i-svg-spinners-90-ring-with-bg text-4xl text-green-500" />
          </div>

          <EmptyState v-else-if="!currentAccountId" bare title="请先选择账号" description="添加并选择账号后查看土地" icon="i-carbon-user-avatar" />

          <EmptyState v-else-if="!currentAccountRunning" bare title="账号未运行" description="启动账号后会立即读取土地" icon="i-carbon-connection-signal-off" />

          <EmptyState v-else-if="error" bare tone="error" title="土地读取失败" :description="error" icon="i-carbon-warning-alt">
            <NButton secondary @click="refreshFarm">
              重新读取
            </NButton>
          </EmptyState>

          <EmptyState v-else-if="!loaded" bare title="尚未读取土地" icon="i-carbon-data-view-alt">
            <NButton secondary @click="refreshFarm">
              立即读取
            </NButton>
          </EmptyState>

          <EmptyState v-else-if="!lands || lands.length === 0" bare title="没有可展示的土地" description="可重新读取确认" icon="i-carbon-sprout">
            <NButton secondary @click="refreshFarm">
              重新读取
            </NButton>
          </EmptyState>
        </div>

        <div v-else class="personal-panel__card">
          <div v-if="selecting" class="farm-selection-setup">
            <div class="farm-selection-row">
              <div class="farm-mode-switch" role="group" aria-label="批量操作类型">
                <button v-for="option in selectionOptions" :key="option.value" type="button" :aria-pressed="batchAction === option.value" :disabled="selectionBusy" @click="chooseBatchAction(option.value)">
                  <span :class="option.icon" aria-hidden="true" />{{ option.label }}
                </button>
              </div>
              <div class="farm-selectbar" role="toolbar" aria-label="所选土地操作">
                <div class="farm-selectbar__info" aria-live="polite">
                  <span>已选 <b>{{ selectedIds.length }}</b> 株<span v-if="selectedPlotCount > selectedIds.length" class="farm-selectbar__coverage"> · {{ selectedPlotCount }} 块地</span></span>
                  <span class="farm-selectbar__links">
                    <button type="button" :disabled="selectionBusy || !availableSelectionCount" @click="selectAllLands">全选</button>
                    <button type="button" :disabled="selectionBusy || !selectedIds.length" @click="selectedIds = []">清空</button>
                  </span>
                </div>
                <NButton type="primary" :disabled="selectionBusy || !currentAccountConnected || !activeTargets.length" :loading="selectionBusy" @click="applySelection">
                  {{ applyLabel }}<span v-if="activeTargets.length" class="farm-selectbar__total">{{ activeTargets.length }}{{ batchAction === 'item' ? '个' : '株' }}</span>
                </NButton>
              </div>
            </div>
            <div v-if="batchAction === 'item'" class="farm-item-picker">
              <BaseSelect
                v-model="selectedInteractionItemId"
                :options="interactionItems.map(item => ({ label: `${item.name}（库存 ${item.count}）`, value: String(item.itemId) }))"
                :disabled="selectionBusy || interactionItemsLoading || !interactionItems.length"
                :placeholder="interactionItemPlaceholder"
                aria-label="选择道具"
              />
              <span v-if="interactionItemsError" class="farm-item-error">{{ interactionItemsError }}<button type="button" @click="currentAccountId && farmStore.fetchInteractionItems(currentAccountId)">重试</button></span>
              <p v-else-if="selectedInteractionItem?.description">
                {{ selectedInteractionItem.description }}
              </p>
              <p v-if="selectedInteractionItem && selectedInteractionItem.saleConditionSatisfiedCount > 0" class="farm-item-error">
                部分道具可能已过活动或有效期，使用时可能失败。
              </p>
              <details v-if="interactionFailures().length" class="farm-item-error">
                <summary>{{ interactionFailures().length }} 块土地未成功使用</summary>
                <p v-for="result in interactionFailures()" :key="result.landId">
                  #{{ result.landId }}：{{ result.message }}
                </p>
              </details>
            </div>
          </div>

          <div class="personal-panel__scroll custom-scrollbar" role="region" aria-label="土地列表" tabindex="0">
            <div v-if="cleanableFarmSocialEvents.length > 0" class="mb-4 flex flex-wrap items-center justify-between gap-2 border border-emerald-200 rounded-xl bg-emerald-50/85 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
              <span class="flex items-center gap-2">
                <span class="i-carbon-pedestrian-child" />
                好友放置了 {{ cleanableFarmSocialEventNames }}，可一键务农，或选择土地后务农清理。
              </span>
            </div>
            <div ref="gridEl" class="farm-grid" :class="{ 'is-selecting': selecting }" :style="{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }">
              <LandCard
                v-for="land in lands"
                :key="land.id"
                :land="land"
                openable
                :selectable="selecting"
                :selected="isLandSelected(land)"
                :selection-disabled="!canSelectLand(land)"
                :selection-label="selectReason(land)"
                @open="detailLandId = $event.id"
                @select="toggleLand(land)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <LandDetailModal :land="detailLand" :player="status?.status" :connected="currentAccountConnected" @close="detailLandId = null" />

    <ConfirmModal
      :show="fertilizerConfirmVisible"
      title="一键施肥"
      message="将为所有生长中的作物施用一次所选化肥，确认施肥吗？"
      confirm-text="确认施肥"
      :loading="fertilizePending"
      @confirm="handleFertilizeAll"
      @cancel="fertilizerConfirmVisible = false"
    >
      <BaseSelect v-model="bulkFertilizerType" label="化肥类型" :options="bulkFertilizerOptions" :disabled="fertilizePending" />
      <p class="mt-3 text-sm text-gray-500">
        可施肥 {{ bulkFertilizerCount }} 株作物
      </p>
    </ConfirmModal>
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

<style scoped>
.farm-grid {
  display: grid;
  gap: 12px;
}

.farm-grid.is-selecting {
  padding-bottom: 8px;
}

.farm-selection-setup {
  display: grid;
  gap: 12px;
  margin-bottom: 12px;
}

.farm-selection-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.farm-mode-switch {
  display: grid;
  width: min(320px, 100%);
  min-width: 0;
  flex: 0 1 320px;
  grid-auto-columns: minmax(0, 1fr);
  grid-auto-flow: column;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.farm-mode-switch button {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 6px;
  border-radius: 9px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
}

.farm-mode-switch button[aria-pressed='true'] {
  color: var(--ui-primary);
  background: var(--ui-surface-strong);
  box-shadow: 0 1px 4px rgba(32, 58, 43, 0.08);
  font-weight: var(--fw-650);
}

.farm-mode-switch button:focus-visible,
.farm-selectbar__links button:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.farm-item-picker {
  display: grid;
  max-width: 420px;
  gap: 8px;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
}

.farm-item-picker :deep(.n-base-selection) {
  --n-placeholder-color: var(--ui-muted) !important;
  --n-placeholder-color-disabled: var(--ui-muted) !important;
}

.farm-item-picker p {
  margin: 0;
}

.farm-item-error {
  color: var(--ui-warning);
}

.farm-item-error button {
  margin-left: 8px;
  color: var(--ui-primary);
}

.farm-selectbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-left: auto;
}

.farm-selectbar__info {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-muted);
  font-size: 13px;
  white-space: nowrap;
}

.farm-selectbar__info b {
  color: var(--ui-ink);
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
}

.farm-selectbar__coverage {
  font-size: 12px;
}

.farm-selectbar__links {
  display: inline-flex;
  flex: none;
  gap: 14px;
}

.farm-selectbar__links button {
  color: var(--ui-primary);
  font-size: 12px;
}

.farm-mode-switch button:disabled,
.farm-selectbar__links button:disabled {
  color: var(--ui-subtle);
  cursor: not-allowed;
}

.farm-selectbar :deep(.n-button) {
  min-width: 150px;
  height: 36px;
  flex: none;
  border-radius: 10px;
}

.farm-selectbar__total {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.35);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1023px) {
  .farm-selection-row {
    display: block;
  }

  .farm-mode-switch {
    width: min(360px, 100%);
  }

  .farm-selectbar {
    position: fixed;
    z-index: 30;
    right: 12px;
    bottom: calc(88px + env(safe-area-inset-bottom));
    left: 12px;
    flex-direction: column;
    align-items: stretch;
    margin: 0;
    padding: 12px 14px;
    border: 1px solid var(--ui-border);
    border-radius: 14px;
    background: var(--ui-surface-strong);
    box-shadow: var(--ui-shadow-lg);
  }

  .farm-grid.is-selecting {
    padding-bottom: 110px;
  }
}

@media (max-width: 479px) {
  .farm-mode-switch {
    width: 100%;
  }

  .farm-mode-switch button > span {
    display: none;
  }
}

.farm-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  font-size: 13px;
}

.farm-summary__states {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.farm-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-variant-numeric: tabular-nums;
}

.farm-state b {
  margin-left: 2px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.farm-state.is-zero {
  opacity: 0.65;
}

.farm-summary__career {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.farm-summary__career-toggle {
  display: none;
  align-items: center;
  gap: 4px;
  color: var(--ui-muted);
}

@media (max-width: 639px) {
  .farm-summary__career {
    display: none;
  }

  .farm-summary__career-toggle {
    display: inline-flex;
  }
}

.farm-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.farm-mobile-actions {
  display: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

@media (max-width: 479px) {
  .farm-heading {
    gap: 6px;
  }

  .farm-heading h3 {
    flex: none;
    font-size: 16px;
    white-space: nowrap;
  }

  .farm-mobile-actions {
    display: flex;
  }

  .farm-actions,
  .farm-summary {
    display: none;
  }
}

.farm-actions :deep(.n-button) {
  width: 100%;
}

.farm-actions :deep(.n-button__content) {
  gap: 4px;
}

@media (min-width: 480px) {
  .farm-head.is-selecting {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .farm-actions.is-selecting {
    display: flex;
    justify-content: flex-end;
  }
}

@media (min-width: 640px) {
  .farm-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .farm-actions :deep(.n-button) {
    width: auto;
  }
}
</style>
