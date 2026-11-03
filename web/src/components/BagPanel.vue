<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NDropdown } from 'naive-ui/es/dropdown'
import { NInputNumber } from 'naive-ui/es/input-number'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { usePetStore } from '@/stores/pet'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const bagStore = useBagStore()
const petStore = usePetStore()
const statusStore = useStatusStore()
const toastStore = useToastStore()

const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { items, loading: bagLoading, originalItems } = storeToRefs(bagStore)
const { snapshot: petSnapshot, activeDog, error: petError } = storeToRefs(petStore)
const { status, loading: statusLoading, error: statusError, realtimeConnected } = storeToRefs(statusStore)

const imageErrors = ref<Record<string, boolean>>({})

const CATEGORY_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '果实', value: 'fruit' },
  { label: '超变果实', value: 'mutant' },
  { label: '种子', value: 'seed' },
  { label: '道具', value: 'tool' },
] as const

const DOG_FOOD_DURATIONS = new Map<number, number>([
  [90004, 86400],
  [90005, 3 * 86400],
  [90006, 5 * 86400],
])

type CategoryValue = typeof CATEGORY_OPTIONS[number]['value']

const selectedCategory = ref<CategoryValue>('fruit')

const CATEGORY_SHORT_LABELS: Record<string, string> = {
  fruit: '果实',
  mutant: '超变',
  seed: '种子',
  tool: '道具',
}

type ItemActionKey = 'use' | 'sell' | 'view'

// 主操作排在第一位直接显示，其余收进“更多”菜单，底栏宽度不随操作数量变化。
function itemActions(item: any) {
  const actions: Array<{ key: ItemActionKey, label: string, title: string }> = []
  if (canUse(item))
    actions.push({ key: 'use', label: '使用', title: '选择使用数量' })
  if (canSell(item))
    actions.push({ key: 'sell', label: '出售', title: '出售全部' })
  if (canView(item))
    actions.push({ key: 'view', label: '赠送', title: '查看赠送信息' })
  return actions
}

function runItemAction(key: ItemActionKey, item: any) {
  if (key === 'use')
    handleUseClick(item)
  else if (key === 'sell')
    handleSellClick(item)
  else
    handleViewClick(item)
}

function formatItemCount(value: unknown) {
  const count = Number(value)
  return Number.isFinite(count) ? count.toLocaleString('zh-CN') : '0'
}

function useSuccessMessage(item: any, count: number, result: any) {
  const rewards = result?.rewards || []
  return [11, 33].includes(Number(item.itemType)) && rewards.length
    ? `获得：${rewards.map((reward: any) => `${reward.name} ×${formatItemCount(reward.count)}`).join('、')}`
    : `已使用 ${item.name || `物品${item.id}`} x${count}`
}

function getItemCategory(item: any): CategoryValue {
  const itemType = Number(item?.itemType || 0)
  if (itemType === 6)
    return 'fruit'
  if (itemType === 17)
    return 'mutant'
  if (itemType === 5)
    return 'seed'
  return 'tool'
}

const filteredItems = computed(() => {
  if (selectedCategory.value === 'all')
    return items.value
  return items.value.filter((item: any) => getItemCategory(item) === selectedCategory.value)
})

const categoryCounts = computed(() => {
  const counts: Record<CategoryValue, number> = { all: items.value.length, fruit: 0, mutant: 0, seed: 0, tool: 0 }
  for (const item of items.value) {
    const cat = getItemCategory(item)
    counts[cat]++
  }
  return counts
})

const confirmModal = ref({
  show: false,
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  loading: false,
  action: '' as 'sell' | 'use' | 'batchSell' | 'batchLock' | 'batchUnlock',
  item: null as any,
  useCount: 1,
  selectedItems: [] as any[],
})

const viewModal = ref({
  show: false,
  item: null as any,
})

function isDogFood(item: any) {
  return DOG_FOOD_DURATIONS.has(Number(item?.id || 0))
}

function isFertilizer(item: any) {
  const interactionType = String(item?.interactionType || '').trim().toLowerCase()
  return interactionType === 'fertilizer' || interactionType === 'fertilizerpro'
}

function dogFoodMaxUseCount(item: any) {
  const inventory = Math.max(0, Math.trunc(Number(item?.count || 0)))
  const duration = DOG_FOOD_DURATIONS.get(Number(item?.id || 0)) || 0
  if (!duration || !petSnapshot.value)
    return inventory
  const currentDuration = Math.max(0, Number(petSnapshot.value.protectDuration || 0))
  const maxDuration = Math.max(currentDuration, Number(petSnapshot.value.maxProtectDuration || 30 * 86400))
  return Math.max(0, Math.min(inventory, Math.floor((maxDuration - currentDuration) / duration)))
}

const maxUseCount = computed(() => {
  const item = confirmModal.value.item
  const count = isDogFood(item) ? dogFoodMaxUseCount(item) : Number(item?.count || 1)
  return Math.max(1, count)
})

function setUseCount(value: unknown) {
  const count = Math.trunc(Number(value) || 1)
  confirmModal.value.useCount = Math.max(1, Math.min(count, maxUseCount.value))
}

type BatchAction = 'sell' | 'lock' | 'unlock'

const batchAction = ref<BatchAction | null>(null)
const batchMode = computed(() => batchAction.value !== null)
const selectedForBatch = ref<Set<string>>(new Set())
const batchSellResult = ref<{ gold: number, goldBean: number } | null>(null)

const selectedBatchCount = computed(() => {
  return selectedForBatch.value.size
})

const lockModeAvailable = computed(() => ['fruit', 'mutant', 'seed'].includes(selectedCategory.value))
const sellModeAvailable = computed(() => ['all', 'fruit', 'mutant'].includes(selectedCategory.value))

const batchActionLabel = computed(() => {
  if (batchAction.value === 'sell')
    return '出售'
  if (batchAction.value === 'lock')
    return '锁定'
  return '解锁'
})

const confirmButtonText = computed(() => {
  if (confirmModal.value.action === 'sell' || confirmModal.value.action === 'batchSell')
    return '确认出售'
  if (confirmModal.value.action === 'batchLock')
    return '确认锁定'
  if (confirmModal.value.action === 'batchUnlock')
    return '确认解锁'
  if (confirmModal.value.action === 'use' && isDogFood(confirmModal.value.item))
    return '确认喂食'
  return '确认使用'
})

function mutantTypeLabel(item: any) {
  const names = Array.isArray(item?.mutantTypeNames) ? item.mutantTypeNames.map(String).filter(Boolean) : []
  if (names.length)
    return names.join(' + ')
  const effects = Array.isArray(item?.mutantEffects) ? item.mutantEffects.map((effect: any) => String(effect?.name || '')).filter(Boolean) : []
  if (effects.length)
    return effects.join(' + ')
  const ids = Array.isArray(item?.mutantTypes) ? item.mutantTypes : []
  return ids.join(' + ')
}

function getPriceClass(item: any) {
  const priceId = Number(item?.priceId || 0)
  if (priceId === 1005)
    return 'text-amber-400 dark:text-amber-300'
  if (priceId === 1002)
    return 'text-sky-400 dark:text-sky-300'
  return 'text-gray-400'
}

function canSell(item: any) {
  return item?.sellable === true && item?.locked !== true
}

function getSellStatusText(item: any) {
  if (item?.locked === true)
    return '已锁定'
  if (canSell(item))
    return '可出售'
  if (item?.sellStatus === 'conditional')
    return '条件出售'
  return '不可出售'
}

function canBatchSell(item: any) {
  return canSell(item) && Number(item.count || 0) > 0
}

function canUse(item: any) {
  const itemType = Number(item?.itemType || 0)
  return ([11, 33].includes(itemType) || isDogFood(item) || isFertilizer(item)) && item?.locked !== true
}

function isLockable(item: any) {
  return [17, 6, 5].includes(Number(item?.itemType || 0))
}

function canLock(item: any) {
  return isLockable(item) && item?.locked !== true
}

function canUnlock(item: any) {
  return isLockable(item) && item?.locked === true
}

// 批量模式下不可选的物品给出原因，避免用户以为“点了没反应”。
function batchIneligibleReason(item: any) {
  if (batchAction.value === 'sell')
    return getSellStatusText(item)
  if (batchAction.value === 'lock')
    return item?.locked === true ? '已锁定' : '不可锁定'
  if (batchAction.value === 'unlock')
    return item?.locked === true ? '不可解锁' : '未锁定'
  return ''
}

function isBatchEligible(item: any) {
  if (batchAction.value === 'sell')
    return canBatchSell(item)
  if (batchAction.value === 'lock')
    return canLock(item)
  if (batchAction.value === 'unlock')
    return canUnlock(item)
  return false
}

function canView(item: any) {
  return item?.viewable === true && !!item?.sourceInfo
}

function handleViewClick(item: any) {
  viewModal.value = { show: true, item }
}

function closeViewModal() {
  viewModal.value.show = false
}

function formatSentAt(value: unknown) {
  const timestamp = Number(value || 0)
  if (timestamp <= 0)
    return '未记录'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000))
}

function viewDescription(item: any) {
  const senderName = String(item?.sourceInfo?.senderName || '好友')
  const description = String(item?.description || '')
  return description ? description.replace('{0}', senderName) : `${senderName}赠送的鹊羽香囊`
}

function sachetMessage(messageTextId: unknown) {
  const id = Number(messageTextId || 0)
  return id > 0 ? `寄语编号 ${id}` : '未记录'
}

function itemKey(item: any) {
  return String(item?.key || item?.groupKey || item?.id || '')
}

function toggleBatchSelection(item: any) {
  if (!isBatchEligible(item))
    return
  const key = itemKey(item)
  if (selectedForBatch.value.has(key))
    selectedForBatch.value.delete(key)
  else
    selectedForBatch.value.add(key)
}

function handleSellClick(item: any) {
  if (batchMode.value) {
    toggleBatchSelection(item)
    return
  }
  const totalPrice = (Number(item.count) || 0) * (Number(item.price) || 0)
  const priceUnit = item.priceUnit || '金'
  const messages = [
    `确定要出售全部${item.name || `物品${item.id}`}吗?`,
    `数量：${item.count || 0}`,
  ]
  if (totalPrice > 0) {
    messages.push(`售出总金币：${totalPrice}${priceUnit}`)
  }
  confirmModal.value = {
    show: true,
    title: '确认出售',
    message: messages.join('\n'),
    type: 'danger',
    loading: false,
    action: 'sell',
    item,
    useCount: 1,
    selectedItems: [],
  }
}

async function handleUseClick(item: any) {
  if (isDogFood(item)) {
    const accountId = String(currentAccountId.value || '')
    const hasCurrentSnapshot = petStore.accountId === accountId && !!petSnapshot.value
    const loaded = hasCurrentSnapshot || await petStore.fetchPetInfo(accountId)
    if (!loaded || !petSnapshot.value) {
      toastStore.error(petError.value || '读取宠物看护时间失败')
      return
    }
    if (!activeDog.value) {
      toastStore.warning('请先在宠物页选择一只已获得的宠物上场')
      return
    }
    if (dogFoodMaxUseCount(item) <= 0) {
      toastStore.warning('当前看护时间已接近 30 天上限，无法再使用这份狗粮')
      return
    }
  }
  confirmModal.value = {
    show: true,
    title: `${isDogFood(item) ? '喂食' : '使用'}${item.name || `物品${item.id}`}`,
    message: '',
    type: 'primary',
    loading: false,
    action: 'use',
    item,
    useCount: 1,
    selectedItems: [],
  }
}

async function handleConfirm() {
  const { action, item, selectedItems, useCount } = confirmModal.value
  if (!currentAccountId.value)
    return

  confirmModal.value.loading = true
  try {
    if (action === 'sell' && item) {
      const sellItems = originalItems.value
        .filter((it: any) => itemKey(it) === itemKey(item))
        .map((it: any) => ({ id: it.id, count: it.count, uid: it.uid || 0 }))

      if (sellItems.length === 0) {
        toastStore.error('未找到可出售的物品')
        return
      }

      const res = await bagStore.sellItems(currentAccountId.value, sellItems)
      if (res.ok) {
        toastStore.success(`已出售 ${item.name || `物品${item.id}`}`)
        await loadBag()
      }
      else {
        toastStore.error(`出售失败: ${res.error || '未知错误'}`)
      }
    }
    else if (action === 'batchSell' && selectedItems) {
      const itemsToSell = selectedItems.map((it: any) => ({ id: it.id, count: it.count, uid: it.uid || 0 }))

      if (itemsToSell.length === 0) {
        toastStore.error('未找到可出售的物品')
        return
      }

      const res = await bagStore.sellItems(currentAccountId.value, itemsToSell)
      if (res.ok) {
        let totalGold = 0
        let totalGoldBean = 0
        for (const si of selectedItems) {
          const fi = filteredItems.value.find((f: any) => itemKey(f) === itemKey(si))
          if (fi) {
            const price = Number(fi.price) || 0
            const count = Number(si.count) || 0
            const priceId = Number(fi.priceId) || 0
            if (priceId === 1005) {
              totalGoldBean += price * count
            }
            else {
              totalGold += price * count
            }
          }
        }
        batchSellResult.value = { gold: totalGold, goldBean: totalGoldBean }
        toastStore.success(`已批量出售 ${selectedItems.length} 种物品，获得 ${totalGold} 金币, ${totalGoldBean} 金豆豆`)
        selectedForBatch.value.clear()
        batchAction.value = null
        await loadBag()
      }
      else {
        toastStore.error(`批量出售失败: ${res.error || '未知错误'}`)
      }
    }
    else if ((action === 'batchLock' || action === 'batchUnlock') && selectedItems) {
      const locked = action === 'batchLock'
      const itemUids = selectedItems
        .map((it: any) => Number(it.uid || 0))
        .filter((uid: number) => Number.isSafeInteger(uid) && uid > 0)
      if (itemUids.length === 0) {
        toastStore.error('未找到可操作的物品 UID')
        return
      }
      const res = await bagStore.setItemsLocked(currentAccountId.value, itemUids, locked)
      if (res.ok) {
        toastStore.success(`已${locked ? '锁定' : '解锁'} ${Number(res.data?.changed || itemUids.length)} 种物品`)
        selectedForBatch.value.clear()
        batchAction.value = null
        await loadBag()
      }
      else {
        toastStore.error(`${locked ? '锁定' : '解锁'}失败: ${res.error || '未知错误'}`)
      }
    }
    else if (action === 'use' && item) {
      const useLimit = isDogFood(item) ? dogFoodMaxUseCount(item) : Number(item.count || 1)
      if (useLimit <= 0) {
        toastStore.warning('当前看护时间已接近 30 天上限，无法再使用这份狗粮')
        return
      }
      const count = Math.max(1, Math.min(Math.trunc(Number(useCount) || 1), useLimit))
      if (isDogFood(item)) {
        const result = await petStore.useDogFood(currentAccountId.value, Number(item.id), count, Number(item.uid) || 0)
        if (result) {
          toastStore.success(`已喂食 ${item.name || `狗粮${item.id}`} x${count}，看护时间已增加`)
          await loadBag()
        }
        else {
          toastStore.error(`喂食失败: ${petError.value || '未知错误'}`)
        }
      }
      else {
        const res = await bagStore.useItem(currentAccountId.value, Number(item.id), count, Number(item.uid) || 0)
        if (res.ok) {
          toastStore.success(useSuccessMessage(item, count, res.data))
          await loadBag()
        }
        else {
          toastStore.error(`使用失败: ${res.error || '未知错误'}`)
        }
      }
    }
  }
  catch (e: any) {
    const message = getApiErrorMessage(e, '未知错误')
    toastStore.error(`操作失败: ${message}`)
  }
  finally {
    confirmModal.value.loading = false
    confirmModal.value.show = false
  }
}

function handleCancel() {
  confirmModal.value.show = false
}

function toggleBatchMode(action: BatchAction) {
  batchAction.value = batchAction.value === action ? null : action
  selectedForBatch.value.clear()
  batchSellResult.value = null
}

const batchEligibleCount = computed(() => filteredItems.value.filter((item: any) => isBatchEligible(item)).length)

function selectAllEligible() {
  selectedForBatch.value.clear()
  for (const item of filteredItems.value) {
    if (isBatchEligible(item)) {
      selectedForBatch.value.add(itemKey(item))
    }
  }
}

function handleBatchSellClick() {
  const sellableItems = filteredItems.value.filter((item: any) => canBatchSell(item))
  if (sellableItems.length === 0) {
    toastStore.warning('没有可批量出售的物品')
    return
  }
  const selectedList = Array.from(selectedForBatch.value)
  if (selectedList.length === 0) {
    toastStore.warning('请先选择要出售的物品')
    return
  }

  const itemsToSell = originalItems.value
    .filter((it: any) => selectedList.includes(itemKey(it)))

  let totalGold = 0
  let totalGoldBean = 0
  for (const it of itemsToSell) {
    const item = filteredItems.value.find((f: any) => itemKey(f) === itemKey(it))
    if (item) {
      const price = Number(item.price) || 0
      const count = Number(it.count) || 0
      const priceId = Number(item.priceId) || 0
      if (priceId === 1005) {
        totalGoldBean += price * count
      }
      else {
        totalGold += price * count
      }
    }
  }

  const messages = [
    `确定要批量出售选中的 ${selectedList.length} 种物品吗?`,
  ]
  if (totalGold > 0) {
    messages.push(`金币：${totalGold}`)
  }
  if (totalGoldBean > 0) {
    messages.push(`金豆豆：${totalGoldBean}`)
  }

  confirmModal.value = {
    show: true,
    title: '批量出售',
    message: messages.join('\n'),
    type: 'danger',
    loading: false,
    action: 'batchSell',
    item: null,
    useCount: 1,
    selectedItems: itemsToSell,
  }
}

function handleBatchLockClick(locked: boolean) {
  const selectedList = Array.from(selectedForBatch.value)
  if (selectedList.length === 0) {
    toastStore.warning(`请先选择要${locked ? '锁定' : '解锁'}的物品`)
    return
  }
  const selectedItems = filteredItems.value.filter((item: any) => (
    selectedList.includes(itemKey(item)) && (locked ? canLock(item) : canUnlock(item))
  ))
  if (selectedItems.length === 0) {
    toastStore.warning(`没有可${locked ? '锁定' : '解锁'}的物品`)
    return
  }
  confirmModal.value = {
    show: true,
    title: `批量${locked ? '锁定' : '解锁'}`,
    message: `确定要${locked ? '锁定' : '解锁'}选中的 ${selectedItems.length} 种物品吗?`,
    type: 'primary',
    loading: false,
    action: locked ? 'batchLock' : 'batchUnlock',
    item: null,
    useCount: 1,
    selectedItems,
  }
}

function handleBatchActionClick() {
  if (batchAction.value === 'sell')
    handleBatchSellClick()
  else if (batchAction.value === 'lock')
    handleBatchLockClick(true)
  else if (batchAction.value === 'unlock')
    handleBatchLockClick(false)
}

async function loadBag() {
  if (!currentAccountId.value)
    return

  const acc = currentAccount.value
  if (!acc)
    return

  if (!realtimeConnected.value)
    await statusStore.fetchStatus(currentAccountId.value)

  if (acc.running && status.value?.connection?.connected) {
    await bagStore.fetchBag(currentAccountId.value)
  }

  imageErrors.value = {}
}

onMounted(() => {
  loadBag()
})

watch(currentAccountId, () => {
  batchAction.value = null
  selectedForBatch.value.clear()
  loadBag()
})

watch(selectedCategory, () => {
  batchAction.value = null
  selectedForBatch.value.clear()
})

useIntervalFn(loadBag, 60000)
</script>

<template>
  <div class="personal-panel">
    <div class="flex shrink-0 items-center justify-between gap-3">
      <h2 class="flex items-center gap-2 text-lg font-bold">
        <span class="i-carbon-box" /> 背包
      </h2>
      <div class="flex items-center gap-2">
        <div v-if="items.length" class="text-sm text-gray-500">
          共 {{ items.length }} 种物品
        </div>
        <NButton
          circle
          quaternary
          size="small"
          title="刷新背包"
          :loading="bagLoading"
          :disabled="!currentAccountId || !status?.connection?.connected"
          @click="loadBag"
        >
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </div>

    <div v-if="bagLoading || statusLoading" class="flex justify-center py-12">
      <span class="i-carbon-circle-dash animate-spin text-4xl" />
    </div>

    <div v-else-if="!currentAccountId" class="farm-card rounded-xl p-8 text-center text-gray-500">
      请选择账号后查看背包
    </div>

    <div v-else-if="statusError" class="rounded-xl bg-red-50 p-8 text-center text-red-500 dark:bg-red-900/20" style="border: 2px solid rgba(239, 68, 68, 0.2)">
      <div class="mb-2 text-lg font-bold">
        获取数据失败
      </div>
      <div class="text-sm">
        {{ statusError }}
      </div>
    </div>

    <EmptyState v-else-if="!status?.connection?.connected" title="账号未运行" description="启动账号后读取背包物品" icon="i-carbon-connection-signal-off" />

    <div v-else class="personal-panel__card bag-panel-card farm-card rounded-2xl">
      <div v-if="items.length === 0" class="farm-card rounded-xl p-8 text-center text-gray-500">
        无可展示物品
      </div>

      <template v-else>
        <div class="bag-toolbar panel-sticky shrink-0">
          <div class="bag-categories custom-scrollbar" role="group" aria-label="背包分类">
            <NButton
              v-for="cat in CATEGORY_OPTIONS"
              :key="cat.value"
              :type="selectedCategory === cat.value ? 'primary' : 'default'"
              :secondary="selectedCategory !== cat.value"
              size="small"
              @click="selectedCategory = cat.value"
            >
              <span v-if="cat.value === 'fruit'" class="i-carbon-apple mr-1.5" />
              <span v-else-if="cat.value === 'mutant'" class="i-carbon-flash mr-1.5" />
              <span v-else-if="cat.value === 'seed'" class="i-carbon-tree mr-1.5" />
              <span v-else-if="cat.value === 'tool'" class="i-carbon-tool-box mr-1.5" />
              <span v-else class="i-carbon-list-boxes mr-1.5" />
              {{ cat.label }}
              <span class="ml-1 text-xs opacity-70">({{ categoryCounts[cat.value] || 0 }})</span>
            </NButton>
          </div>
          <div v-if="sellModeAvailable || lockModeAvailable" class="bag-actions flex flex-wrap items-center gap-2">
            <NButton
              v-if="sellModeAvailable"
              :type="batchAction === 'sell' ? 'warning' : 'default'"
              :secondary="batchAction !== 'sell'"
              size="small"
              @click="toggleBatchMode('sell')"
            >
              <span v-if="batchAction === 'sell'" class="i-carbon-close mr-1" />
              <span v-else class="i-carbon-shopping-cart-arrow-down mr-1" />
              {{ batchAction === 'sell' ? '取消出售' : '批量出售' }}
            </NButton>
            <NButton
              v-if="lockModeAvailable"
              :type="batchAction === 'lock' ? 'primary' : 'default'"
              :secondary="batchAction !== 'lock'"
              size="small"
              @click="toggleBatchMode('lock')"
            >
              <span v-if="batchAction === 'lock'" class="i-carbon-close mr-1" />
              <span v-else class="i-carbon-locked mr-1" />
              {{ batchAction === 'lock' ? '取消锁定' : '批量锁定' }}
            </NButton>
            <NButton
              v-if="lockModeAvailable"
              :type="batchAction === 'unlock' ? 'primary' : 'default'"
              :secondary="batchAction !== 'unlock'"
              size="small"
              @click="toggleBatchMode('unlock')"
            >
              <span v-if="batchAction === 'unlock'" class="i-carbon-close mr-1" />
              <span v-else class="i-carbon-unlocked mr-1" />
              {{ batchAction === 'unlock' ? '取消解锁' : '批量解锁' }}
            </NButton>
            <template v-if="batchMode">
              <span class="bag-batch-hint" role="status">
                <template v-if="batchEligibleCount">已选 <b>{{ selectedBatchCount }}</b> / 可选 {{ batchEligibleCount }}</template>
                <template v-else>当前分类没有可{{ batchActionLabel }}的物品</template>
              </span>
              <NButton type="primary" secondary size="small" :disabled="!batchEligibleCount" @click="selectAllEligible">
                <span class="i-carbon-checkmark-outline mr-1" />
                全选可{{ batchActionLabel }}项
              </NButton>
              <NButton
                :type="batchAction === 'sell' ? 'error' : 'primary'"
                size="small"
                :disabled="selectedBatchCount === 0"
                @click="handleBatchActionClick"
              >
                <span v-if="batchAction === 'sell'" class="i-carbon-shopping-cart-arrow-down mr-1" />
                <span v-else-if="batchAction === 'lock'" class="i-carbon-locked mr-1" />
                <span v-else class="i-carbon-unlocked mr-1" />
                {{ batchActionLabel }} ({{ selectedBatchCount }})
              </NButton>
            </template>
          </div>
        </div>

        <div :key="selectedCategory" class="personal-panel__scroll custom-scrollbar" role="region" aria-label="背包物品列表" tabindex="0">
          <EmptyState v-if="!filteredItems.length" bare title="这个分类暂无物品" icon="i-carbon-box" />
          <div v-else class="bag-grid">
            <article
              v-for="item in filteredItems"
              :key="itemKey(item)"
              class="bag-item farm-card"
              :class="batchMode ? {
                'bag-item--selectable': isBatchEligible(item),
                'bag-item--selected': selectedForBatch.has(itemKey(item)),
                'bag-item--disabled': !isBatchEligible(item),
              } : null"
              :role="batchMode && isBatchEligible(item) ? 'checkbox' : undefined"
              :aria-checked="batchMode && isBatchEligible(item) ? selectedForBatch.has(itemKey(item)) : undefined"
              @click="batchMode && toggleBatchSelection(item)"
            >
              <!-- 右上角只在批量模式下出现：可选项显示复选框，不可选项写明原因 -->
              <template v-if="batchMode">
                <span
                  v-if="isBatchEligible(item)"
                  class="bag-check bag-item__cue"
                  :class="{ 'is-checked': selectedForBatch.has(itemKey(item)) }"
                  aria-hidden="true"
                >
                  <span v-if="selectedForBatch.has(itemKey(item))" class="i-carbon-checkmark" />
                </span>
                <span v-else class="bag-ineligible bag-item__cue">{{ batchIneligibleReason(item) }}</span>
              </template>

              <!-- 数量以角标形式贴在图标右下角，与游戏背包的习惯一致 -->
              <div class="bag-item__thumb thumb-wrap" :data-fallback="(item.name || '物').slice(0, 1)">
                <img
                  v-if="item.image && !imageErrors[itemKey(item)]"
                  :src="item.image"
                  :alt="item.name"
                  loading="lazy"
                  @error="imageErrors[itemKey(item)] = true"
                >
                <span v-else class="bag-item__fallback">{{ (item.name || '物').slice(0, 1) }}</span>
                <span v-if="item.locked" class="bag-item__lock" title="已锁定"><span class="i-carbon-locked" /></span>
              </div>

              <strong class="bag-item__name" :title="item.name">{{ item.name || `物品${item.id}` }}</strong>

              <div class="bag-item__meta">
                <span class="bag-type" :class="`bag-type--${getItemCategory(item)}`">{{ CATEGORY_SHORT_LABELS[getItemCategory(item)] }}</span>
                <span v-if="item.level > 0">Lv{{ item.level }}</span>
                <span v-if="item.price > 0" :class="getPriceClass(item)" title="单价">{{ item.price }}{{ item.priceUnit || '金' }}</span>
                <span
                  v-if="item.sellStatus || item.locked"
                  :class="{ 'is-sellable': canSell(item), 'is-locked': item.locked }"
                  :title="item.sellCondition || ''"
                >{{ getSellStatusText(item) }}</span>
              </div>
              <div v-if="mutantTypeLabel(item)" class="bag-item__line" :title="`变异类型：${mutantTypeLabel(item)}`">
                变异 · {{ mutantTypeLabel(item) }}
              </div>
              <div class="bag-item__ids">
                #{{ item.id }}<template v-if="item.uid">
                  · UID {{ item.uid }}
                </template>
              </div>

              <!-- 每张卡都有底栏：左侧数量，右侧操作。卡片结构一致，因此等高；数量不再压在图标上。 -->
              <footer class="bag-item__foot">
                <span class="bag-item__qty" :class="{ 'is-hours': !!item.hoursText }" :title="item.hoursText ? `剩余 ${item.hoursText}` : `数量 ${formatItemCount(item.count)}`">
                  <template v-if="item.hoursText">{{ item.hoursText }}</template>
                  <template v-else><small>×</small>{{ formatItemCount(item.count) }}</template>
                </span>
                <span v-if="!batchMode && itemActions(item).length" class="bag-item__ops" @click.stop>
                  <NButton
                    size="tiny"
                    :type="itemActions(item)[0]!.key === 'use' ? 'primary' : 'default'"
                    secondary
                    :title="itemActions(item)[0]!.title"
                    @click="runItemAction(itemActions(item)[0]!.key, item)"
                  >
                    {{ itemActions(item)[0]!.label }}
                  </NButton>
                  <NDropdown
                    v-if="itemActions(item).length > 1"
                    trigger="click"
                    placement="bottom-end"
                    :options="itemActions(item).slice(1).map(action => ({ key: action.key, label: action.label }))"
                    @select="(key: ItemActionKey) => runItemAction(key, item)"
                  >
                    <NButton size="tiny" quaternary circle title="更多操作" aria-label="更多操作">
                      <template #icon>
                        <span class="i-carbon-overflow-menu-horizontal" />
                      </template>
                    </NButton>
                  </NDropdown>
                </span>
              </footer>
            </article>
          </div>
        </div>
      </template>
    </div>

    <ConfirmModal
      :show="confirmModal.show"
      :title="confirmModal.title"
      :message="confirmModal.message"
      :type="confirmModal.type"
      :loading="confirmModal.loading"
      :confirm-text="confirmButtonText"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    >
      <div v-if="confirmModal.action === 'use' && confirmModal.item" class="use-quantity-hint">
        <template v-if="isDogFood(confirmModal.item)">
          <span>受 30 天上限影响，本次最多可喂食</span>
          <strong>{{ maxUseCount }}</strong>
          <span>个</span>
        </template>
        <template v-else>
          <span>当前拥有</span>
          <strong>{{ maxUseCount }}</strong>
          <span>个，请选择本次使用数量</span>
        </template>
      </div>
      <div v-if="confirmModal.action === 'use' && confirmModal.item" class="use-quantity">
        <span>使用数量</span>
        <div class="use-stepper">
          <NInputNumber
            :value="confirmModal.useCount"
            :min="1"
            :max="maxUseCount"
            :disabled="confirmModal.loading"
            @update:value="value => setUseCount(value ?? 1)"
          />
          <NButton size="small" :disabled="confirmModal.loading || confirmModal.useCount >= maxUseCount" @click="setUseCount(maxUseCount)">
            全部
          </NButton>
        </div>
      </div>
    </ConfirmModal>

    <ConfirmModal
      :show="viewModal.show"
      title="香囊寄语"
      :message="viewDescription(viewModal.item)"
      confirm-text="关闭"
      is-alert
      @confirm="closeViewModal"
      @cancel="closeViewModal"
    >
      <div v-if="viewModal.item?.sourceInfo" class="sachet-detail">
        <div class="sachet-detail__row">
          <span>赠送人</span>
          <strong>{{ viewModal.item.sourceInfo.senderName || '未知好友' }}</strong>
        </div>
        <div class="sachet-detail__row">
          <span>赠送时间</span>
          <strong>{{ formatSentAt(viewModal.item.sourceInfo.sentAt) }}</strong>
        </div>
        <div class="sachet-detail__message">
          <span>好友寄语</span>
          <strong>{{ sachetMessage(viewModal.item.sourceInfo.messageTextId) }}</strong>
        </div>
      </div>
    </ConfirmModal>
  </div>
</template>

<style scoped>
.bag-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  grid-auto-rows: 1fr;
  gap: 14px;
}

/* 物品卡片：图标 + 数量角标为视觉焦点，其余信息依次减弱。 */
.bag-item {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px 12px 12px !important;
  text-align: center;
  transition:
    background-color 0.15s ease,
    opacity 0.15s ease;
}

.bag-item__cue {
  position: absolute;
  top: 8px;
  right: 8px;
}

.bag-item__thumb {
  position: relative;
  width: 72px;
  height: 72px;
  display: grid;
  margin-bottom: 8px;
  place-items: center;
  border-radius: 18px;
  background: var(--ui-surface-soft);
}

.bag-item__thumb img {
  max-width: 56px;
  max-height: 56px;
  object-fit: contain;
}

.bag-item__fallback {
  color: var(--ui-subtle);
  font-size: 24px;
  font-weight: var(--fw-700);
}

.bag-item__foot {
  display: flex;
  width: 100%;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px dashed var(--ui-border);
}

.bag-item__qty {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 16px;
  font-weight: var(--fw-700);
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.bag-item__qty small {
  margin-right: 1px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.bag-item__qty.is-hours {
  color: var(--ui-blue);
  font-size: 14px;
}

.bag-item__ops {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.bag-item__lock {
  position: absolute;
  top: -6px;
  left: -6px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: #fff;
  background: var(--ui-warning-fill);
  box-shadow: 0 0 0 2px var(--ui-surface-strong);
  font-size: 12px;
}

.bag-item__name {
  width: 100%;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bag-item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px 8px;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 18px;
}

.bag-item__meta .is-sellable {
  color: var(--ui-primary);
}

.bag-item__meta .is-locked {
  color: var(--ui-warning);
  font-weight: var(--fw-600);
}

.bag-type {
  padding: 0 6px;
  border-radius: 5px;
  font-weight: var(--fw-600);
}

.bag-type--fruit {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.bag-type--mutant {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.bag-type--seed {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.bag-type--tool {
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
}

.bag-item__line {
  max-width: 100%;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bag-item__ids {
  color: var(--ui-subtle);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

/* 触屏上分类条横向滑动即可，隐藏滚动条。 */
@media (hover: none) {
  .bag-categories {
    scrollbar-width: none;
  }

  .bag-categories::-webkit-scrollbar {
    display: none;
  }
}

@media (max-width: 520px) {
  .bag-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .bag-item__qty {
    font-size: 15px;
  }
}

.bag-panel-card {
  --bag-panel-pad: 16px;
  padding: var(--bag-panel-pad);
}

@media (min-width: 640px) {
  .bag-panel-card {
    --bag-panel-pad: 20px;
  }
}

.bag-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: calc(-1 * var(--bag-panel-pad)) calc(-1 * var(--bag-panel-pad)) 14px;
  padding: 12px var(--bag-panel-pad);
  border-radius: var(--ui-radius-card) var(--ui-radius-card) 0 0;
  background: var(--ui-table-head);
  box-shadow: 0 1px 0 var(--ui-border);
}

.bag-batch-hint {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.bag-batch-hint b {
  color: var(--ui-ink);
}

/* 批量选择：选中用 outline，避免被卡片的全局阴影覆盖。 */
.bag-item--selectable {
  cursor: pointer;
}

.bag-item--selectable:hover {
  outline: 1px solid color-mix(in srgb, var(--ui-primary) 45%, transparent);
}

.bag-item--selected,
.bag-item--selected:hover {
  outline: 2px solid var(--ui-primary);
  outline-offset: -1px;
  background: color-mix(in srgb, var(--ui-primary-soft) 70%, var(--ui-surface)) !important;
}

.bag-item--disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.bag-check {
  width: 20px;
  height: 20px;
  display: grid;
  margin: 2px;
  place-items: center;
  border: 1.5px solid var(--ui-border-strong);
  border-radius: 6px;
  color: #fff;
  background: var(--ui-surface-strong);
  font-size: 13px;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.bag-check.is-checked {
  border-color: var(--ui-primary);
  background: var(--ui-primary-fill);
}

.bag-ineligible {
  margin: 2px;
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 11px;
  line-height: 18px;
}

.bag-categories {
  min-width: 0;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

.bag-categories :deep(.n-button) {
  flex: none;
}

@media (max-width: 520px) {
  .bag-actions :deep(.n-button) {
    padding-inline: 6px;
  }
}

.thumb-wrap.fallback img {
  display: none;
}

.thumb-wrap.fallback::after {
  content: attr(data-fallback);
  font-size: 1.5rem;
  font-weight: var(--fw-700);
  color: #9ca3af;
  text-transform: uppercase;
}

.use-quantity {
  margin: 1rem 0 1.5rem;
  padding: 14px;
  border: 1px solid var(--n-border-color);
  border-radius: 8px;
  background: var(--n-color);
}

.use-quantity-hint {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
  margin: 0.9rem 0 0;
  color: var(--n-text-color-2);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}

.use-quantity-hint strong {
  color: var(--theme-primary, #438d63);
  font-size: 18px;
  line-height: 1;
}

.use-quantity > span {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: var(--fw-700);
}

.use-stepper {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.sachet-detail {
  display: grid;
  gap: 10px;
  margin: 0.75rem 0 1.25rem;
}

.sachet-detail__row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--n-border-color);
}

.sachet-detail__row span,
.sachet-detail__message span {
  color: var(--n-text-color-3);
  font-size: 12px;
  font-weight: var(--fw-700);
}

.sachet-detail__row strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.sachet-detail__message {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--theme-primary, #3b82f6) 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-primary, #3b82f6) 7%, var(--n-color));
}

.sachet-detail__message strong {
  color: var(--n-text-color);
  font-size: 15px;
  line-height: 1.55;
}
</style>
