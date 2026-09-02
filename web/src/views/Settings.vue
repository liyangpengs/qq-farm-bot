<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { NTimePicker } from 'naive-ui/es/time-picker'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import AutomationSettingsForm from '@/components/settings/AutomationSettingsForm.vue'
import BagSeedPriorityItem from '@/components/settings/BagSeedPriorityItem.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { getPlatformClass, getPlatformLabel, useAccountStore } from '@/stores/account'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const route = useRoute()
const accountStore = useAccountStore()
const userStore = useUserStore()
const settingStore = useSettingStore()
const statusStore = useStatusStore()

type SettingsTab = 'account' | 'strategy' | 'automation' | 'system'
const storedTab = localStorage.getItem('settings-active-tab')
const settingsTabKeys: SettingsTab[] = ['account', 'strategy', 'automation', 'system']
const queryTab = String(route.query.tab || '')
const initialTab = settingsTabKeys.includes(queryTab as SettingsTab)
  ? queryTab as SettingsTab
  : storedTab === 'user' ? 'system' : (storedTab as SettingsTab) || 'account'
const activeTab = ref<SettingsTab>(initialTab)

watch(activeTab, (newTab) => {
  localStorage.setItem('settings-active-tab', newTab)
  if (String(route.query.tab || '') !== newTab) {
    router.replace({
      query: { ...route.query, tab: newTab },
    })
  }
})

watch(() => route.query.tab, (value) => {
  const nextTab = String(value || '')
  if (settingsTabKeys.includes(nextTab as SettingsTab) && nextTab !== activeTab.value)
    activeTab.value = nextTab as SettingsTab
})

const tabs = [
  { key: 'account', label: '账号管理', icon: 'i-carbon-user-profile' },
  { key: 'strategy', label: '策略设置', icon: 'i-carbon-settings-adjust' },
  { key: 'automation', label: '自动控制', icon: 'i-carbon-settings-adjust' },
  { key: 'system', label: '系统设置', icon: 'i-carbon-settings' },
] as const

function setActiveTab(value: string) {
  if (tabs.some(tab => tab.key === value))
    activeTab.value = value as typeof activeTab.value
}

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

// ==================== 账号管理 ====================
const { accounts, loading: accountsLoading, currentAccountId } = storeToRefs(accountStore)
const { status: runtimeStatus } = storeToRefs(statusStore)
const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}
const automationSaving = ref(false)

const showModal = ref(false)
const showDeleteConfirm = ref(false)
const deleteLoading = ref(false)
const editingAccount = ref<any>(null)
const accountToDelete = ref<any>(null)
const showClearStoppedConfirm = ref(false)
const clearStoppedLoading = ref(false)
const accountAvatarErrors = ref<Set<string>>(new Set())

function getAccountAvatar(account: any) {
  const accountId = String(account?.id || '')
  const liveAccountId = String(runtimeStatus.value?.accountId || '')
  const liveAvatar = accountId && accountId === liveAccountId
    ? String(runtimeStatus.value?.status?.avatarUrl || '').trim()
    : ''
  return liveAvatar || String(account?.avatar || '').trim()
}

function canShowAccountAvatar(account: any) {
  const accountId = String(account?.id || '')
  return !!getAccountAvatar(account) && !accountAvatarErrors.value.has(accountId)
}

function handleAccountAvatarError(account: any) {
  const accountId = String(account?.id || '')
  if (accountId)
    accountAvatarErrors.value.add(accountId)
}

const stoppedAccounts = computed(() => accounts.value.filter((acc: any) => !acc.running))
const stoppedAccountsCount = computed(() => stoppedAccounts.value.length)

onMounted(async () => {
  await accountStore.fetchAccounts()
  if (!currentAccountId.value && accounts.value.length > 0 && accounts.value[0]) {
    accountStore.selectAccount(String(accounts.value[0].id))
  }
  if (currentAccountId.value)
    await loadStrategyData(currentAccountId.value)
  await Promise.all([loadSystemConfig(), loadDevicePresets()])
})

function openSettings(account: any) {
  accountStore.selectAccount(account.id)
  router.push('/settings')
}

function openAddModal() {
  editingAccount.value = null
  showModal.value = true
}

function openEditModal(account: any) {
  editingAccount.value = { ...account }
  showModal.value = true
}

async function handleDelete(account: any) {
  accountToDelete.value = account
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (accountToDelete.value) {
    try {
      deleteLoading.value = true
      await accountStore.deleteAccount(accountToDelete.value.id)
      accountToDelete.value = null
      showDeleteConfirm.value = false
    }
    finally {
      deleteLoading.value = false
    }
  }
}

async function toggleAccount(account: any) {
  if (account.running) {
    await accountStore.stopAccount(account.id)
  }
  else {
    await accountStore.startAccount(account.id)
  }
}

function handleSaved() {
  accountStore.fetchAccounts()
}

function selectAccount(account: any) {
  if (!account || !account.id)
    return
  accountStore.selectAccount(String(account.id))
}

function openClearStoppedConfirm() {
  if (stoppedAccountsCount.value === 0) {
    showAlert('没有已停止的账号需要清理', 'primary')
    return
  }
  showClearStoppedConfirm.value = true
}

async function confirmClearStopped() {
  clearStoppedLoading.value = true
  try {
    const stoppedIds = stoppedAccounts.value.map((acc: any) => acc.id)
    let deletedCount = 0
    for (const id of stoppedIds) {
      try {
        await accountStore.deleteAccount(id)
        deletedCount++
      }
      catch (e) {
        console.error(`删除账号 ${id} 失败:`, e)
      }
    }
    showClearStoppedConfirm.value = false
    showAlert(`成功清理 ${deletedCount} 个已停止的账号`, 'primary')
    await accountStore.fetchAccounts()
  }
  finally {
    clearStoppedLoading.value = false
  }
}

// ==================== 策略设置 ====================
const { settings, loading: settingsLoading, loadedAccountId } = storeToRefs(settingStore)

interface SeedOptionItem {
  seedId: number
  name: string
  requiredLevel: number
  price: number
  locked?: boolean
  soldOut?: boolean
}

const seedOptions = ref<SeedOptionItem[]>([])
const seedOptionsRevision = ref(0)
const strategySaving = ref(false)
let strategyLoadRevision = 0
let seedOptionsRequestRevision = 0
let bagSeedsRequestRevision = 0
let seedOptionsRequestAccountId = ''
let seedOptionsLoadedAccountId = ''
let bagSeedsRequestAccountId = ''
let bagSeedsLoadedAccountId = ''
let bagSortRequestRevision = 0
let previewRequestRevision = 0

const currentAccountName = computed(() => {
  const acc = accounts.value.find((a: any) => a.id === currentAccountId.value)
  return acc ? (acc.name || acc.nick || acc.id) : null
})

const localStrategySettings = ref({
  plantingStrategy: 'max_exp',
  preferredSeedId: 0,
  bagSeedPriority: [] as number[],
  bagSeedLandTypes: {} as Record<string, string[]>,
  bagSeedFallbackStrategy: 'level',
  stealDelaySeconds: 0,
  plantOrderRandom: false,
  plantDelaySeconds: 0,
  intervals: { farmMin: 2, farmMax: 5, friendMin: 10, friendMax: 15 },
  friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
})

const plantingStrategyOptions = [
  { label: '优先种植种子', value: 'preferred' },
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '背包种子优先', value: 'bag_priority' },
]

const BAG_FALLBACK_STRATEGY_OPTIONS = [
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '优先种植种子', value: 'preferred' },
]

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
  image?: string
}

const bagSeeds = ref<BagSeedItem[]>([])
const bagSeedsLoading = ref(false)
const bagSeedsError = ref<string | null>(null)
const draggingBagSeedId = ref<number | null>(null)

const visibleBagSeedIds = computed(() => bagSeeds.value.map(seed => seed.seedId))

function normalizeVisibleBagSeedOrder(priority: number[] = localStrategySettings.value.bagSeedPriority) {
  const visibleIds = visibleBagSeedIds.value
  const visibleSet = new Set(visibleIds)
  const normalized: number[] = []
  for (const seedId of priority || []) {
    const id = Number(seedId)
    if (visibleSet.has(id) && !normalized.includes(id))
      normalized.push(id)
  }
  for (const seedId of visibleIds) {
    if (!normalized.includes(seedId))
      normalized.push(seedId)
  }
  return normalized
}

function mergeVisibleBagSeedOrder(visibleOrder: number[]) {
  const visibleIds = visibleBagSeedIds.value
  const visibleSet = new Set(visibleIds)
  const normalizedVisible = normalizeVisibleBagSeedOrder(visibleOrder)
  const existing = [...new Set((localStrategySettings.value.bagSeedPriority || [])
    .map(Number)
    .filter(id => Number.isFinite(id) && id > 0))]
  const merged: number[] = []
  let visibleIndex = 0

  for (const seedId of existing) {
    if (visibleSet.has(seedId)) {
      const replacement = normalizedVisible[visibleIndex++]
      if (replacement !== undefined && !merged.includes(replacement))
        merged.push(replacement)
    }
    else if (!merged.includes(seedId)) {
      // 暂时缺货的种子保留原有优先级位置，重新入库后仍按原顺序执行。
      merged.push(seedId)
    }
  }
  while (visibleIndex < normalizedVisible.length) {
    const seedId = normalizedVisible[visibleIndex++]!
    if (!merged.includes(seedId))
      merged.push(seedId)
  }
  return merged
}

const sortedBagSeeds = computed(() => {
  const itemMap = new Map(bagSeeds.value.map(seed => [seed.seedId, seed]))
  return normalizeVisibleBagSeedOrder()
    .map(seedId => itemMap.get(seedId))
    .filter((seed): seed is BagSeedItem => !!seed)
})

function setBagSeedLandTypes(seedId: number, types: string[]) {
  const next = { ...localStrategySettings.value.bagSeedLandTypes }
  // 按固定顺序收敛；不勾或勾满都等价于不限制，直接去掉该 seedId。
  const normalized = fertilizerLandTypeOptions
    .map(option => option.value)
    .filter(value => types.includes(value))
  if (normalized.length === 0 || normalized.length === fertilizerLandTypeOptions.length)
    delete next[String(seedId)]
  else
    next[String(seedId)] = normalized
  localStrategySettings.value.bagSeedLandTypes = next
}

// 设置页只列背包里现有的种子，缺货种子的限制仍保留，这里显式列出以免出现看不见的规则。
const orphanRestrictedSeeds = computed(() => {
  // 背包列表未加载时无法判断谁真的缺货，此时不显示，避免误清除已有限制。
  if (bagSeeds.value.length === 0)
    return []
  const visible = new Set(visibleBagSeedIds.value)
  return Object.entries(localStrategySettings.value.bagSeedLandTypes)
    .map(([seedId, types]) => ({ seedId: Number(seedId), types: types || [] }))
    .filter(item => item.seedId > 0 && item.types.length > 0 && !visible.has(item.seedId))
    .sort((a, b) => a.seedId - b.seedId)
    .map((item) => {
      const known = seedOptions.value.find(seed => seed.seedId === item.seedId)
      const labels = fertilizerLandTypeOptions
        .filter(option => item.types.includes(option.value))
        .map(option => option.label)
      return {
        seedId: item.seedId,
        name: known ? known.name : `种子 #${item.seedId}`,
        scope: `仅种 ${labels.join('、')}`,
      }
    })
})

function isAccountConnected(accountId: string) {
  return String(runtimeStatus.value?.accountId || '') === String(accountId)
    && runtimeStatus.value?.connection?.connected === true
}

async function fetchSeedOptions(accountId: string) {
  if (
    !accountId
    || !isAccountConnected(accountId)
    || seedOptionsRequestAccountId === accountId
    || seedOptionsLoadedAccountId === accountId
  ) {
    return
  }
  const requestRevision = ++seedOptionsRequestRevision
  seedOptionsRequestAccountId = accountId
  try {
    const { data } = await api.get('/api/seeds', {
      headers: { 'x-account-id': accountId },
      skipErrorToast: true,
    } as any)
    if (requestRevision !== seedOptionsRequestRevision || accountId !== currentAccountId.value)
      return
    seedOptions.value = data?.ok ? (data.data || []) : []
    seedOptionsRevision.value++
    if (accountId === currentAccountId.value)
      seedOptionsLoadedAccountId = accountId
  }
  catch {
    if (requestRevision === seedOptionsRequestRevision && accountId === currentAccountId.value) {
      seedOptions.value = []
      seedOptionsRevision.value++
      seedOptionsLoadedAccountId = accountId
    }
  }
  finally {
    if (seedOptionsRequestAccountId === accountId)
      seedOptionsRequestAccountId = ''
  }
}

async function fetchBagSeeds(accountId = currentAccountId.value) {
  if (
    !accountId
    || !isAccountConnected(accountId)
    || bagSeedsRequestAccountId === accountId
    || bagSeedsLoadedAccountId === accountId
  ) {
    return
  }
  const requestRevision = ++bagSeedsRequestRevision
  bagSeedsRequestAccountId = accountId
  bagSeedsLoading.value = true
  bagSeedsError.value = null
  try {
    const res = await api.get('/api/bag/seeds', {
      headers: { 'x-account-id': accountId },
      skipErrorToast: true,
    } as any)
    if (requestRevision !== bagSeedsRequestRevision || accountId !== currentAccountId.value)
      return
    if (res.data.ok) {
      bagSeeds.value = (res.data.data || []).filter((seed: BagSeedItem) => seed.plantSize >= 1)
    }
    if (accountId === currentAccountId.value)
      bagSeedsLoadedAccountId = accountId
  }
  catch (e: any) {
    if (requestRevision === bagSeedsRequestRevision && accountId === currentAccountId.value) {
      bagSeedsError.value = e.message || '加载失败'
      bagSeedsLoadedAccountId = accountId
    }
  }
  finally {
    if (requestRevision === bagSeedsRequestRevision && accountId === currentAccountId.value)
      bagSeedsLoading.value = false
    if (bagSeedsRequestAccountId === accountId)
      bagSeedsRequestAccountId = ''
  }
}

function materializeVisibleBagSeedOrder() {
  return normalizeVisibleBagSeedOrder()
}

function saveVisibleBagSeedOrder(visibleOrder: number[]) {
  bagSortRequestRevision++
  localStrategySettings.value.bagSeedPriority = mergeVisibleBagSeedOrder(visibleOrder)
}

function compareBagSeedsByLevel(a: BagSeedItem, b: BagSeedItem) {
  if (a.requiredLevel !== b.requiredLevel)
    return b.requiredLevel - a.requiredLevel
  return a.seedId - b.seedId
}

async function sortBagSeedsByFallbackStrategy(strategy: string, accountId = currentAccountId.value) {
  if (!accountId || accountId !== currentAccountId.value)
    return
  const requestRevision = ++bagSortRequestRevision
  const strategyAtRequest = strategy
  const items = [...bagSeeds.value]
  const ordered = [...items].sort(compareBagSeedsByLevel)

  if (strategyAtRequest === 'preferred') {
    const preferredSeedId = Number(localStrategySettings.value.preferredSeedId || 0)
    ordered.sort((a, b) => {
      const aPreferred = a.seedId === preferredSeedId ? 0 : 1
      const bPreferred = b.seedId === preferredSeedId ? 0 : 1
      return aPreferred - bPreferred || compareBagSeedsByLevel(a, b)
    })
  }
  else if (strategyAtRequest !== 'level') {
    const sortBy = analyticsSortByMap[strategyAtRequest]
    if (sortBy) {
      try {
        const { data } = await api.get('/api/analytics', {
          params: { sort: sortBy },
          headers: { 'x-account-id': accountId },
        })
        if (requestRevision !== bagSortRequestRevision || accountId !== currentAccountId.value || localStrategySettings.value.bagSeedFallbackStrategy !== strategyAtRequest)
          return
        const rankMap = new Map<number, number>()
        const rankings: any[] = data?.ok ? (data.data || []) : []
        rankings.forEach((item, index) => rankMap.set(Number(item.seedId), index))
        ordered.sort((a, b) => {
          const aRank = rankMap.get(a.seedId) ?? Number.MAX_SAFE_INTEGER
          const bRank = rankMap.get(b.seedId) ?? Number.MAX_SAFE_INTEGER
          return aRank - bRank || compareBagSeedsByLevel(a, b)
        })
      }
      catch {
        // 排名请求失败时保留稳定的等级/ID顺序。
      }
    }
  }

  if (requestRevision !== bagSortRequestRevision || accountId !== currentAccountId.value || localStrategySettings.value.bagSeedFallbackStrategy !== strategyAtRequest)
    return
  saveVisibleBagSeedOrder(ordered.map(seed => seed.seedId))
}

async function ensureBagSeedsForUserSort(accountId: string) {
  if (bagSeedsLoading.value || bagSeeds.value.length === 0)
    await fetchBagSeeds(accountId)
}

async function handleBagFallbackStrategyChange(value: string | number) {
  const accountId = currentAccountId.value
  const strategy = String(value)
  if (!accountId)
    return
  await ensureBagSeedsForUserSort(accountId)
  if (accountId === currentAccountId.value && localStrategySettings.value.bagSeedFallbackStrategy === strategy)
    await sortBagSeedsByFallbackStrategy(strategy, accountId)
}

async function handlePreferredSeedChange() {
  const accountId = currentAccountId.value
  if (!accountId || localStrategySettings.value.plantingStrategy !== 'bag_priority' || localStrategySettings.value.bagSeedFallbackStrategy !== 'preferred')
    return
  await ensureBagSeedsForUserSort(accountId)
  if (accountId === currentAccountId.value && localStrategySettings.value.bagSeedFallbackStrategy === 'preferred')
    await sortBagSeedsByFallbackStrategy('preferred', accountId)
}

async function resetBagSeedPriority() {
  const accountId = currentAccountId.value
  const strategy = localStrategySettings.value.bagSeedFallbackStrategy
  if (!accountId)
    return
  await ensureBagSeedsForUserSort(accountId)
  if (accountId === currentAccountId.value && localStrategySettings.value.bagSeedFallbackStrategy === strategy)
    await sortBagSeedsByFallbackStrategy(strategy, accountId)
}

function moveBagSeed(seedId: number, direction: -1 | 1) {
  const nextOrder = materializeVisibleBagSeedOrder()
  const index = nextOrder.indexOf(seedId)
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length)
    return

  const temp = nextOrder[index]!
  nextOrder[index] = nextOrder[targetIndex]!
  nextOrder[targetIndex] = temp
  saveVisibleBagSeedOrder(nextOrder)
}

function moveBagSeedUp(seedId: number) {
  moveBagSeed(seedId, -1)
}

function moveBagSeedDown(seedId: number) {
  moveBagSeed(seedId, 1)
}

function startBagSeedDrag(seedId: number, event: DragEvent) {
  materializeVisibleBagSeedOrder()
  draggingBagSeedId.value = seedId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(seedId))
  }
}

function endBagSeedDrag() {
  draggingBagSeedId.value = null
}

function dragOverBagSeed(_seedId: number, event: DragEvent) {
  if (draggingBagSeedId.value === null)
    return
  event.preventDefault()
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = 'move'
}

function dropBagSeed(seedId: number, event: DragEvent) {
  event.preventDefault()
  const sourceSeedId = draggingBagSeedId.value ?? Number(event.dataTransfer?.getData('text/plain') || '')
  if (!sourceSeedId || sourceSeedId === seedId) {
    endBagSeedDrag()
    return
  }

  const nextOrder = materializeVisibleBagSeedOrder()
  const sourceIndex = nextOrder.indexOf(sourceSeedId)
  const targetIndex = nextOrder.indexOf(seedId)
  if (sourceIndex < 0 || targetIndex < 0) {
    endBagSeedDrag()
    return
  }

  const [source] = nextOrder.splice(sourceIndex, 1)
  const newTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  nextOrder.splice(newTargetIndex, 0, source!)
  saveVisibleBagSeedOrder(nextOrder)
  endBagSeedDrag()
}

watch(() => [localStrategySettings.value.plantingStrategy, currentAccountId.value] as const, ([strategy, accountId], previous) => {
  if (
    strategy === 'bag_priority'
    && accountId
    && isAccountConnected(accountId)
    && (previous?.[0] !== strategy || previous?.[1] !== accountId)
  ) {
    fetchBagSeeds(accountId)
  }
}, { immediate: true })

const preferredSeedOptions = computed(() => {
  const options: { label: string, value: number, disabled?: boolean }[] = [{ label: '自动选择', value: 0, disabled: false }]
  options.push(...seedOptions.value.map(seed => ({
    label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
    value: seed.seedId,
    disabled: seed.locked || seed.soldOut,
  })))
  return options
})

const strategyPreviewLabel = ref<string | null>(null)

watch(() => [
  localStrategySettings.value.plantingStrategy,
  localStrategySettings.value.bagSeedFallbackStrategy,
  localStrategySettings.value.preferredSeedId,
  seedOptionsRevision.value,
  currentAccountId.value,
] as const, async ([plantingStrategy, fallbackStrategy, preferredSeedId, , accountId]) => {
  const currentSeeds = seedOptions.value
  const requestRevision = ++previewRequestRevision
  let strategy = plantingStrategy
  if (strategy === 'preferred') {
    strategyPreviewLabel.value = null
    return
  }
  if (strategy === 'bag_priority') {
    strategy = fallbackStrategy || 'level'
    if (strategy === 'preferred') {
      const seed = preferredSeedId > 0 ? currentSeeds.find(item => item.seedId === preferredSeedId) : undefined
      strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '未选择优先种子'
      return
    }
  }
  if (currentSeeds.length === 0) {
    strategyPreviewLabel.value = null
    return
  }
  const available = currentSeeds.filter(seed => !seed.locked && !seed.soldOut)
  if (available.length === 0) {
    strategyPreviewLabel.value = '暂无可用种子'
    return
  }
  if (strategy === 'level') {
    const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel || a.seedId - b.seedId)[0]
    strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
    return
  }
  const sortBy = analyticsSortByMap[strategy]
  if (!sortBy)
    return

  try {
    const { data } = await api.get('/api/analytics', {
      params: { sort: sortBy },
      headers: accountId ? { 'x-account-id': accountId } : undefined,
    })
    if (requestRevision !== previewRequestRevision || accountId !== currentAccountId.value)
      return
    const rankings: any[] = data?.ok ? (data.data || []) : []
    const availableIds = new Set(available.map(seed => seed.seedId))
    const match = rankings.find(item => availableIds.has(Number(item.seedId)))
    const seed = match ? available.find(item => item.seedId === Number(match.seedId)) : undefined
    strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '暂无匹配种子'
  }
  catch {
    if (requestRevision === previewRequestRevision && accountId === currentAccountId.value)
      strategyPreviewLabel.value = null
  }
}, { immediate: true })

function syncLocalStrategySettings() {
  if (settings.value) {
    localStrategySettings.value = JSON.parse(JSON.stringify({
      plantingStrategy: settings.value.plantingStrategy,
      preferredSeedId: settings.value.preferredSeedId,
      bagSeedPriority: settings.value.bagSeedPriority ?? [],
      bagSeedLandTypes: settings.value.bagSeedLandTypes ?? {},
      bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy ?? 'level',
      stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
      plantOrderRandom: !!settings.value.plantOrderRandom,
      plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
      intervals: settings.value.intervals,
      friendQuietHours: {
        enabled: false,
        start: '23:00',
        end: '07:00',
        continueFarm: true,
        ...(settings.value.friendQuietHours || {}),
      },
    }))
  }
}

async function loadStrategyData(accountId = currentAccountId.value) {
  if (!accountId)
    return
  const requestRevision = ++strategyLoadRevision
  const loaded = await settingStore.fetchSettings(accountId)
  if (!loaded || requestRevision !== strategyLoadRevision || accountId !== currentAccountId.value)
    return
  syncLocalStrategySettings()
  syncLocalAutomationSettings()
  syncLocalOfflineSettings()
  if (isAccountConnected(accountId))
    await fetchSeedOptions(accountId)
}

async function saveStrategySettings() {
  const accountId = currentAccountId.value
  if (!accountId)
    return
  strategySaving.value = true
  try {
    const payload = JSON.parse(JSON.stringify(localStrategySettings.value))
    if (payload.plantingStrategy === 'bag_priority') {
      bagSortRequestRevision++
      payload.bagSeedPriority = mergeVisibleBagSeedOrder(normalizeVisibleBagSeedOrder(payload.bagSeedPriority))
    }
    const res = await settingStore.saveSettings(accountId, payload)
    if (accountId !== currentAccountId.value)
      return
    if (res.ok) {
      syncLocalStrategySettings()
      showAlert('策略设置已保存', 'primary')
    }
    else {
      const message = res.unconfirmed && res.saved
        ? `策略已保存，但运行进程尚未确认应用：${res.error || '请稍后重试或重启账号'}`
        : `保存失败: ${res.error}`
      showAlert(message, res.unconfirmed && res.saved ? 'primary' : 'danger')
    }
  }
  finally {
    if (accountId === currentAccountId.value)
      strategySaving.value = false
  }
}

watch(currentAccountId, (accountId) => {
  strategySaving.value = false
  automationSaving.value = false
  draggingBagSeedId.value = null
  bagSeeds.value = []
  bagSeedsError.value = null
  seedOptions.value = []
  seedOptionsRequestAccountId = ''
  seedOptionsLoadedAccountId = ''
  bagSeedsRequestAccountId = ''
  bagSeedsLoadedAccountId = ''
  strategyPreviewLabel.value = null
  if (accountId)
    loadStrategyData(accountId)
})

watch(() => [
  runtimeStatus.value?.accountId,
  runtimeStatus.value?.connection?.connected,
  currentAccountId.value,
] as const, ([statusAccountId, connected, accountId]) => {
  if (!connected || !accountId || String(statusAccountId || '') !== String(accountId))
    return
  fetchSeedOptions(accountId)
  if (localStrategySettings.value.plantingStrategy === 'bag_priority')
    fetchBagSeeds(accountId)
})

// ==================== 自动控制 ====================
const allFertilizerLandTypes = ['purple-gold', 'gold', 'black', 'red', 'normal']

const fertilizerLandTypeOptions = [
  { label: '紫金土地', value: 'purple-gold' },
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

function normalizeFertilizerLandTypes(input: unknown) {
  const source = Array.isArray(input) ? input : allFertilizerLandTypes
  const normalized: string[] = []
  for (const item of source) {
    const value = String(item || '').trim().toLowerCase()
    if (!allFertilizerLandTypes.includes(value))
      continue
    if (normalized.includes(value))
      continue
    normalized.push(value)
  }
  return normalized
}

const localAutomationSettings = ref({
  automation: {
    farm: false,
    task: false,
    sell: true,
    friend: false,
    friend_auto_accept: true,
    farm_push: false,
    land_upgrade: true,
    friend_steal: false,
    friend_help: false,
    friend_bad: true,
    friend_help_exp_limit: false,
    friend_help_protect_dog_ignore_exp_limit: true,
    fertilizer_gift: false,
    fertilizer_buy_organic: false,
    fertilizer_buy_normal: false,
    mystery_shop_auto_buy: false,
    mystery_shop_allow_gold: true,
    mystery_shop_allow_coupon: false,
    mystery_shop_allow_gold_bean: false,
    mystery_shop_allow_diamond: false,
    mystery_shop_arrival_notify: false,
    mystery_shop_purchase_notify: false,
    fertilizer: 'normal',
    skip_own_weed_bug: false,
    fertilizer_multi_season: false,
    fertilizer_land_types: [...allFertilizerLandTypes],
    fertilizer_smart_seconds: 300,
    show_manual_fertilizer: true,
  },
  fertilizerBuyOrganicCount: 10,
  fertilizerBuyOrganicThresholdHours: 10,
  fertilizerBuyNormalCount: 10,
  fertilizerBuyNormalThresholdHours: 10,
  fertilizerBuyCheckIntervalMinutes: 30,
  autoAcceptFriendMinLevel: 0,
  autoAcceptRequireOwnLevel: false,
  autoAcceptHarvestStealEnabled: true,
  autoAcceptHarvestStealHarvest: 8,
  autoAcceptHarvestStealSteal: 1,
})

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '普通 + 快成熟有机', value: 'smart' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '不施肥', value: 'none' },
]

function syncLocalAutomationSettings() {
  if (settings.value) {
    if (!settings.value.automation) {
      localAutomationSettings.value.automation = {
        farm: false,
        task: false,
        sell: false,
        friend: false,
        friend_auto_accept: true,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        friend_help_protect_dog_ignore_exp_limit: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        fertilizer: 'none',
        skip_own_weed_bug: false,
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
        fertilizer_smart_seconds: 300,
        show_manual_fertilizer: true,
      }
    }
    else {
      const defaults = {
        farm: false,
        task: false,
        sell: false,
        friend: false,
        friend_auto_accept: true,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        friend_help_protect_dog_ignore_exp_limit: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        fertilizer: 'none',
        skip_own_weed_bug: false,
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
        fertilizer_smart_seconds: 300,
        show_manual_fertilizer: true,
      }
      localAutomationSettings.value.automation = {
        ...defaults,
        ...settings.value.automation,
      }
    }
    localAutomationSettings.value.automation.fertilizer_land_types = normalizeFertilizerLandTypes(localAutomationSettings.value.automation.fertilizer_land_types)
    if (localAutomationSettings.value.automation.fertilizer_smart_seconds === undefined) {
      localAutomationSettings.value.automation.fertilizer_smart_seconds = 300
    }
    if (localAutomationSettings.value.automation.show_manual_fertilizer === undefined) {
      localAutomationSettings.value.automation.show_manual_fertilizer = true
    }
    localAutomationSettings.value.fertilizerBuyOrganicCount = settings.value.fertilizerBuyOrganicCount ?? 10
    localAutomationSettings.value.fertilizerBuyOrganicThresholdHours = settings.value.fertilizerBuyOrganicThresholdHours ?? 10
    localAutomationSettings.value.fertilizerBuyNormalCount = settings.value.fertilizerBuyNormalCount ?? 10
    localAutomationSettings.value.fertilizerBuyNormalThresholdHours = settings.value.fertilizerBuyNormalThresholdHours ?? 10
    localAutomationSettings.value.fertilizerBuyCheckIntervalMinutes = settings.value.fertilizerBuyCheckIntervalMinutes ?? 30
    localAutomationSettings.value.autoAcceptFriendMinLevel = settings.value.autoAcceptFriendMinLevel ?? 0
    localAutomationSettings.value.autoAcceptRequireOwnLevel = settings.value.autoAcceptRequireOwnLevel ?? false
    localAutomationSettings.value.autoAcceptHarvestStealEnabled = settings.value.autoAcceptHarvestStealEnabled ?? true
    localAutomationSettings.value.autoAcceptHarvestStealHarvest = settings.value.autoAcceptHarvestStealHarvest ?? 8
    localAutomationSettings.value.autoAcceptHarvestStealSteal = settings.value.autoAcceptHarvestStealSteal ?? 1
  }
}

async function saveAutomationSettings() {
  const accountId = currentAccountId.value
  if (!accountId)
    return
  automationSaving.value = true
  try {
    const payload = JSON.parse(JSON.stringify(localAutomationSettings.value))
    payload.automation.fertilizer_land_types = normalizeFertilizerLandTypes(payload.automation.fertilizer_land_types)
    const res = await settingStore.saveSettings(accountId, payload)
    if (accountId !== currentAccountId.value)
      return
    if (res.ok) {
      syncLocalAutomationSettings()
      showAlert('自动控制设置已保存', 'primary')

      // 如果启用了自动购买化肥，立即检测并购买
      if (payload.automation.fertilizer_buy_organic || payload.automation.fertilizer_buy_normal) {
        try {
          const buyRes = await api.post('/api/fertilizer/check-and-buy', {
            buyOrganic: payload.automation.fertilizer_buy_organic,
            buyNormal: payload.automation.fertilizer_buy_normal,
            organicCount: payload.fertilizerBuyOrganicCount,
            organicThresholdHours: payload.fertilizerBuyOrganicThresholdHours,
            normalCount: payload.fertilizerBuyNormalCount,
            normalThresholdHours: payload.fertilizerBuyNormalThresholdHours,
          }, {
            headers: { 'x-account-id': accountId },
          })
          if (accountId === currentAccountId.value && buyRes.data?.ok) {
            const totalBought = (buyRes.data.organicBought || 0) + (buyRes.data.normalBought || 0)
            if (totalBought > 0)
              showAlert(`已自动购买 ${totalBought} 个化肥`, 'primary')
          }
        }
        catch (e) {
          console.error('检测购买化肥失败', e)
        }
      }
    }
    else {
      const message = res.unconfirmed && res.saved
        ? `自动控制已保存，但运行进程尚未确认应用：${res.error || '请稍后重试或重启账号'}`
        : `保存失败: ${res.error}`
      showAlert(message, res.unconfirmed && res.saved ? 'primary' : 'danger')
    }
  }
  finally {
    if (accountId === currentAccountId.value)
      automationSaving.value = false
  }
}

// ==================== 系统设置 ====================
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const offlineTesting = ref(false)

const passwordForm = ref({
  old: '',
  new: '',
  confirm: '',
})

const localOffline = ref({
  channel: 'webhook',
  endpoint: '',
  token: '',
  secret: '',
  title: '',
  msg: '',
  offlineDeleteSec: 0,
})

const channelOptions = [
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
  { label: 'MeoW', value: 'meow' },
]

const CHANNEL_DOCS: Record<string, string> = {
  webhook: '',
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/orgapp/customize-robot-security-settings',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
  meow: 'https://www.chuckfang.com/MeoW/api_doc.html',
}

const offlineChannel = computed(() => String(localOffline.value.channel || '').trim().toLowerCase())
const isDingTalkChannel = computed(() => offlineChannel.value === 'dingtalk')
const isMeowChannel = computed(() => offlineChannel.value === 'meow')
const offlineChannelUsesEndpoint = computed(() => offlineChannel.value === 'webhook' || isDingTalkChannel.value)
const offlineEndpointLabel = computed(() => isDingTalkChannel.value ? 'Webhook 地址' : '接口地址')
const offlineEndpointPlaceholder = computed(() => isDingTalkChannel.value
  ? '从钉钉群机器人设置页复制完整 Webhook'
  : '接收消息的接口地址')
const offlineTokenLabel = computed(() => isMeowChannel.value ? '昵称' : 'Token')
const offlineTokenPlaceholder = computed(() => isMeowChannel.value
  ? 'MeoW 注册昵称'
  : '接收端 token')
const currentChannelDocUrl = computed(() => CHANNEL_DOCS[offlineChannel.value] || '')

function openChannelDocs() {
  const url = currentChannelDocUrl.value
  if (!url)
    return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function syncLocalOfflineSettings() {
  if (settings.value?.offlineReminder) {
    const saved = JSON.parse(JSON.stringify(settings.value.offlineReminder))
    const next = {
      channel: 'webhook',
      endpoint: '',
      token: '',
      secret: '',
      title: '',
      msg: '',
      offlineDeleteSec: 0,
      ...saved,
    }

    if (String(next.channel || '').trim().toLowerCase() === 'dingtalk') {
      const legacyToken = String(next.token || '').trim()
      if (!String(next.endpoint || '').trim() && legacyToken) {
        next.endpoint = /^https?:\/\//i.test(legacyToken)
          ? legacyToken
          : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(legacyToken)}`
      }
      next.token = ''
    }

    localOffline.value = next
  }
}

function validateDingTalkWebhook(): string {
  if (!isDingTalkChannel.value)
    return ''

  const endpoint = String(localOffline.value.endpoint || '').trim()
  if (!endpoint)
    return '请填写钉钉机器人设置页提供的完整 Webhook 地址'

  try {
    const url = new URL(endpoint)
    const isOfficialWebhook = url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
      && url.pathname === '/robot/send'
      && !!url.searchParams.get('access_token')
    if (!isOfficialWebhook)
      return '钉钉 Webhook 地址格式不正确，请从群机器人设置页重新复制'
  }
  catch {
    return '钉钉 Webhook 地址格式不正确，请从群机器人设置页重新复制'
  }

  return ''
}

watch(settings, () => {
  syncLocalOfflineSettings()
}, { deep: true })

async function handleChangePassword() {
  if (!passwordForm.value.old || !passwordForm.value.new) {
    showAlert('请填写完整', 'danger')
    return
  }
  if (passwordForm.value.new !== passwordForm.value.confirm) {
    showAlert('两次密码输入不一致', 'danger')
    return
  }
  if (passwordForm.value.new.length < 6) {
    showAlert('密码长度至少6位', 'danger')
    return
  }

  passwordSaving.value = true
  try {
    const res = await userStore.changePassword(passwordForm.value.old, passwordForm.value.new)

    if (res.ok) {
      showAlert('密码修改成功，请重新登录', 'primary')
      passwordForm.value = { old: '', new: '', confirm: '' }
      setTimeout(() => {
        userStore.logout()
        window.location.href = '/login'
      }, 1500)
    }
    else {
      showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    passwordSaving.value = false
  }
}

async function handleSaveOffline() {
  const validationError = validateDingTalkWebhook()
  if (validationError) {
    showAlert(validationError, 'danger')
    return
  }

  offlineSaving.value = true
  try {
    const res = await settingStore.saveOfflineConfig(localOffline.value)

    if (res.ok) {
      showAlert('下线提醒设置已保存', 'primary')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    offlineSaving.value = false
  }
}

async function handleTestOffline() {
  const validationError = validateDingTalkWebhook()
  if (validationError) {
    showAlert(validationError, 'danger')
    return
  }

  offlineTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOffline.value)
    if (data?.ok) {
      showAlert('测试消息发送成功', 'primary')
    }
    else {
      showAlert(`测试失败: ${data?.error || '未知错误'}`, 'danger')
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    showAlert(`测试失败: ${msg}`, 'danger')
  }
  finally {
    offlineTesting.value = false
  }
}

const systemConfigSaving = ref(false)
const systemConfigLoading = ref(false)

const defaultDeviceInfo = {
  os: 'Windows',
  clientVersion: '',
  sysSoftware: 'Windows 10',
  network: 'wifi',
  memory: '16384',
  deviceId: 'DESKTOP-PC<WPC>',
  userAgent: '',
}

const localSystemConfig = ref({
  serverUrl: '',
  clientVersion: '',
  platform: 'qq',
  os: 'Windows',
  timeZone: 'Asia/Shanghai',
  deviceInfo: { ...defaultDeviceInfo },
})
const defaultSystemConfig = ref({
  serverUrl: '',
  clientVersion: '',
  platform: 'qq',
  os: 'Windows',
  timeZone: 'Asia/Shanghai',
  deviceInfo: { ...defaultDeviceInfo },
})
const devicePresets = ref<any[]>([])
const selectedPresetId = ref('')
const timeZoneOptions = ref([
  { label: '北京时间 / 上海（UTC+8）', value: 'Asia/Shanghai' },
])
const platformOptions = [
  { label: 'QQ', value: 'qq' },
  { label: '微信', value: 'wx' },
]
const osOptions = [
  { label: 'Windows', value: 'Windows' },
  { label: 'iOS', value: 'iOS' },
  { label: 'Android', value: 'Android' },
]

function normalizeSystemConfig(source: any, fallback: any) {
  return {
    serverUrl: source?.serverUrl || '',
    clientVersion: source?.clientVersion || '',
    platform: source?.platform || 'qq',
    os: source?.os || 'Windows',
    timeZone: source?.timeZone || fallback.timeZone || 'Asia/Shanghai',
    deviceInfo: source?.deviceInfo ? { ...fallback.deviceInfo, ...source.deviceInfo } : { ...fallback.deviceInfo },
  }
}

async function loadDevicePresets() {
  try {
    const { data } = await api.get('/api/settings/device-presets')
    if (data?.ok && Array.isArray(data.data))
      devicePresets.value = data.data
  }
  catch (e) {
    console.error('加载设备预设失败:', e)
  }
}

function applyDevicePreset(presetId: string) {
  const preset = devicePresets.value.find(item => item.id === presetId)
  if (!preset)
    return
  const deviceInfo = { ...defaultDeviceInfo, ...(preset.deviceInfo || {}) }
  localSystemConfig.value = {
    ...localSystemConfig.value,
    os: deviceInfo.os || 'Windows',
    clientVersion: deviceInfo.clientVersion || '',
    deviceInfo,
  }
  selectedPresetId.value = presetId
}

async function loadSystemConfig() {
  systemConfigLoading.value = true
  try {
    const { data } = await api.get('/api/settings/system-config')
    if (data?.ok) {
      if (Array.isArray(data.data.timeZones) && data.data.timeZones.length) {
        timeZoneOptions.value = data.data.timeZones.map((option: any) => ({
          label: String(option.label || option.value || ''),
          value: String(option.value || 'Asia/Shanghai'),
        }))
      }
      defaultSystemConfig.value = normalizeSystemConfig(data.data.default, defaultSystemConfig.value)
      localSystemConfig.value = normalizeSystemConfig(data.data.saved || data.data.default, defaultSystemConfig.value)
    }
  }
  catch (e) {
    console.error('加载系统配置失败:', e)
  }
  finally {
    systemConfigLoading.value = false
  }
}

async function handleSaveSystemConfig() {
  systemConfigSaving.value = true
  try {
    localSystemConfig.value.clientVersion = localSystemConfig.value.deviceInfo.clientVersion
    localSystemConfig.value.os = localSystemConfig.value.deviceInfo.os
    const { data } = await api.post('/api/settings/system-config', localSystemConfig.value)
    showAlert(data?.ok ? '系统配置已保存并立即生效' : data?.error || '保存失败', data?.ok ? 'primary' : 'danger')
  }
  catch (e: any) {
    showAlert(`保存失败: ${e.message || '未知错误'}`, 'danger')
  }
  finally {
    systemConfigSaving.value = false
  }
}

async function handleResetSystemConfig() {
  systemConfigSaving.value = true
  try {
    const { data } = await api.post('/api/settings/system-config/reset')
    if (data?.ok) {
      localSystemConfig.value = normalizeSystemConfig(data.data.saved, defaultSystemConfig.value)
      selectedPresetId.value = ''
      showAlert('系统配置已重置为默认值', 'primary')
    }
    else {
      showAlert(data?.error || '重置失败', 'danger')
    }
  }
  catch (e: any) {
    showAlert(`重置失败: ${e.message || '未知错误'}`, 'danger')
  }
  finally {
    systemConfigSaving.value = false
  }
}
</script>

<template>
  <div class="settings-page">
    <div class="mb-4">
      <h1 class="text-2xl text-gray-900 font-bold dark:text-gray-100">
        设置
      </h1>
    </div>

    <div class="border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
      <div class="border-b border-gray-200 px-4 pt-2 dark:border-gray-700">
        <NTabs :value="activeTab" type="line" @update:value="setActiveTab">
          <NTab v-for="tab in tabs" :key="tab.key" :name="tab.key">
            <span class="inline-flex items-center gap-2">
              <span :class="tab.icon" />
              {{ tab.label }}
            </span>
          </NTab>
        </NTabs>
      </div>

      <div class="p-4">
        <!-- 账号管理 -->
        <div v-if="activeTab === 'account'" class="space-y-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
              账号管理
            </h3>
            <div class="flex flex-wrap gap-2">
              <BaseButton
                variant="secondary"
                size="sm"
                :disabled="stoppedAccountsCount === 0"
                @click="openClearStoppedConfirm"
              >
                <span class="i-carbon-trash-can mr-2" />
                <span class="hidden sm:inline">一键清理</span>
                <span class="sm:hidden">清理</span>
                ({{ stoppedAccountsCount }})
              </BaseButton>
              <BaseButton
                variant="primary"
                size="sm"
                @click="openAddModal"
              >
                <span class="i-carbon-add mr-2" />
                添加账号
              </BaseButton>
            </div>
          </div>

          <div v-if="accountsLoading && accounts.length === 0" class="py-8 text-center text-gray-500">
            <span class="i-carbon-circle-dash mb-2 inline-block animate-spin text-2xl" />
            <div>加载中...</div>
          </div>

          <div v-else-if="accounts.length === 0" class="farm-card rounded-2xl bg-white py-12 text-center shadow-md dark:bg-gray-800">
            <div class="i-carbon-user-avatar mb-4 inline-block text-4xl text-gray-400" />
            <p class="mb-4 text-gray-500">
              暂无账号
            </p>
            <BaseButton
              variant="text"
              size="sm"
              @click="openAddModal"
            >
              立即添加
            </BaseButton>
          </div>

          <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2 xl:grid-cols-4">
            <div
              v-for="acc in accounts"
              :key="acc.id"
              class="cursor-pointer border cartoon-card rounded-2xl bg-white p-3 shadow-md transition-all duration-200 dark:bg-gray-800 sm:p-4"
              :class="String(currentAccountId) === String(acc.id)
                ? 'ring-2'
                : 'border-transparent'"
              :style="String(currentAccountId) === String(acc.id)
                ? { borderColor: 'var(--theme-primary)', backgroundColor: 'rgba(var(--theme-primary-rgb, 59, 130, 246), 0.1)' }
                : {}"
              @click="selectAccount(acc)"
            >
              <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div class="min-w-0 flex flex-1 items-center gap-3">
                  <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 sm:h-12 sm:w-12 dark:bg-gray-700">
                    <img
                      v-if="canShowAccountAvatar(acc)"
                      :src="getAccountAvatar(acc)"
                      class="h-full w-full object-cover"
                      @error="handleAccountAvatarError(acc)"
                    >
                    <span v-else class="i-carbon-user text-xl text-gray-400 sm:text-2xl" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <h4 class="truncate text-base font-bold sm:text-lg">
                      {{ acc.name || acc.nick || acc.id }}
                    </h4>
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span
                        v-if="acc.platform"
                        class="rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight"
                        :class="getPlatformClass(acc.platform)"
                      >
                        {{ getPlatformLabel(acc.platform) }}
                      </span>
                      <span class="truncate text-xs text-gray-500 sm:text-sm">
                        {{ acc.uin || '未绑定' }}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="flex items-center justify-end gap-2 sm:flex-col sm:items-end">
                  <span class="flex items-center gap-1 text-xs text-gray-500 sm:hidden">
                    <div class="h-2 w-2 rounded-full" :class="acc.running ? 'bg-green-500' : 'bg-gray-300'" />
                    {{ acc.running ? '运行中' : '已停止' }}
                  </span>
                  <BaseButton
                    variant="secondary"
                    size="sm"
                    class="border rounded-full shadow-sm transition-all duration-500 ease-in-out sm:w-20 active:scale-95"
                    :class="acc.running ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 focus:ring-red-500 active:border-red-300 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30 dark:focus:ring-red-500 dark:active:border-red-700' : 'border-green-200 bg-green-50 text-green-600 hover:bg-green-100 focus:ring-green-500 active:border-green-300 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/30 dark:focus:ring-green-500 dark:active:border-green-700'"
                    @click="toggleAccount(acc)"
                  >
                    <span class="mr-1" :class="acc.running ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'" />
                    {{ acc.running ? '停止' : '启动' }}
                  </BaseButton>
                </div>
              </div>

              <div class="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 sm:mt-4 dark:border-gray-700 sm:pt-4">
                <div class="hidden items-center gap-2 text-sm text-gray-500 sm:flex">
                  <span class="flex items-center gap-1">
                    <div class="h-2 w-2 rounded-full" :class="acc.running ? 'bg-green-500' : 'bg-gray-300'" />
                    {{ acc.running ? '运行中' : '已停止' }}
                  </span>
                </div>

                <div class="flex flex-1 justify-end gap-1 sm:flex-initial sm:gap-2">
                  <BaseButton
                    variant="ghost"
                    class="min-h-[36px] min-w-[36px] !p-2"
                    title="设置"
                    @click="openSettings(acc)"
                  >
                    <span class="i-carbon-settings" />
                  </BaseButton>
                  <BaseButton
                    variant="ghost"
                    class="min-h-[36px] min-w-[36px] !p-2"
                    title="编辑"
                    @click="openEditModal(acc)"
                  >
                    <span class="i-carbon-edit" />
                  </BaseButton>
                  <BaseButton
                    variant="ghost"
                    class="min-h-[36px] min-w-[36px] text-red-500 !p-2 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"
                    title="删除"
                    @click="handleDelete(acc)"
                  >
                    <span class="i-carbon-trash-can" />
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>

          <AccountModal
            :show="showModal"
            :edit-data="editingAccount"
            @close="showModal = false"
            @saved="handleSaved"
          />

          <ConfirmModal
            :show="showDeleteConfirm"
            :loading="deleteLoading"
            title="删除账号"
            :message="accountToDelete ? `确定要删除账号 ${accountToDelete.name || accountToDelete.id} 吗?` : ''"
            confirm-text="删除"
            type="danger"
            @close="!deleteLoading && (showDeleteConfirm = false)"
            @cancel="!deleteLoading && (showDeleteConfirm = false)"
            @confirm="confirmDelete"
          />

          <ConfirmModal
            :show="showClearStoppedConfirm"
            :loading="clearStoppedLoading"
            title="一键清理已停止账号"
            :message="`确定要清理 ${stoppedAccountsCount} 个已停止的账号吗？此操作不可恢复！`"
            confirm-text="确认清理"
            type="danger"
            @close="!clearStoppedLoading && (showClearStoppedConfirm = false)"
            @cancel="!clearStoppedLoading && (showClearStoppedConfirm = false)"
            @confirm="confirmClearStopped"
          />
        </div>

        <!-- 策略设置 -->
        <div v-else-if="activeTab === 'strategy'" class="space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="flex items-center gap-2 text-lg text-gray-900 font-bold dark:text-gray-100">
              <div class="i-fas-cog text-lg" />
              策略设置
              <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
                ({{ currentAccountName }})
              </span>
            </h3>
          </div>

          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId || loadedAccountId !== currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings mx-auto mb-2 text-3xl text-gray-400" />
            <p>{{ currentAccountId ? '账号设置加载失败，请切换账号或刷新页面重试' : '请先选择账号' }}</p>
          </div>

          <div v-else class="space-y-4">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseSelect
                v-model="localStrategySettings.plantingStrategy"
                label="种植策略"
                :options="plantingStrategyOptions"
              />
              <BaseSelect
                v-if="localStrategySettings.plantingStrategy === 'preferred'"
                v-model="localStrategySettings.preferredSeedId"
                label="优先种植种子"
                :options="preferredSeedOptions"
              />
              <BaseSelect
                v-else-if="localStrategySettings.plantingStrategy === 'bag_priority' && localStrategySettings.bagSeedFallbackStrategy === 'preferred'"
                v-model="localStrategySettings.preferredSeedId"
                label="优先种植种子"
                :options="preferredSeedOptions"
                @change="handlePreferredSeedChange"
              />
              <div v-else class="flex flex-col gap-1.5">
                <label class="text-sm text-gray-700 font-medium dark:text-gray-300">
                  {{ localStrategySettings.plantingStrategy === 'bag_priority' ? '第二优先策略预览' : '策略选种预览' }}
                </label>
                <div
                  class="w-full flex items-center justify-between border border-gray-200 rounded-lg bg-gray-50 px-3 py-2 text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400"
                >
                  <span class="truncate">{{ strategyPreviewLabel ?? '加载中...' }}</span>
                  <span class="shrink-0 text-lg text-gray-400">▼</span>
                </div>
              </div>
            </div>

            <div v-if="localStrategySettings.plantingStrategy === 'bag_priority'" class="space-y-3">
              <BaseSelect
                v-model="localStrategySettings.bagSeedFallbackStrategy"
                label="第二优先策略"
                :options="BAG_FALLBACK_STRATEGY_OPTIONS"
                @change="handleBagFallbackStrategyChange"
              />
              <div class="border border-amber-200 rounded-lg bg-amber-50/70 p-3 space-y-3 dark:border-amber-800/50 dark:bg-amber-900/20">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div class="text-sm text-amber-900 font-semibold dark:text-amber-200">
                      背包种子优先顺序
                    </div>
                    <p class="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">
                      先按下方顺序消耗背包中的 1x1 / 2x2 种子；背包种子不足时，再按“第二优先策略”补种。切换第二优先策略或重置时会据此重新排序。
                    </p>
                    <p class="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">
                      配了土地限制的种子会先占用它能种的地块，再由不限制的种子使用剩余空地。
                    </p>
                  </div>
                  <NButton
                    size="tiny"
                    type="warning"
                    secondary
                    @click="resetBagSeedPriority"
                  >
                    重置顺序
                  </NButton>
                </div>
                <div v-if="bagSeedsLoading" class="py-4 text-center text-sm text-amber-700 dark:text-amber-300">
                  加载中...
                </div>
                <div v-else-if="bagSeedsError" class="py-4 text-center text-sm text-red-600 dark:text-red-400">
                  {{ bagSeedsError }}
                </div>
                <div v-else-if="bagSeeds.length === 0" class="py-4 text-center text-sm text-amber-700 dark:text-amber-300">
                  背包中暂无 1x1 / 2x2 种子
                </div>
                <div v-else class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <BagSeedPriorityItem
                    v-for="(seed, index) in sortedBagSeeds"
                    :key="seed.seedId"
                    :seed="seed"
                    :index="index"
                    :land-types="localStrategySettings.bagSeedLandTypes[String(seed.seedId)]"
                    :land-type-options="fertilizerLandTypeOptions"
                    :dragging="draggingBagSeedId === seed.seedId"
                    :can-move-up="index > 0"
                    :can-move-down="index < sortedBagSeeds.length - 1"
                    @move-up="moveBagSeedUp(seed.seedId)"
                    @move-down="moveBagSeedDown(seed.seedId)"
                    @update:land-types="setBagSeedLandTypes(seed.seedId, $event)"
                    @drag-start="startBagSeedDrag(seed.seedId, $event)"
                    @drag-end="endBagSeedDrag"
                    @drag-over="dragOverBagSeed(seed.seedId, $event)"
                    @drop="dropBagSeed(seed.seedId, $event)"
                  />
                </div>
                <div v-if="orphanRestrictedSeeds.length > 0" class="border-t border-amber-200 pt-2 dark:border-amber-800/50">
                  <div class="text-xs text-amber-800 dark:text-amber-300">
                    未持有但已配限制
                  </div>
                  <p class="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
                    这些种子当前不在背包中，限制已保留，重新入库后仍生效。
                  </p>
                  <div class="mt-2 flex flex-wrap gap-1.5">
                    <span
                      v-for="item in orphanRestrictedSeeds"
                      :key="item.seedId"
                      class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                    >
                      {{ item.name }} · {{ item.scope }}
                      <button
                        type="button"
                        class="i-carbon-close text-amber-600 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
                        :title="`清除 ${item.name} 的土地限制`"
                        :aria-label="`清除 ${item.name} 的土地限制`"
                        @click="setBagSeedLandTypes(item.seedId, [])"
                      />
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              <BaseInput
                v-model.number="localStrategySettings.intervals.farmMin"
                label="农场巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localStrategySettings.intervals.farmMax"
                label="农场巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
              <BaseInput
                v-model.number="localStrategySettings.intervals.friendMin"
                label="好友任务最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localStrategySettings.intervals.friendMax"
                label="好友任务最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
              <BaseSwitch
                v-model="localStrategySettings.friendQuietHours.enabled"
                label="启用静默时段"
              />
              <div class="flex items-center gap-2">
                <NTimePicker
                  v-model:formatted-value="localStrategySettings.friendQuietHours.start"
                  class="w-28"
                  format="HH:mm"
                  value-format="HH:mm"
                  :clearable="false"
                  :disabled="!localStrategySettings.friendQuietHours.enabled"
                  size="small"
                />
                <span class="text-xs text-gray-500">-</span>
                <NTimePicker
                  v-model:formatted-value="localStrategySettings.friendQuietHours.end"
                  class="w-28"
                  format="HH:mm"
                  value-format="HH:mm"
                  :clearable="false"
                  :disabled="!localStrategySettings.friendQuietHours.enabled"
                  size="small"
                />
              </div>
              <BaseSwitch
                v-model="localStrategySettings.friendQuietHours.continueFarm"
                label="静默时继续农场巡查"
                :disabled="!localStrategySettings.friendQuietHours.enabled"
              />
            </div>

            <div class="border-t pt-3 space-y-3 dark:border-gray-700">
              <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
                种植与偷菜延迟设置
              </h4>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <BaseSwitch
                  v-model="localStrategySettings.plantOrderRandom"
                  label="种植顺序随机"
                />
                <BaseInput
                  v-model.number="localStrategySettings.plantDelaySeconds"
                  label="种植延迟 (秒)"
                  type="number"
                  min="0"
                />
                <BaseInput
                  v-model.number="localStrategySettings.stealDelaySeconds"
                  label="偷菜延迟 (秒)"
                  type="number"
                  min="0"
                />
              </div>
            </div>

            <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="strategySaving"
                @click="saveStrategySettings"
              >
                保存策略设置
              </BaseButton>
            </div>
          </div>
        </div>

        <!-- 自动控制 -->
        <div v-else-if="activeTab === 'automation'" class="space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
              自动控制
              <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
                ({{ currentAccountName }})
              </span>
            </h3>
          </div>

          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId || loadedAccountId !== currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings mx-auto mb-2 text-3xl text-gray-400" />
            <p>{{ currentAccountId ? '账号设置加载失败，请切换账号或刷新页面重试' : '请先选择账号' }}</p>
          </div>

          <AutomationSettingsForm
            v-else
            v-model="localAutomationSettings"
            :saving="automationSaving"
            :fertilizer-land-type-options="fertilizerLandTypeOptions"
            :fertilizer-options="fertilizerOptions"
            @save="saveAutomationSettings"
          />
        </div>

        <!-- 系统设置 -->
        <div v-else-if="activeTab === 'system'" class="space-y-4">
          <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
            系统设置
          </h3>

          <div class="space-y-4">
            <div class="border farm-card border-gray-200 rounded-2xl bg-white p-4 shadow-md dark:border-gray-700 dark:bg-gray-800">
              <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
                <span class="i-carbon-settings" />
                运行环境
              </h4>

              <div v-if="systemConfigLoading" class="py-8 text-center text-gray-500">
                <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
              </div>
              <div v-else class="space-y-4">
                <div v-if="devicePresets.length" class="space-y-2">
                  <label class="block text-sm text-gray-700 font-medium dark:text-gray-300">设备预设</label>
                  <div class="flex flex-wrap gap-2">
                    <NButton
                      v-for="preset in devicePresets"
                      :key="preset.id"
                      size="small"
                      :type="selectedPresetId === preset.id ? 'primary' : 'default'"
                      :secondary="selectedPresetId !== preset.id"
                      :title="preset.description"
                      @click="applyDevicePreset(preset.id)"
                    >
                      {{ preset.name }}
                    </NButton>
                  </div>
                </div>

                <BaseInput
                  v-model="localSystemConfig.serverUrl"
                  label="服务器地址"
                  type="text"
                  placeholder="wss://..."
                />

                <div>
                  <BaseSelect
                    v-model="localSystemConfig.timeZone"
                    label="系统时区"
                    :options="timeZoneOptions"
                  />
                  <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    每日礼包、好友额度、任务统计、安静时段和日志时间均以此时区为准；推荐使用北京时间 / 上海。
                  </p>
                </div>

                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div class="flex flex-col gap-1.5">
                    <label class="text-sm text-gray-700 font-medium dark:text-gray-300">平台</label>
                    <div class="flex flex-wrap gap-2">
                      <NButton
                        v-for="option in platformOptions"
                        :key="option.value"
                        size="small"
                        :type="localSystemConfig.platform === option.value ? 'primary' : 'default'"
                        :secondary="localSystemConfig.platform !== option.value"
                        @click="localSystemConfig.platform = option.value"
                      >
                        {{ option.label }}
                      </NButton>
                    </div>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-sm text-gray-700 font-medium dark:text-gray-300">系统</label>
                    <div class="flex flex-wrap gap-2">
                      <NButton
                        v-for="option in osOptions"
                        :key="option.value"
                        size="small"
                        :type="localSystemConfig.deviceInfo.os === option.value ? 'primary' : 'default'"
                        :secondary="localSystemConfig.deviceInfo.os !== option.value"
                        @click="localSystemConfig.deviceInfo.os = option.value; localSystemConfig.os = option.value"
                      >
                        {{ option.label }}
                      </NButton>
                    </div>
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <BaseInput
                    v-model="localSystemConfig.deviceInfo.clientVersion"
                    label="客户端版本"
                    type="text"
                    :placeholder="defaultSystemConfig.deviceInfo.clientVersion || '从服务器加载中...'"
                    class="sm:col-span-2"
                  />
                  <BaseInput
                    v-model="localSystemConfig.deviceInfo.sysSoftware"
                    label="系统版本"
                    type="text"
                    placeholder="Windows 10"
                  />
                  <BaseInput
                    v-model="localSystemConfig.deviceInfo.deviceId"
                    label="设备标识"
                    type="text"
                    placeholder="DESKTOP-PC<WPC>"
                  />
                  <BaseInput
                    v-model="localSystemConfig.deviceInfo.memory"
                    label="内存 (MB)"
                    type="text"
                    placeholder="16384"
                  />
                  <BaseInput
                    v-model="localSystemConfig.deviceInfo.network"
                    label="网络"
                    type="text"
                    placeholder="wifi"
                  />
                  <BaseInput
                    v-model="localSystemConfig.deviceInfo.userAgent"
                    label="User-Agent"
                    type="text"
                    placeholder="Mozilla/5.0 ..."
                    class="sm:col-span-2"
                  />
                </div>

                <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
                  <BaseButton variant="secondary" size="sm" :loading="systemConfigSaving" @click="handleResetSystemConfig">
                    重置
                  </BaseButton>
                  <BaseButton variant="primary" size="sm" :loading="systemConfigSaving" @click="handleSaveSystemConfig">
                    保存运行环境
                  </BaseButton>
                </div>
              </div>
            </div>

            <div class="border farm-card border-gray-200 rounded-2xl bg-white p-4 shadow-md dark:border-gray-700 dark:bg-gray-800">
              <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
                🔑 修改管理员密码
              </h4>

              <div class="space-y-3">
                <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <BaseInput
                    v-model="passwordForm.old"
                    label="当前密码"
                    type="password"
                    placeholder="当前管理员密码"
                  />
                  <BaseInput
                    v-model="passwordForm.new"
                    label="新密码"
                    type="password"
                    placeholder="至少 6 位"
                  />
                  <BaseInput
                    v-model="passwordForm.confirm"
                    label="确认新密码"
                    type="password"
                    placeholder="再次输入新密码"
                  />
                </div>

                <div class="flex items-center justify-end pt-1">
                  <BaseButton
                    variant="primary"
                    size="sm"
                    :loading="passwordSaving"
                    @click="handleChangePassword"
                  >
                    修改管理员密码
                  </BaseButton>
                </div>
              </div>
            </div>

            <div class="border farm-card border-gray-200 rounded-2xl bg-white p-4 shadow-md dark:border-gray-700 dark:bg-gray-800">
              <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
                🔔 下线提醒
              </h4>

              <div class="space-y-3">
                <div class="grid grid-cols-1 gap-3">
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <span class="text-sm text-gray-700 font-medium dark:text-gray-300">推送渠道</span>
                      <BaseButton
                        variant="text"
                        size="sm"
                        :disabled="!currentChannelDocUrl"
                        @click="openChannelDocs"
                      >
                        官方文档
                      </BaseButton>
                    </div>
                    <BaseSelect
                      v-model="localOffline.channel"
                      :options="channelOptions"
                    />
                  </div>
                </div>

                <BaseInput
                  v-if="offlineChannelUsesEndpoint"
                  v-model="localOffline.endpoint"
                  :label="offlineEndpointLabel"
                  type="text"
                  :placeholder="offlineEndpointPlaceholder"
                />

                <BaseInput
                  v-if="!isDingTalkChannel"
                  v-model="localOffline.token"
                  :label="offlineTokenLabel"
                  type="text"
                  :placeholder="offlineTokenPlaceholder"
                />

                <template v-else>
                  <BaseInput
                    v-model="localOffline.secret"
                    label="加签密钥（可选）"
                    type="password"
                    placeholder="仅在机器人开启加签时填写 SEC..."
                  />
                  <p class="text-xs text-gray-500 leading-relaxed dark:text-gray-400">
                    从群机器人的设置页复制完整 Webhook；只有开启“加签”时才需要填写加签密钥。
                  </p>
                </template>

                <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <BaseInput
                    v-model="localOffline.title"
                    label="标题"
                    type="text"
                    placeholder="提醒标题"
                  />
                  <BaseInput
                    v-model.number="localOffline.offlineDeleteSec"
                    label="离线删除账号 (秒)"
                    type="number"
                    min="0"
                    placeholder="0 表示不删除"
                  />
                </div>

                <BaseInput
                  v-model="localOffline.msg"
                  label="内容"
                  type="text"
                  placeholder="提醒内容"
                />
              </div>

              <div class="mt-4 flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
                <BaseButton
                  variant="secondary"
                  size="sm"
                  :loading="offlineTesting"
                  :disabled="offlineSaving"
                  @click="handleTestOffline"
                >
                  测试通知
                </BaseButton>
                <BaseButton
                  variant="primary"
                  size="sm"
                  :loading="offlineSaving"
                  :disabled="offlineTesting"
                  @click="handleSaveOffline"
                >
                  保存下线提醒设置
                </BaseButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @cancel="modalVisible = false"
    />
  </div>
</template>
