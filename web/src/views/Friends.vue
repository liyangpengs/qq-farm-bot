<script setup lang="ts">
import type { FriendInteractionItemDto, FriendInteractionResultDto } from '@/stores/friend'
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NButtonGroup } from 'naive-ui/es/button-group'
import { NCard } from 'naive-ui/es/card'
import { NDropdown } from 'naive-ui/es/dropdown'
import { NModal } from 'naive-ui/es/modal'
import { NPagination } from 'naive-ui/es/pagination'
import { NSpin } from 'naive-ui/es/spin'
import { NTab } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import PageTabs from '@/components/PageTabs.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { interactionItemTargetReason } from '@/utils/interaction-item-rules'

const accountStore = useAccountStore()
const friendStore = useFriendStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status } = storeToRefs(statusStore)
const {
  friends,
  loading,
  friendLands,
  friendLandsLoading,
  friendLandsError,
  friendLandsLoaded,
  friendCareer,
  blacklist,
  interactRecords,
  interactLoading,
  interactError,
  interactionItems,
  interactionItemsLoading,
  interactionItemsError,
  interactionUsePending,
  interactionUseError,
  knownFriendGids,
  knownFriendGidSyncCooldownSec,
  friendsListCacheTtlSec,
  knownFriendSettingsLoading,
  knownFriendSettingsSaving,
} = storeToRefs(friendStore)
const isQqAccount = computed(() => {
  const acc = currentAccount.value
  if (!acc)
    return false
  const platform = String(acc.platform || 'qq').toLowerCase()
  return platform === 'qq'
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
const friendDataLoadScope = computed(() => (
  currentAccountRunning.value ? String(currentAccountId.value || '') : ''
))

const knownFriendGidCount = computed(() => knownFriendGids.value.length)
const knownFriendGidSet = computed(() => new Set(knownFriendGids.value.map(Number)))
const friendGidSet = computed(() => new Set(friends.value.map(f => Number(f.gid))))
const blacklistGidSet = computed(() => new Set(blacklist.value.map(item => Number(item.gid))))
const showGidListModal = ref(false)
const gidSearchKeyword = ref('')

const filteredKnownFriendGids = computed(() => {
  const keyword = gidSearchKeyword.value.trim().toLowerCase()
  const list = knownFriendGids.value.map(gid => ({
    gid: Number(gid),
    synced: friendGidSet.value.has(Number(gid)),
  }))
  if (!keyword)
    return list
  return list.filter(item => String(item.gid).includes(keyword))
})

const syncedGidCount = computed(() => filteredKnownFriendGids.value.filter(item => item.synced).length)
const unsyncedGidCount = computed(() => filteredKnownFriendGids.value.filter(item => !item.synced).length)
const knownFriendSettingsLoadedAccount = ref('')

async function handleRemoveGidFromList(gid: number) {
  if (!currentAccountId.value)
    return
  await friendStore.removeKnownFriendGid(currentAccountId.value, gid)
}

async function handleRemoveUnsyncedGids() {
  if (!currentAccountId.value)
    return
  const unsyncedGids = filteredKnownFriendGids.value.filter(item => !item.synced).map(item => item.gid)
  if (unsyncedGids.length === 0) {
    toast.info('没有需要删除的未同步 GID')
    return
  }
  const result = await friendStore.removeUnsyncedKnownFriendGids(currentAccountId.value, unsyncedGids)
  if (result.ok && result.removedCount > 0) {
    toast.success(`已删除 ${result.removedCount} 个未同步的 GID`)
  }
}

function openGidListModal() {
  gidSearchKeyword.value = ''
  showGidListModal.value = true
  const accountId = currentAccountId.value
  if (accountId && isQqAccount.value && knownFriendSettingsLoadedAccount.value !== accountId) {
    knownFriendSettingsLoadedAccount.value = accountId
    void friendStore.fetchKnownFriendSettings(accountId)
  }
}

const TABS = [
  { key: 'friends', label: '好友列表', icon: 'i-carbon-user-multiple' },
  { key: 'blacklist', label: '好友黑名单', icon: 'i-carbon-rule-cancelled' },
  { key: 'visitors', label: '最近访客', icon: 'i-carbon-recently-viewed' },
] as const

type TabKey = typeof TABS[number]['key']

const activeTab = ref<TabKey>('friends')
const friendsLoadedAccount = ref('')
const blacklistLoadedAccount = ref('')
const interactRecordsLoadedAccount = ref('')

function setActiveTab(value: string) {
  if (TABS.some(tab => tab.key === value)) {
    activeTab.value = value as TabKey
    loadTabData()
  }
}

const showConfirm = ref(false)
const confirmMessage = ref('')
const confirmLoading = ref(false)
const pendingAction = ref<(() => Promise<any>) | null>(null)
const avatarErrorKeys = ref<Set<string>>(new Set())
const searchKeyword = ref('')
const localKnownFriendGidSyncCooldownSec = ref(300)
const localFriendsListCacheTtlSec = ref(60)
const showBatchAddGidModal = ref(false)
const batchGidInput = ref('')
const interactFilter = ref('all')
const interactFilters = [
  { key: 'all', label: '全部' },
  { key: 'steal', label: '偷菜' },
  { key: 'help', label: '帮忙' },
  { key: 'bad', label: '捣乱' },
]

function confirmAction(msg: string, action: () => Promise<any>) {
  confirmMessage.value = msg
  pendingAction.value = action
  showConfirm.value = true
}

async function onConfirm() {
  if (pendingAction.value) {
    try {
      confirmLoading.value = true
      await pendingAction.value()
    }
    catch (e: any) {
      toast.error(getApiErrorMessage(e, '操作失败'))
    }
    finally {
      confirmLoading.value = false
      pendingAction.value = null
      showConfirm.value = false
    }
  }
  else {
    showConfirm.value = false
  }
}

const expandedFriends = ref<Set<string>>(new Set())
const selectedInteractionItemId = ref('')
const selectedInteractionLandIds = ref<Record<string, string[]>>({})
const lastInteractionResults = ref<Record<string, FriendInteractionResultDto[]>>({})
const currentPage = ref(1)
const pageSize = 25

const selectedInteractionItem = computed<FriendInteractionItemDto | null>(() => {
  return interactionItems.value.find(item => String(item.itemId) === selectedInteractionItemId.value) || null
})

const sortedFriends = computed(() => {
  return [...friends.value].sort((a: any, b: any) => {
    const levelA = Number(a?.level || 0)
    const levelB = Number(b?.level || 0)
    return levelB - levelA
  })
})

const filteredFriends = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  const list = sortedFriends.value
  if (!keyword)
    return list

  return list.filter((friend: any) => {
    const name = String(friend?.name || '').toLowerCase()
    const gid = String(friend?.gid || '')
    const uin = String(friend?.uin || '')
    return name.includes(keyword) || gid.includes(keyword) || uin.includes(keyword)
  })
})

const totalPages = computed(() => Math.ceil(filteredFriends.value.length / pageSize) || 1)

const paginatedFriends = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  const end = start + pageSize
  return filteredFriends.value.slice(start, end)
})

// 好友上场宠物徽标：后端按天缓存，进好友农场时顺手更新，另有每日同步补齐，展示不触发任何请求
const PET_BADGE_CLASSES: Record<string, string> = {
  protect: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  other: 'bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300',
  none: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300',
  unknown: 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-400',
}

function buildFriendPetBadge(friend: any) {
  const state = String(friend?.petState || 'unknown')
  const name = String(friend?.pet?.name || '').trim()
  const image = String(friend?.pet?.image || '')
  const badgeClass = PET_BADGE_CLASSES[state] || PET_BADGE_CLASSES.unknown
  if (state === 'protect')
    return { state, text: name || '护主犬', title: '看家宠物：护主犬（经验满仍会帮忙）', image, class: badgeClass }
  if (state === 'other')
    return { state, text: name || '未知宠物', title: `看家宠物：${name || '未知'}`, image, class: badgeClass }
  if (state === 'none')
    return { state, text: '无宠物', title: '今天已确认：好友没有上场看家宠物', image: '', class: badgeClass }
  return { state, text: '宠物待确认', title: '今天还没进过这位好友的农场，宠物信息由每日同步补齐', image: '', class: badgeClass }
}

const friendPetBadges = computed(() => {
  const map: Record<string, ReturnType<typeof buildFriendPetBadge>> = {}
  for (const friend of friends.value)
    map[String(friend?.gid ?? '')] = buildFriendPetBadge(friend)
  return map
})

function friendPetBadge(friend: any) {
  return friendPetBadges.value[String(friend?.gid ?? '')] || buildFriendPetBadge(friend)
}

watch(searchKeyword, () => {
  currentPage.value = 1
})

const filteredInteractRecords = computed(() => {
  if (interactFilter.value === 'all')
    return interactRecords.value

  const actionTypeMap: Record<string, number> = {
    steal: 1,
    help: 2,
    bad: 3,
  }
  const targetActionType = actionTypeMap[interactFilter.value] || 0
  return interactRecords.value.filter((record: any) => Number(record?.actionType) === targetActionType)
})

const visibleInteractRecords = computed(() => filteredInteractRecords.value.slice(0, 50))

function friendKey(friendId: unknown) {
  return String(friendId || '')
}

function interactionSelectionKey(friendId: unknown, itemId: unknown = selectedInteractionItemId.value) {
  return `${String(itemId || '')}:${friendKey(friendId)}`
}

function toggleInteractionItem(itemId: unknown) {
  const nextItemId = String(itemId || '')
  selectedInteractionItemId.value = selectedInteractionItemId.value === nextItemId ? '' : nextItemId
}

function selectedInteractionIds(friendId: unknown, itemId: unknown = selectedInteractionItemId.value) {
  return selectedInteractionLandIds.value[interactionSelectionKey(friendId, itemId)] || []
}

function usedInteractionIdSet(friendId: unknown, itemId: unknown = selectedInteractionItemId.value) {
  if (!currentAccountId.value || !itemId)
    return new Set<string>()
  return new Set(friendStore.getInteractionUsedLandIds(currentAccountId.value, itemId, friendKey(friendId)))
}

function hasConfirmedInteractionEffect(land: any, itemId: unknown = selectedInteractionItemId.value) {
  const normalizedItemId = String(itemId || '')
  return !!normalizedItemId && (Array.isArray(land?.interactionEffects) ? land.interactionEffects : [])
    .some((effect: any) => effect?.confirmed && String(effect?.itemId || '') === normalizedItemId)
}

function isInteractionLandCandidate(land: any) {
  if (selectedInteractionItem.value?.targetKind === 'farm')
    return false
  return !!selectedInteractionItem.value
    && !interactionItemTargetReason(selectedInteractionItem.value.itemId, land)
}

function isInteractionLandSelected(friendId: unknown, land: any) {
  return selectedInteractionIds(friendId).includes(String(land?.id || ''))
}

function isInteractionLandDisabled(friendId: unknown, land: any) {
  const item = selectedInteractionItem.value
  return !item
    || item.count < 1
    || interactionUsePending.value
    || !isInteractionLandCandidate(land)
    || hasConfirmedInteractionEffect(land, item.itemId)
    || usedInteractionIdSet(friendId, item.itemId).has(String(land?.id || ''))
}

function interactionLandSelectionLabel(friendId: unknown, land: any) {
  const landId = String(land?.id || '')
  if (hasConfirmedInteractionEffect(land))
    return '已生效'
  if (usedInteractionIdSet(friendId).has(landId))
    return '本次已用'
  return selectedInteractionItem.value
    ? interactionItemTargetReason(selectedInteractionItem.value.itemId, land)
    : ''
}

function setSelectedInteractionIds(friendId: unknown, ids: string[], itemId: unknown = selectedInteractionItemId.value) {
  const key = interactionSelectionKey(friendId, itemId)
  selectedInteractionLandIds.value = {
    ...selectedInteractionLandIds.value,
    [key]: [...new Set(ids.map(String))].sort((left, right) => Number(left) - Number(right)),
  }
}

function toggleInteractionLand(friendId: unknown, land: any) {
  const item = selectedInteractionItem.value
  if (!item || isInteractionLandDisabled(friendId, land))
    return
  const landId = String(land?.id || '')
  const next = new Set(selectedInteractionIds(friendId, item.itemId))
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
  setSelectedInteractionIds(friendId, [...next], item.itemId)
}

function selectAllInteractionLands(friendId: unknown) {
  const item = selectedInteractionItem.value
  if (!item)
    return
  const key = friendKey(friendId)
  const used = usedInteractionIdSet(key, item.itemId)
  const candidates = (friendLands.value[key] || [])
    .filter(land => isInteractionLandCandidate(land) && !hasConfirmedInteractionEffect(land, item.itemId) && !used.has(String(land.id)))
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(0, item.count)
    .map(land => String(land.id))
  setSelectedInteractionIds(key, candidates, item.itemId)
}

function requestUseInteractionItem(friend: any) {
  const accountId = currentAccountId.value
  const item = selectedInteractionItem.value
  if (!accountId || !item)
    return
  const key = friendKey(friend?.gid)
  const landIds = selectedInteractionIds(key, item.itemId)
  if (landIds.length === 0)
    return
  const friendName = String(friend?.name || `GID ${key}`)
  const saleConditionWarning = item.saleConditionSatisfiedCount > 0
    ? `该道具库存中有 ${item.saleConditionSatisfiedCount} 个已满足游戏配置的出售条件，可能已过活动或有效期，`
    : ''
  confirmAction(
    `${saleConditionWarning}将在 ${friendName} 的 ${landIds.length} 块土地上按编号依次使用“${item.name}”。若期间作物状态发生变化，部分地块可能使用失败；是否继续？`,
    async () => {
      const result = await friendStore.useInteractionItemBatch(accountId, key, item.itemId, landIds)
      if (!result)
        throw new Error(interactionUseError.value || `${item.name}使用失败`)
      lastInteractionResults.value = {
        ...lastInteractionResults.value,
        [interactionSelectionKey(key, item.itemId)]: result.results || [],
      }
      const used = new Set(result.usedLandIds || [])
      setSelectedInteractionIds(key, landIds.filter(landId => !used.has(landId)), item.itemId)
      const successCount = Number(result.successCount || 0)
      const failureCount = Number(result.failureCount || 0)
      if (successCount > 0 && failureCount === 0)
        toast.success(result.message || `已按顺序使用 ${successCount} 个${item.name}`)
      else if (successCount > 0)
        toast.warning(result.message || `成功 ${successCount} 块，跳过 ${failureCount} 块`)
      else
        toast.warning(result.message || `所选地块当前均不可使用${item.name}`)
      return result
    },
  )
}

function interactionFailures(friendId: unknown) {
  const results = lastInteractionResults.value[interactionSelectionKey(friendId)] || []
  return results.filter(result => !result.ok)
}

async function loadData() {
  const accountId = currentAccountId.value
  if (!accountId || !currentAccountRunning.value || activeTab.value !== 'friends' || friendsLoadedAccount.value === accountId)
    return

  friendsLoadedAccount.value = accountId
  avatarErrorKeys.value.clear()
  await friendStore.fetchFriends(accountId)
}

function loadTabData() {
  const accountId = currentAccountId.value
  if (!accountId || !currentAccountRunning.value)
    return

  if (activeTab.value === 'friends')
    void loadData()
  if (activeTab.value === 'blacklist' && blacklistLoadedAccount.value !== accountId) {
    blacklistLoadedAccount.value = accountId
    void friendStore.fetchBlacklist(accountId)
  }
  if (activeTab.value === 'visitors' && interactRecordsLoadedAccount.value !== accountId) {
    interactRecordsLoadedAccount.value = accountId
    void friendStore.fetchInteractRecords(accountId)
  }
}

function requestUseFarmInteractionItem(friend: any) {
  const accountId = currentAccountId.value
  const item = selectedInteractionItem.value
  if (!accountId || !item || item.targetKind !== 'farm' || item.count < 1)
    return
  const key = friendKey(friend?.gid)
  const name = String(friend?.name || `GID ${key}`)
  confirmAction(`确定在 ${name} 的农场放出 1 个“${item.name}”吗？`, async () => {
    const result = await friendStore.useFarmInteractionItem(accountId, key, item.itemId)
    if (!result)
      throw new Error(interactionUseError.value || `${item.name}使用失败`)
    toast.success(result.message || `已在${name}的农场使用${item.name}`)
    return result
  })
}
useIntervalFn(() => {
  for (const gid of expandedFriends.value) {
    for (const land of friendLands.value[gid] || []) {
      if (land.matureInSec > 0)
        land.matureInSec--
    }
  }
}, 1000)

watch(currentAccountId, () => {
  expandedFriends.value.clear()
  selectedInteractionItemId.value = ''
  selectedInteractionLandIds.value = {}
  lastInteractionResults.value = {}
  friendsLoadedAccount.value = ''
  blacklistLoadedAccount.value = ''
  interactRecordsLoadedAccount.value = ''
  knownFriendSettingsLoadedAccount.value = ''
  friendStore.resetInteractionState()
  friendStore.resetFriendLandState()
})
watch(friendDataLoadScope, (scope) => {
  if (!scope) {
    friendsLoadedAccount.value = ''
    blacklistLoadedAccount.value = ''
    interactRecordsLoadedAccount.value = ''
  }
  void loadData()
  loadTabData()
}, { immediate: true })

watch(interactionItems, (items) => {
  if (!items.some(item => String(item.itemId) === selectedInteractionItemId.value))
    selectedInteractionItemId.value = ''
}, { immediate: true })

async function handleRefreshFriends() {
  if (!currentAccountId.value)
    return
  try {
    await api.post('/api/friends/clear-cache', {}, {
      headers: { 'x-account-id': currentAccountId.value },
    })
  }
  catch {
    // ignore
  }
  await friendStore.fetchFriends(currentAccountId.value, true)
}

async function refreshFriendLands(friendId: unknown) {
  const accountId = currentAccountId.value
  const key = friendKey(friendId)
  if (!accountId || !key || friendLandsLoading.value[key])
    return
  await friendStore.fetchFriendLands(accountId, key)
}

function toggleFriend(friendId: string) {
  const key = friendKey(friendId)
  if (expandedFriends.value.has(key)) {
    expandedFriends.value.delete(key)
    setSelectedInteractionIds(key, [])
  }
  else {
    expandedFriends.value.clear()
    selectedInteractionLandIds.value = {}
    expandedFriends.value.add(key)
    if (currentAccountId.value && currentAccountRunning.value) {
      void Promise.allSettled([
        friendStore.fetchFriendLands(currentAccountId.value, key),
        friendStore.fetchInteractionItems(currentAccountId.value),
      ])
    }
  }
}

async function handleOp(friendId: string, type: string, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return

  const opNames: Record<string, string> = {
    steal: '偷取',
    farming: '一键务农',
    bad: '捣乱',
  }

  if (type === 'bad') {
    confirmAction('确定对好友执行捣乱操作吗?', async () => {
      toast.info('已在捣乱中，间隔较长，请稍后返回好友土地查看')
      friendStore.operate(currentAccountId.value!, friendId, type)
      return { ok: true }
    })
  }
  else {
    confirmAction(`确定对好友执行${opNames[type] || type}操作吗?`, async () => {
      const result = await friendStore.operate(currentAccountId.value!, friendId, type)
      if (result?.ok) {
        toast.success(result.message || `${opNames[type] || type}完成`)
      }
      else {
        toast.error(result?.message || `${opNames[type] || type}失败`)
      }
      return result
    })
  }
}

async function handleToggleBlacklist(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, Number(friend.gid))
}

async function handleDeleteFriend(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  const gid = Number(friend?.gid) || 0
  const name = String(friend?.name || `GID:${gid}`).trim()
  confirmAction(
    `确定删除好友 ${name} 吗？这会真正解除游戏好友关系且不可恢复，并加入本地黑名单。之后自动偷菜、帮忙、捣乱和自动同意申请都会跳过该好友。`,
    async () => {
      const result = await friendStore.deleteFriend(currentAccountId.value!, {
        gid,
        name: friend?.name,
        avatarUrl: friend?.avatarUrl,
      })
      if (result?.ok) {
        expandedFriends.value.delete(String(gid))
        toast.success(result.message || `已删除好友: ${name}`)
      }
      else {
        toast.error(result?.message || '删除好友失败')
      }
      return result
    },
  )
}

const FRIEND_ACTION_TAGS = [
  { key: 'stealNum', kind: 'steal', label: '可偷', icon: 'i-carbon-wheat' },
  { key: 'dryNum', kind: 'water', label: '缺水', icon: 'i-carbon-rain-drop' },
  { key: 'weedNum', kind: 'weed', label: '杂草', icon: 'i-carbon-clean' },
  { key: 'insectNum', kind: 'bug', label: '虫害', icon: 'i-carbon-debug' },
] as const

// 只展示有数量的可操作状态，“无操作”不再逐行占位。
function friendActionTags(friend: any) {
  const plant = friend?.plant || {}
  return FRIEND_ACTION_TAGS
    .map(tag => ({ ...tag, count: Number(plant[tag.key]) || 0 }))
    .filter(tag => tag.count > 0)
}

function friendCanSteal(friend: any) {
  return Number(friend?.plant?.stealNum) > 0
}

function friendNeedsCare(friend: any) {
  const plant = friend?.plant || {}
  return Number(plant.dryNum) > 0 || Number(plant.weedNum) > 0 || Number(plant.insectNum) > 0
}

function friendMoreOptions(friend: any) {
  const blocked = blacklistGidSet.value.has(Number(friend.gid))
  const options: any[] = [
    { key: 'blacklist', label: blocked ? '移出黑名单' : '加入黑名单' },
  ]
  if (isQqAccount.value && knownFriendGidSet.value.has(Number(friend.gid)))
    options.push({ key: 'unsync', label: '移出同步列表' })
  options.push(
    { type: 'divider', key: 'divider' },
    { key: 'delete', label: '删除好友', disabled: !currentAccountRunning.value, props: { style: 'color: var(--ui-danger)' } },
  )
  return options
}

function handleFriendMore(key: string, friend: any) {
  const event = { stopPropagation() {} } as Event
  if (key === 'blacklist')
    handleToggleBlacklist(friend, event)
  else if (key === 'unsync')
    handleRemoveKnownFriendGid(friend, event)
  else if (key === 'delete')
    handleDeleteFriend(friend, event)
}

function getFriendLevel(friend: any) {
  const level = Number.parseInt(String(friend?.level ?? ''), 10)
  if (!Number.isFinite(level) || level <= 0)
    return 0
  return level
}

function getFriendGold(friend: any) {
  const gold = Number.parseInt(String(friend?.gold ?? ''), 10)
  if (!Number.isFinite(gold) || gold < 0)
    return 0
  return gold
}

function formatFriendGold(value: unknown) {
  const gold = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(gold) || gold < 0)
    return '0'
  // 标签里用紧凑写法，完整数值放在 title 中。
  if (gold >= 100000000)
    return `${Number((gold / 100000000).toFixed(2))}亿`
  if (gold >= 10000)
    return `${Number((gold / 10000).toFixed(1))}万`
  return gold.toLocaleString('zh-CN')
}

function getFriendAvatar(friend: any) {
  return String(friend?.avatarUrl || friend?.avatar_url || '').trim()
}

function getFriendAvatarKey(friend: any) {
  const key = String(friend?.gid || friend?.uin || '').trim()
  return key || String(friend?.name || '').trim()
}

function canShowFriendAvatar(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key)
    return false
  return !!getFriendAvatar(friend) && !avatarErrorKeys.value.has(key)
}

function handleFriendAvatarError(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key)
    return
  avatarErrorKeys.value.add(key)
}

async function handleRemoveFromBlacklist(gid: number) {
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, gid)
}

async function refreshInteractRecords() {
  if (!currentAccountId.value)
    return
  await friendStore.fetchInteractRecords(currentAccountId.value)
}

function getInteractAvatar(record: any) {
  return String(record?.avatarUrl || '').trim()
}

function getInteractAvatarKey(record: any) {
  const key = String(record?.visitorGid || record?.key || record?.nick || '').trim()
  return key ? `interact:${key}` : ''
}

function canShowInteractAvatar(record: any) {
  const key = getInteractAvatarKey(record)
  if (!key)
    return false
  return !!getInteractAvatar(record) && !avatarErrorKeys.value.has(key)
}

function handleInteractAvatarError(record: any) {
  const key = getInteractAvatarKey(record)
  if (!key)
    return
  avatarErrorKeys.value.add(key)
}

function getInteractBadgeClass(actionType: number) {
  if (Number(actionType) === 1)
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (Number(actionType) === 2)
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (Number(actionType) === 3)
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

function formatInteractTime(timestamp: number) {
  const ts = Number(timestamp) || 0
  if (!ts)
    return '--'

  const date = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute

  if (diff >= 0 && diff < minute)
    return '刚刚'
  if (diff >= minute && diff < hour)
    return `${Math.floor(diff / minute)} 分钟前`

  const sameDay = now.getFullYear() === date.getFullYear()
    && now.getMonth() === date.getMonth()
    && now.getDate() === date.getDate()

  if (sameDay) {
    return `今天 ${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`
  }

  if (now.getFullYear() === date.getFullYear()) {
    return `${date.getMonth() + 1}-${date.getDate()} ${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function normalizeKnownFriendGidSyncCooldownSec(value: number) {
  const v = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(v) || v <= 0)
    return 600
  return Math.max(30, Math.min(86400, v))
}

function normalizeFriendsListCacheTtlSec(value: number) {
  const v = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(v) || v <= 0)
    return 60
  return Math.max(10, Math.min(86400, v))
}

async function handleRemoveKnownFriendGid(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  const gid = Number(friend?.gid) || 0
  const name = String(friend?.name || `GID ${gid}`).trim()
  confirmAction(
    `确定将 ${name} 移出同步列表吗？后续如果最近访客再次命中，这个 GID 仍可被自动同步回来。`,
    async () => {
      await friendStore.removeKnownFriendGid(currentAccountId.value!, gid)
      await refreshFriendsAfterKnownGidChange()
      toast.success(`已移出同步列表: ${name}`)
    },
  )
}

async function refreshFriendsAfterKnownGidChange() {
  if (!currentAccountId.value)
    return
  await friendStore.fetchFriends(currentAccountId.value, true)
}

async function handleSaveKnownFriendSettings() {
  if (!currentAccountId.value)
    return
  const cooldownSec = normalizeKnownFriendGidSyncCooldownSec(localKnownFriendGidSyncCooldownSec.value)
  const cacheTtlSec = normalizeFriendsListCacheTtlSec(localFriendsListCacheTtlSec.value)
  await friendStore.saveKnownFriendSettings(currentAccountId.value, {
    knownFriendGidSyncCooldownSec: cooldownSec,
    friendsListCacheTtlSec: cacheTtlSec,
  })
  toast.success('设置已保存')
}

watch(knownFriendGidSyncCooldownSec, (val) => {
  localKnownFriendGidSyncCooldownSec.value = val
}, { immediate: true })

watch(friendsListCacheTtlSec, (val) => {
  localFriendsListCacheTtlSec.value = val
}, { immediate: true })

function parseBatchGids(input: string): number[] {
  const text = String(input || '').trim()
  if (!text)
    return []
  const gids: number[] = []
  const parts = text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  for (const part of parts) {
    const num = Number.parseInt(part, 10)
    if (Number.isFinite(num) && num > 0 && !gids.includes(num)) {
      gids.push(num)
    }
  }
  return gids
}

async function handleBatchAddKnownFriendGids() {
  if (!currentAccountId.value)
    return
  const gids = parseBatchGids(batchGidInput.value)
  if (gids.length === 0) {
    toast.error('请输入有效的 GID 列表')
    return
  }
  const result = await friendStore.batchAddKnownFriendGids(currentAccountId.value, gids)
  if (result.ok) {
    batchGidInput.value = ''
    showBatchAddGidModal.value = false
    await refreshFriendsAfterKnownGidChange()
    toast.success(`已批量添加 ${result.addedCount} 个 GID`)
  }
}
</script>

<template>
  <div class="page-stack">
    <PageTabs :value="activeTab" @update:value="setActiveTab">
      <NTab v-for="tab in TABS" :key="tab.key" :name="tab.key">
        <span class="inline-flex items-center gap-2">
          <span :class="tab.icon" />
          {{ tab.label }}
          <span v-if="tab.key === 'blacklist' && blacklist.length > 0" class="text-xs text-red-500">
            {{ blacklist.length }}
          </span>
        </span>
      </NTab>
    </PageTabs>

    <div class="page-toolbar panel-sticky panel-sticky--page">
      <span class="text-sm text-gray-500">
        <template v-if="activeTab === 'friends'">共 {{ filteredFriends.length }}/{{ friends.length }} 名好友</template>
        <template v-else-if="activeTab === 'blacklist'">共 {{ blacklist.length }} 人</template>
        <template v-else>共 {{ filteredInteractRecords.length }}/{{ interactRecords.length }} 条记录</template>
      </span>
      <div v-if="activeTab === 'friends'" class="page-toolbar__actions friends-toolbar">
        <BaseInput
          v-model="searchKeyword"
          placeholder="搜索好友名称或 GID"
          clearable
          class="friends-search"
        />
        <NButton
          secondary
          :loading="loading"
          :disabled="!currentAccountId || !currentAccountRunning"
          title="刷新好友列表"
          aria-label="刷新好友列表"
          @click="handleRefreshFriends"
        >
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </div>

    <div v-if="loading || interactLoading" class="flex justify-center py-12">
      <NSpin size="large" />
    </div>

    <EmptyState v-else-if="!currentAccountId" title="请先选择账号" description="添加并选择账号后查看好友" icon="i-carbon-user-avatar" />

    <EmptyState v-else-if="!currentAccountRunning" title="账号未运行" description="启动账号后读取好友列表" icon="i-carbon-connection-signal-off" />

    <template v-else>
      <div v-if="activeTab === 'friends'" class="space-y-4">
        <div v-if="currentAccountId && isQqAccount" class="mb-4 border farm-card border-amber-200 rounded-2xl bg-white p-4 shadow-md dark:border-amber-700/50 dark:bg-gray-800">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div class="flex items-center gap-2">
                <span class="i-carbon-list-checked text-lg text-amber-500" />
                <h3 class="text-lg text-gray-700 font-semibold dark:text-gray-200">
                  QQ 好友自动同步
                </h3>
                <NButton
                  text
                  type="primary"
                  size="tiny"
                  @click="openGidListModal"
                >
                  {{ knownFriendGidCount }} 个 GID
                </NButton>
              </div>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                QQ 新好友接口依赖已知 GID。系统会自动从最近访客补充，进入好友农场明确失败时自动移除失效 GID。
              </p>
            </div>
            <div class="flex shrink-0 gap-2">
              <BaseButton
                variant="secondary"
                size="sm"
                :loading="knownFriendSettingsLoading"
                @click="currentAccountId && friendStore.fetchKnownFriendSettings(currentAccountId)"
              >
                刷新
              </BaseButton>
              <BaseButton
                variant="primary"
                size="sm"
                :loading="knownFriendSettingsSaving"
                @click="handleSaveKnownFriendSettings"
              >
                保存设置
              </BaseButton>
              <BaseButton
                variant="secondary"
                size="sm"
                @click="showBatchAddGidModal = true"
              >
                批量新增 GID
              </BaseButton>
            </div>
          </div>

          <div class="grid mt-4 gap-3 lg:grid-cols-2">
            <BaseInput
              v-model.number="localKnownFriendGidSyncCooldownSec"
              type="number"
              label="访客检测入库冷却（秒）"
              :min="10"
            />
            <BaseInput
              v-model.number="localFriendsListCacheTtlSec"
              type="number"
              label="好友列表缓存（秒）"
              :min="10"
            />
          </div>
        </div>

        <div v-if="friends.length === 0" class="farm-card rounded-2xl bg-white p-8 text-center text-gray-500 shadow-md dark:bg-gray-800">
          暂无好友或数据加载失败
        </div>

        <template v-else>
          <div
            v-for="friend in paginatedFriends"
            :key="friend.gid"
            class="friend-card"
            :class="{ 'is-expanded': expandedFriends.has(String(friend.gid)), 'is-blocked': blacklistGidSet.has(Number(friend.gid)) }"
          >
            <div
              class="friend-row"
              role="button"
              tabindex="0"
              :aria-expanded="expandedFriends.has(String(friend.gid))"
              :aria-label="`${friend.name}，点击查看土地`"
              @click="toggleFriend(friend.gid)"
              @keydown.enter.self.prevent="toggleFriend(friend.gid)"
              @keydown.space.self.prevent="toggleFriend(friend.gid)"
            >
              <div class="friend-avatar">
                <img
                  v-if="canShowFriendAvatar(friend)"
                  :src="getFriendAvatar(friend)"
                  alt=""
                  loading="lazy"
                  @error="handleFriendAvatarError(friend)"
                >
                <span v-else class="i-carbon-user" />
              </div>

              <div class="friend-main">
                <div class="friend-name-row">
                  <strong class="friend-name" :title="friend.name">{{ friend.name }}</strong>
                  <span class="friend-gid">{{ friend.gid }}</span>
                  <span v-if="blacklistGidSet.has(Number(friend.gid))" class="f-tag f-tag--blocked">已屏蔽</span>
                </div>
                <div class="friend-tags">
                  <span v-if="getFriendLevel(friend) > 0" class="f-tag f-tag--level">Lv.{{ getFriendLevel(friend) }}</span>
                  <span class="f-tag" :class="`f-tag--pet-${friendPetBadge(friend).state}`" :title="friendPetBadge(friend).title">
                    <img v-if="friendPetBadge(friend).image" :src="friendPetBadge(friend).image" alt="" loading="lazy">
                    <span v-else class="i-carbon-dog-walker" />
                    {{ friendPetBadge(friend).state === 'unknown' ? '宠物未知' : friendPetBadge(friend).text }}
                  </span>
                  <span v-if="getFriendGold(friend) > 0" class="f-tag f-tag--gold" :title="`金币 ${getFriendGold(friend).toLocaleString('zh-CN')}`">
                    <span class="i-fas-coins" />{{ formatFriendGold(friend.gold) }}
                  </span>
                  <span
                    v-for="tag in friendActionTags(friend)"
                    :key="tag.kind"
                    class="f-tag"
                    :class="`f-tag--${tag.kind}`"
                  >
                    <span :class="tag.icon" />{{ tag.label }} {{ tag.count }}
                  </span>
                </div>
              </div>

              <div class="friend-actions" @click.stop @keydown.stop>
                <NButton size="small" :type="friendCanSteal(friend) ? 'primary' : 'default'" secondary @click="handleOp(friend.gid, 'steal', $event)">
                  <template #icon>
                    <span class="i-carbon-shopping-bag" />
                  </template>
                  偷取
                </NButton>
                <NButton size="small" :type="friendNeedsCare(friend) ? 'primary' : 'default'" secondary @click="handleOp(friend.gid, 'farming', $event)">
                  <template #icon>
                    <span class="i-carbon-sprout" />
                  </template>
                  务农
                </NButton>
                <NButton size="small" secondary @click="handleOp(friend.gid, 'bad', $event)">
                  <template #icon>
                    <span class="i-carbon-debug" />
                  </template>
                  捣乱
                </NButton>
                <NDropdown trigger="click" placement="bottom-end" :options="friendMoreOptions(friend)" @select="(key: string) => handleFriendMore(key, friend)">
                  <NButton size="small" quaternary circle title="更多操作" aria-label="更多操作">
                    <template #icon>
                      <span class="i-carbon-overflow-menu-horizontal" />
                    </template>
                  </NButton>
                </NDropdown>
              </div>

              <span class="friend-chevron i-carbon-chevron-down" aria-hidden="true" />
            </div>

            <div v-if="expandedFriends.has(String(friend.gid))" class="friend-lands">
              <div class="mb-3 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 text-sm text-gray-700 font-semibold dark:text-gray-200">
                  <span class="i-carbon-sprout" />
                  土地详情
                </div>
                <NButton
                  size="small"
                  secondary
                  :loading="!!friendLandsLoading[friend.gid]"
                  :disabled="!currentAccountId"
                  @click="refreshFriendLands(friend.gid)"
                >
                  <template #icon>
                    <span class="i-carbon-renew" />
                  </template>
                  刷新土地
                </NButton>
              </div>
              <div v-if="friendLandsLoading[friend.gid]" class="flex justify-center py-6">
                <div class="i-svg-spinners-90-ring-with-bg text-2xl text-green-600" />
              </div>
              <EmptyState v-else-if="friendLandsError[friend.gid]" bare tone="error" title="土地读取失败" :description="friendLandsError[friend.gid]" icon="i-carbon-warning-alt">
                <NButton size="small" secondary @click="refreshFriendLands(friend.gid)">
                  重新读取
                </NButton>
              </EmptyState>
              <EmptyState v-else-if="!friendLandsLoaded[friend.gid]" bare title="尚未读取土地" icon="i-carbon-data-view-alt">
                <NButton size="small" secondary @click="refreshFriendLands(friend.gid)">
                  读取土地
                </NButton>
              </EmptyState>
              <template v-else>
                <div
                  v-if="friendCareer[friend.gid]"
                  class="mb-3 flex flex-wrap gap-x-5 gap-y-2 text-sm"
                >
                  <CareerHarvestSteal :career="friendCareer[friend.gid]" />
                </div>
                <div class="mb-3 border border-amber-200 rounded-xl bg-amber-50/80 p-3 dark:border-amber-800 dark:bg-amber-950/25">
                  <div v-if="interactionItemsLoading" class="flex items-center justify-center gap-2 py-2 text-sm text-amber-700 dark:text-amber-300">
                    <span class="i-svg-spinners-90-ring-with-bg" />
                    正在读取特殊互动道具
                  </div>
                  <div v-else-if="interactionItemsError" class="flex flex-wrap items-center justify-between gap-2 text-sm text-red-600 dark:text-red-300">
                    <span>{{ interactionItemsError }}</span>
                    <NButton size="small" secondary type="error" @click="currentAccountId && friendStore.fetchInteractionItems(currentAccountId)">
                      重新读取
                    </NButton>
                  </div>
                  <template v-else-if="interactionItems.length > 0">
                    <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div class="min-w-0 flex-1">
                        <div class="mb-2 flex items-center gap-2 text-sm text-amber-950 font-bold dark:text-amber-100">
                          <span class="i-carbon-game-console" />
                          特殊互动道具
                          <span class="text-xs text-amber-700 font-normal dark:text-amber-300">普通种草、放虫仍由“捣乱”自动化处理</span>
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
                            @click="toggleInteractionItem(item.itemId)"
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
                        <NButton v-if="selectedInteractionItem?.targetKind !== 'farm'" size="small" secondary :disabled="!selectedInteractionItem || interactionUsePending" @click="selectAllInteractionLands(friend.gid)">
                          全选可用
                        </NButton>
                        <NButton v-if="selectedInteractionItem?.targetKind !== 'farm'" size="small" secondary :disabled="selectedInteractionIds(friend.gid).length === 0 || interactionUsePending" @click="setSelectedInteractionIds(friend.gid, [])">
                          清空
                        </NButton>
                        <NButton v-if="selectedInteractionItem?.targetKind !== 'farm'" type="warning" size="small" :loading="interactionUsePending" :disabled="!selectedInteractionItem || selectedInteractionIds(friend.gid).length === 0" @click="requestUseInteractionItem(friend)">
                          按顺序使用 {{ selectedInteractionIds(friend.gid).length || '' }} 个
                        </NButton>
                        <NButton v-else type="warning" size="small" :loading="interactionUsePending" :disabled="!selectedInteractionItem || selectedInteractionItem.count < 1" @click="requestUseFarmInteractionItem(friend)">
                          在此农场使用
                        </NButton>
                      </div>
                    </div>
                    <div v-if="interactionFailures(friend.gid).length > 0" class="mt-3 rounded-lg bg-white/75 px-3 py-2 text-xs text-red-700 dark:bg-gray-900/60 dark:text-red-300">
                      <div class="mb-1 font-semibold">
                        未成功的地块
                      </div>
                      <div v-for="result in interactionFailures(friend.gid)" :key="`${result.landId}:${result.message}`">
                        第 {{ result.landId }} 块：{{ result.message }}
                      </div>
                    </div>
                  </template>
                  <div v-else class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span class="i-carbon-information" />
                    背包中暂无可用于好友土地的特殊互动道具。
                  </div>
                </div>

                <div v-if="selectedInteractionItem?.targetKind === 'farm'" class="py-4 text-center text-gray-500">
                  当前道具作用于好友农场整体，无需选择地块
                </div>
                <div v-else-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0" class="py-4 text-center text-gray-500">
                  该好友当前没有可展示的土地
                </div>
                <div v-else class="grid grid-cols-2 gap-2 lg:grid-cols-8 md:grid-cols-5 sm:grid-cols-4">
                  <LandCard
                    v-for="land in friendLands[friend.gid]"
                    :key="land.id"
                    :land="land"
                    :selectable="!!selectedInteractionItem"
                    :selected="isInteractionLandSelected(friend.gid, land)"
                    :selection-disabled="isInteractionLandDisabled(friend.gid, land)"
                    :selection-label="interactionLandSelectionLabel(friend.gid, land)"
                    @select="toggleInteractionLand(friend.gid, land)"
                  />
                </div>
              </template>
            </div>
          </div>

          <!-- 分页控件 -->
          <div v-if="filteredFriends.length > pageSize" class="mt-4 flex flex-wrap items-center justify-center gap-2">
            <NPagination v-model:page="currentPage" :page-count="totalPages" />
            <span class="text-sm text-gray-500 dark:text-gray-400">
              共 {{ filteredFriends.length }} 位好友
            </span>
          </div>
        </template>
      </div>

      <div v-else-if="activeTab === 'blacklist'" class="space-y-4">
        <div class="farm-card rounded-2xl bg-white p-4 shadow-md dark:bg-gray-800">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            加入黑名单的好友在自动偷菜和帮助时会被跳过。游戏内删除好友后也会自动加入这里。
          </p>
        </div>

        <div v-if="blacklist.length === 0" class="farm-card rounded-2xl bg-white p-8 text-center text-gray-500 shadow-md dark:bg-gray-800">
          <div class="i-carbon-user-x-ray mx-auto mb-3 text-4xl text-gray-300" />
          暂无黑名单好友
        </div>

        <div v-else class="space-y-2">
          <div
            v-for="item in blacklist"
            :key="item.gid"
            class="flex items-center justify-between cartoon-card rounded-2xl bg-white p-4 shadow-md dark:bg-gray-800"
          >
            <div class="flex items-center gap-3">
              <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                <img
                  v-if="item.avatarUrl"
                  :src="item.avatarUrl"
                  class="h-full w-full object-cover"
                  loading="lazy"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                >
                <span v-else class="i-carbon-user text-gray-400" />
              </div>
              <div>
                <span class="font-medium">{{ item.name || `GID:${item.gid}` }}</span>
                <span class="ml-2 text-sm text-gray-400">({{ item.gid }})</span>
              </div>
            </div>
            <NButton
              type="error"
              secondary
              size="small"
              @click="handleRemoveFromBlacklist(item.gid)"
            >
              移出黑名单
            </NButton>
          </div>
        </div>
      </div>

      <div v-else-if="activeTab === 'visitors'" class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <NButtonGroup size="small">
            <NButton
              v-for="item in interactFilters"
              :key="item.key"
              :type="interactFilter === item.key ? 'primary' : 'default'"
              @click="interactFilter = item.key"
            >
              {{ item.label }}
            </NButton>
          </NButtonGroup>
          <BaseButton
            variant="secondary"
            size="sm"
            :loading="interactLoading"
            @click="refreshInteractRecords"
          >
            刷新
          </BaseButton>
        </div>

        <div v-if="!!interactError" class="rounded-lg bg-red-50 px-4 py-6 text-center text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
          {{ interactError }}
        </div>

        <div v-else-if="visibleInteractRecords.length === 0" class="farm-card rounded-2xl bg-white p-8 text-center text-gray-500 shadow-md dark:bg-gray-800">
          <div class="mx-auto mb-3 text-4xl text-gray-300">
            👀
          </div>
          暂无访客记录
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="record in visibleInteractRecords"
            :key="record.key"
            class="flex items-start gap-3 cartoon-card rounded-2xl bg-white p-4 shadow-md dark:bg-gray-800"
          >
            <div class="h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-700 dark:ring-gray-600">
              <img
                v-if="canShowInteractAvatar(record)"
                :src="getInteractAvatar(record)"
                class="h-full w-full object-cover"
                loading="lazy"
                @error="handleInteractAvatarError(record)"
              >
              <span v-else class="i-carbon-user text-xl text-gray-400" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-2">
                <span class="max-w-full truncate text-base text-gray-800 font-medium dark:text-gray-100">
                  {{ record.nick || `GID:${record.visitorGid}` }}
                </span>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="getInteractBadgeClass(record.actionType)"
                >
                  {{ record.actionLabel }}
                </span>
                <span v-if="record.level" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  Lv.{{ record.level }}
                </span>
                <span v-if="record.visitorGid" class="text-xs text-gray-400">
                  GID {{ record.visitorGid }}
                </span>
              </div>
              <div class="text-sm text-gray-600 dark:text-gray-300">
                {{ record.actionDetail || record.actionLabel }}
              </div>
            </div>
            <div class="shrink-0 text-right text-xs text-gray-400">
              {{ formatInteractTime(record.serverTimeMs) }}
            </div>
          </div>

          <div v-if="filteredInteractRecords.length > visibleInteractRecords.length" class="text-center text-xs text-gray-400">
            仅展示最近 {{ visibleInteractRecords.length }} 条
          </div>
        </div>
      </div>
    </template>

    <ConfirmModal
      :show="showConfirm"
      :loading="confirmLoading"
      title="确认操作"
      :message="confirmMessage"
      @confirm="onConfirm"
      @cancel="!confirmLoading && (showConfirm = false)"
    />

    <NModal :show="showBatchAddGidModal" @update:show="showBatchAddGidModal = $event">
      <NCard class="gid-entry-card" title="批量新增 GID" :bordered="false" closable @close="showBatchAddGidModal = false">
        <p class="mb-3 mt-0 text-sm text-gray-500 dark:text-gray-400">
          支持一行一个或用逗号、空格分隔，提交时自动去重。
        </p>
        <BaseTextarea
          v-model="batchGidInput"
          :rows="8"
          placeholder="每行一个 GID，或用逗号、空格分隔"
        />
        <template #footer>
          <div class="flex justify-end gap-2">
            <BaseButton variant="secondary" @click="showBatchAddGidModal = false">
              取消
            </BaseButton>
            <BaseButton
              variant="primary"
              :loading="knownFriendSettingsSaving"
              :disabled="!batchGidInput.trim()"
              @click="handleBatchAddKnownFriendGids"
            >
              确认添加
            </BaseButton>
          </div>
        </template>
      </NCard>
    </NModal>

    <NModal :show="showGidListModal" @update:show="showGidListModal = $event">
      <NCard class="gid-list-card" title="已导入的 GID" :bordered="false" closable @close="showGidListModal = false">
        <p class="mt-0 text-sm text-gray-500 dark:text-gray-400">
          共 {{ knownFriendGidCount }} 个，已同步 {{ syncedGidCount }} 个，未同步 {{ unsyncedGidCount }} 个。
        </p>
        <div class="mb-4 flex gap-2">
          <BaseInput v-model="gidSearchKeyword" placeholder="搜索 GID..." clearable class="flex-1" />
          <BaseButton
            variant="danger"
            :loading="knownFriendSettingsSaving"
            :disabled="unsyncedGidCount === 0"
            @click="handleRemoveUnsyncedGids"
          >
            删除未同步（{{ unsyncedGidCount }}）
          </BaseButton>
        </div>
        <div class="gid-list-scroll">
          <div v-if="filteredKnownFriendGids.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            暂无数据
          </div>
          <div v-else class="grid gap-2 lg:grid-cols-3 sm:grid-cols-2">
            <div
              v-for="item in filteredKnownFriendGids"
              :key="item.gid"
              class="flex items-center justify-between border rounded-lg p-2"
              :class="item.synced
                ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
                : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'"
            >
              <div class="min-w-0">
                <div class="truncate text-sm font-mono">
                  {{ item.gid }}
                </div>
                <div class="text-xs" :class="item.synced ? 'text-green-600' : 'text-red-600'">
                  {{ item.synced ? '已同步' : '未同步' }}
                </div>
              </div>
              <NButton
                quaternary
                circle
                type="error"
                size="small"
                :disabled="knownFriendSettingsSaving"
                aria-label="删除 GID"
                @click="handleRemoveGidFromList(item.gid)"
              >
                <span class="i-carbon-trash-can" />
              </NButton>
            </div>
          </div>
        </div>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.friends-toolbar {
  flex-wrap: nowrap;
}

.friends-search {
  width: 16rem;
}

/* 好友条目 */
.friend-card {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
  transition: border-color 0.15s ease;
}

.friend-card.is-expanded {
  border-color: color-mix(in srgb, var(--ui-primary) 32%, var(--ui-border));
}

.friend-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto 20px;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.friend-row:hover {
  background: color-mix(in srgb, var(--ui-surface-soft) 60%, transparent);
}

.friend-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ui-primary) 55%, transparent);
  outline-offset: -2px;
}

.friend-card.is-blocked .friend-avatar,
.friend-card.is-blocked .friend-main {
  opacity: 0.5;
}

.friend-avatar {
  width: 44px;
  height: 44px;
  display: grid;
  overflow: hidden;
  place-items: center;
  border-radius: 14px;
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
  font-size: 20px;
}

.friend-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.friend-main {
  min-width: 0;
}

.friend-name-row {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.friend-name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.friend-gid {
  flex: none;
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.friend-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

/* 标签统一规格：中性信息用灰底，可操作状态用各自的颜色。 */
.f-tag {
  height: 22px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.f-tag img {
  width: 14px;
  height: 14px;
  object-fit: contain;
}

.f-tag > span {
  font-size: 12px;
}

.f-tag--level {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.f-tag--pet-unknown {
  color: var(--ui-subtle);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--ui-border);
}

.f-tag--pet-protect {
  color: var(--ui-violet);
  background: var(--ui-violet-soft);
}

.f-tag--gold {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.f-tag--blocked {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.f-tag--steal {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
}

.f-tag--water {
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
  font-weight: var(--fw-600);
}

.f-tag--weed {
  color: #8a6b1f;
  background: var(--ui-warning-soft);
  font-weight: var(--fw-600);
}

.f-tag--bug {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-weight: var(--fw-600);
}

.dark .f-tag--weed {
  color: #e2c36d;
}

.friend-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.friend-chevron {
  justify-self: end;
  color: var(--ui-subtle);
  font-size: 16px;
  transition: transform 0.2s ease;
}

.friend-card.is-expanded .friend-chevron {
  transform: rotate(180deg);
}

.friend-lands {
  padding: 16px;
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-surface-soft) 55%, transparent);
}

@media (max-width: 767px) {
  .friend-row {
    grid-template-columns: 40px minmax(0, 1fr) 20px;
    gap: 10px 12px;
    padding: 12px;
  }

  .friend-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
  }

  .friend-chevron {
    grid-row: 1;
    grid-column: 3;
  }

  /* 手机端操作单独一行，三个常用操作等宽，更多菜单收在末尾。 */
  .friend-actions {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .friend-actions > .n-button:not(.n-button--circle) {
    flex: 1 1 0;
    min-width: 0;
  }

  .friend-lands {
    padding: 12px;
  }

  .friends-toolbar {
    width: 100%;
  }

  .friends-search {
    flex: 1;
    width: auto;
  }
}

.gid-entry-card {
  width: min(520px, calc(100vw - 32px));
}

.gid-list-card {
  width: min(760px, calc(100vw - 32px));
}

.gid-list-scroll {
  max-height: min(56vh, 520px);
  overflow-y: auto;
}
</style>
