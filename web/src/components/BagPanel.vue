<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NInputNumber } from 'naive-ui/es/input-number'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
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

function getItemCategory(item: any): CategoryValue {
  const itemType = Number(item?.itemType || 0)
  if (itemType === 17)
    return 'fruit'
  if (itemType === 6)
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
  return (itemType === 11 || isDogFood(item)) && item?.locked !== true
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
          toastStore.success(`已使用 ${item.name || `物品${item.id}`} x${count}`)
          await loadBag()
        }
        else {
          toastStore.error(`使用失败: ${res.error || '未知错误'}`)
        }
      }
    }
  }
  catch (e: any) {
    toastStore.error(`操作失败: ${e.message || '未知错误'}`)
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
  <div class="page-stack space-y-4">
    <div class="mb-4 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-bold font-display">
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
          <span class="i-carbon-renew" />
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

    <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 farm-card rounded-xl p-12 text-center text-gray-500">
      <div class="i-carbon-network-4 text-4xl" style="opacity: 0.5" />
      <div>
        <div class="text-lg font-medium" style="color: var(--theme-text, #374151)">
          账号未登录
        </div>
        <div class="mt-1 text-sm text-gray-400">
          请先运行账号或检查网络连接
        </div>
      </div>
    </div>

    <div v-else>
      <div v-if="items.length === 0" class="farm-card rounded-xl p-8 text-center text-gray-500">
        无可展示物品
      </div>

      <template v-else>
        <div class="mb-4 flex flex-wrap items-center gap-2">
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

          <div class="flex-1" />

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
            <NButton type="primary" secondary size="small" @click="selectAllEligible">
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

        <div class="grid grid-cols-2 gap-4 lg:grid-cols-5 md:grid-cols-4 sm:grid-cols-3 xl:grid-cols-6">
          <div
            v-for="item in filteredItems"
            :key="itemKey(item)"
            class="group relative flex flex-col items-center farm-card rounded-xl p-3 transition"
            :class="{
              'ring-2 ring-orange-500 dark:ring-orange-400': batchMode && selectedForBatch.has(itemKey(item)),
              'cursor-pointer opacity-55': batchMode && isBatchEligible(item) && !selectedForBatch.has(itemKey(item)),
            }"
            @click="batchMode && toggleBatchSelection(item)"
          >
            <div class="absolute left-2 top-2 text-xs font-mono" style="color: var(--theme-text, #9ca3af); opacity: 0.5">
              #{{ item.id }}
            </div>

            <div class="absolute right-1 top-1 flex gap-1">
              <template v-if="!batchMode">
                <NButton
                  v-if="canView(item)"
                  type="info"
                  size="tiny"
                  circle
                  title="查看赠送信息"
                  @click.stop="handleViewClick(item)"
                >
                  <span class="i-carbon-view" />
                </NButton>
                <NButton
                  v-if="canSell(item)"
                  type="error"
                  size="tiny"
                  circle
                  title="出售全部"
                  @click.stop="handleSellClick(item)"
                >
                  <span class="i-carbon-shopping-cart-arrow-down" />
                </NButton>
                <NButton
                  v-if="canUse(item)"
                  type="success"
                  size="tiny"
                  circle
                  title="选择使用数量"
                  @click.stop="handleUseClick(item)"
                >
                  <span class="i-carbon-magic-wand-filled" />
                </NButton>
              </template>
              <div
                v-else-if="isBatchEligible(item)"
                class="h-5 w-5 flex items-center justify-center border-2 rounded-lg transition"
                :class="selectedForBatch.has(itemKey(item))
                  ? 'border-orange-500 bg-orange-500 text-white'
                  : 'border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-700'"
              >
                <span v-if="selectedForBatch.has(itemKey(item))" class="text-xs font-bold">✓</span>
              </div>
            </div>

            <div
              class="thumb-wrap mb-2 mt-6 h-16 w-16 flex items-center justify-center rounded-xl"
              :data-fallback="(item.name || '物').slice(0, 1)"
              style="background: color-mix(in srgb, var(--theme-bg, #fff) 90%, var(--theme-primary, #3b82f6))"
            >
              <img
                v-if="item.image && !imageErrors[itemKey(item)]"
                :src="item.image"
                :alt="item.name"
                class="max-h-full max-w-full object-contain"
                loading="lazy"
                @error="imageErrors[itemKey(item)] = true"
              >
              <div v-else class="text-2xl text-gray-400 font-bold uppercase">
                {{ (item.name || '物').slice(0, 1) }}
              </div>
            </div>

            <div class="mb-1 w-full truncate px-2 text-center text-sm font-bold" :title="item.name" style="color: var(--theme-text, #374151)">
              {{ item.name || `物品${item.id}` }}
            </div>

            <div class="mb-2 flex flex-col items-center gap-0.5 text-xs text-gray-400">
              <span v-if="item.locked" class="inline-flex items-center gap-1 text-amber-600 font-bold dark:text-amber-300">
                <span class="i-carbon-locked" /> 已锁定
              </span>
              <span v-if="item.uid">UID: {{ item.uid }}</span>
              <span v-if="mutantTypeLabel(item)">变异类型: {{ mutantTypeLabel(item) }}</span>
              <span>
                <span
                  class="inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold"
                  :class="getItemCategory(item) === 'fruit' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                    : getItemCategory(item) === 'mutant' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                      : getItemCategory(item) === 'seed' ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'"
                >
                  <span v-if="getItemCategory(item) === 'fruit'" class="i-carbon-apple" />
                  <span v-else-if="getItemCategory(item) === 'mutant'" class="i-carbon-flash" />
                  <span v-else-if="getItemCategory(item) === 'seed'" class="i-carbon-tree" />
                  <span v-else class="i-carbon-tool-box" />
                  {{ item.itemType || 0 }}
                </span>
                <span v-if="item.level > 0"> · Lv{{ item.level }}</span>
                <span v-if="item.price > 0" :class="getPriceClass(item)"> · {{ item.price }}{{ item.priceUnit || '金' }}</span>
              </span>
              <span
                v-if="item.sellStatus"
                :class="canSell(item) ? 'text-green-500 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'"
                :title="item.sellCondition || ''"
              >{{ getSellStatusText(item) }}</span>
            </div>

            <div class="mt-auto font-medium" :class="item.hoursText ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'">
              {{ item.hoursText || `x${item.count || 0}` }}
            </div>
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
.thumb-wrap.fallback img {
  display: none;
}

.thumb-wrap.fallback::after {
  content: attr(data-fallback);
  font-size: 1.5rem;
  font-weight: bold;
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
  font-weight: 700;
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
  font-weight: 700;
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
