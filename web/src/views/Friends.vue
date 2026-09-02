<script setup lang="ts">
import type { FriendInteractionItemDto, FriendInteractionResultDto } from '@/stores/friend'
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NButtonGroup } from 'naive-ui/es/button-group'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NPagination } from 'naive-ui/es/pagination'
import { NSpin } from 'naive-ui/es/spin'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'
import { useFriendStore } from '@/stores/friend'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { interactionItemTargetReason } from '@/utils/interaction-item-rules'

const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const friendStore = useFriendStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const route = useRoute()
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
const {
  qixi,
  pendingActions: activityPendingActions,
  actionError: activityActionError,
  notice: activityNotice,
} = storeToRefs(activityStore)
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
}

const TABS = [
  { key: 'friends', label: '好友列表', icon: 'i-carbon-user-multiple' },
  { key: 'blacklist', label: '好友黑名单', icon: 'i-carbon-rule-cancelled' },
  { key: 'visitors', label: '最近访客', icon: 'i-carbon-recently-viewed' },
] as const

type TabKey = typeof TABS[number]['key']

const activeTab = ref<TabKey>('friends')

function setActiveTab(value: string) {
  if (TABS.some(tab => tab.key === value))
    activeTab.value = value as TabKey
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
      toast.error(e?.message || '操作失败')
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
const clockNow = ref(Date.now())
const currentPage = ref(1)
const pageSize = 25

const qixiGiftActive = computed(() => {
  const activity = qixi.value
  if (!activity?.active)
    return false
  return !activity.endTime || clockNow.value < activity.endTime
})
const qixiSachetBalance = computed(() => {
  const value = Number(qixi.value?.balances.sachet || 0)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
})

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

function giftQixiSachetToFriend(friend: any, event: Event) {
  event.stopPropagation()
  if (!currentAccountId.value || !qixiGiftActive.value || qixiSachetBalance.value < 1)
    return
  const gid = friendKey(friend?.gid)
  const name = String(friend?.name || `GID ${gid}`)
  confirmAction(`确定向 ${name} 赠送 1 个鹊羽香囊吗？`, async () => {
    const result = await activityStore.giftQixiSachet(currentAccountId.value!, gid)
    if (!result)
      throw new Error(activityActionError.value || '鹊羽香囊赠送失败')
    toast.success(activityNotice.value || `已向 ${name} 赠送 1 个鹊羽香囊`)
    return result
  })
}

async function loadData() {
  const accountId = currentAccountId.value
  if (!accountId || !currentAccountRunning.value)
    return

  avatarErrorKeys.value.clear()
  // 登录后的好友页先读 Worker 缓存，再同步主列表，避免一次性向同一账号 Worker 发起多路 RPC。
  await Promise.allSettled([
    friendStore.fetchFriendsCache(accountId),
    friendStore.fetchBlacklist(accountId),
  ])
  await new Promise(resolve => window.setTimeout(resolve, 250))
  await friendStore.fetchFriends(accountId)
  await new Promise(resolve => window.setTimeout(resolve, 250))
  await Promise.allSettled([
    friendStore.fetchInteractRecords(accountId),
    friendStore.fetchInteractionItems(accountId),
  ])
  await new Promise(resolve => window.setTimeout(resolve, 250))
  const backgroundRequests: Promise<unknown>[] = [activityStore.lazyLoad(accountId)]
  if (isQqAccount.value)
    backgroundRequests.push(friendStore.fetchKnownFriendSettings(accountId))
  await Promise.allSettled(backgroundRequests)
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
  clockNow.value = Date.now()
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
  friendStore.resetInteractionState()
  friendStore.resetFriendLandState()
})

watch([currentAccountId, () => currentAccount.value?.running, currentAccountConnected], () => {
  void loadData()
}, { immediate: true })

watch(interactionItems, (items) => {
  const requestedItemId = String(route.query.interactionItem || '')
  if (requestedItemId && items.some(item => String(item.itemId) === requestedItemId)) {
    selectedInteractionItemId.value = requestedItemId
    return
  }
  if (!items.some(item => String(item.itemId) === selectedInteractionItemId.value))
    selectedInteractionItemId.value = String(items[0]?.itemId || '')
}, { immediate: true })

watch(qixiGiftActive, (active) => {
  if (!active)
    activityActionError.value = ''
})

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

function getFriendStatusText(friend: any) {
  const p = friend.plant || {}
  const info = []
  if (p.stealNum)
    info.push(`偷${p.stealNum}`)
  if (p.dryNum)
    info.push(`水${p.dryNum}`)
  if (p.weedNum)
    info.push(`草${p.weedNum}`)
  if (p.insectNum)
    info.push(`虫${p.insectNum}`)
  return info.length ? info.join(' ') : '无操作'
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
    <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-bold font-display">
        <span class="i-carbon-user-multiple" />
        好友
      </h2>
      <div class="flex items-center gap-3">
        <div v-if="activeTab === 'friends'">
          <BaseInput
            v-model="searchKeyword"
            placeholder="搜索好友..."
            clearable
            class="w-full sm:w-64"
          />
        </div>
        <div v-if="activeTab === 'friends' && friends.length" class="text-sm text-gray-500">
          共 {{ filteredFriends.length }}/{{ friends.length }} 名好友
        </div>
        <div v-if="activeTab === 'blacklist'" class="text-sm text-gray-500">
          共 {{ blacklist.length }} 人
        </div>
        <div v-if="activeTab === 'visitors' && interactRecords.length" class="text-sm text-gray-500">
          共 {{ filteredInteractRecords.length }}/{{ interactRecords.length }} 条记录
        </div>
      </div>
    </div>

    <NTabs class="mb-4" :value="activeTab" type="line" @update:value="setActiveTab">
      <NTab v-for="tab in TABS" :key="tab.key" :name="tab.key">
        <span class="inline-flex items-center gap-2">
          <span :class="tab.icon" />
          {{ tab.label }}
          <span v-if="tab.key === 'blacklist' && blacklist.length > 0" class="text-xs text-red-500">
            {{ blacklist.length }}
          </span>
        </span>
      </NTab>
    </NTabs>

    <div v-if="loading || interactLoading" class="flex justify-center py-12">
      <NSpin size="large" />
    </div>

    <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 farm-card rounded-2xl bg-white p-12 text-center text-gray-500 shadow-md dark:bg-gray-800">
      <span class="i-carbon-user-avatar text-4xl text-gray-400" />
      <div>
        <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
          未登录账号
        </div>
        <div class="mt-1 text-sm text-gray-400">
          请先添加农场账号
        </div>
      </div>
    </div>

    <div v-else-if="!currentAccountRunning" class="flex flex-col items-center justify-center gap-4 farm-card rounded-2xl bg-white p-12 text-center text-gray-500 shadow-md dark:bg-gray-800">
      <span class="i-carbon-network-4 text-4xl text-gray-400" />
      <div>
        <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
          账号未运行
        </div>
        <div class="mt-1 text-sm text-gray-400">
          请先启动账号；启动后土地请求的具体连接错误会在好友卡片中显示
        </div>
      </div>
    </div>

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
          <div class="flex flex-wrap items-center gap-2 farm-card rounded-2xl bg-white p-3 shadow-md dark:bg-gray-800">
            <div class="flex-1" />
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="loading"
              @click="handleRefreshFriends"
            >
              刷新列表
            </BaseButton>
          </div>

          <div
            v-for="friend in paginatedFriends"
            :key="friend.gid"
            class="overflow-hidden cartoon-card rounded-2xl bg-white shadow-md dark:bg-gray-800"
          >
            <div
              class="flex flex-col cursor-pointer justify-between gap-4 p-4 transition sm:flex-row sm:items-center hover:bg-gray-50 dark:hover:bg-gray-700/50"
              :class="blacklistGidSet.has(Number(friend.gid)) ? 'opacity-50' : ''"
              @click="toggleFriend(friend.gid)"
            >
              <div class="flex items-center gap-3">
                <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                  <img
                    v-if="canShowFriendAvatar(friend)"
                    :src="getFriendAvatar(friend)"
                    class="h-full w-full object-cover"
                    loading="lazy"
                    @error="handleFriendAvatarError(friend)"
                  >
                  <span v-else class="i-carbon-user text-gray-400" />
                </div>
                <div>
                  <div class="flex items-center gap-2 font-bold">
                    {{ friend.name }} ({{ friend.gid }})

                    <span v-if="blacklistGidSet.has(Number(friend.gid))" class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">已屏蔽</span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span
                      v-if="getFriendLevel(friend) > 0"
                      class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
                    >
                      Lv.{{ getFriendLevel(friend) }}
                    </span>
                    <span
                      v-if="getFriendGold(friend) > 0"
                      class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
                    >
                      金币 {{ formatFriendGold(friend.gold) }}
                    </span>

                    <span
                      class="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                      :class="friendPetBadge(friend).class"
                      :title="friendPetBadge(friend).title"
                    >
                      <img
                        v-if="friendPetBadge(friend).image"
                        :src="friendPetBadge(friend).image"
                        class="h-3.5 w-3.5 object-contain"
                        alt=""
                        loading="lazy"
                      >
                      {{ friendPetBadge(friend).text }}
                    </span>
                  </div>
                  <div class="text-sm" :class="getFriendStatusText(friend) !== '无操作' ? 'text-green-500 font-medium' : 'text-gray-400'">
                    <span v-if="getFriendStatusText(friend) !== '无操作'" class="farm-badge inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-600 dark:bg-green-900/20 dark:text-green-400">
                      {{ getFriendStatusText(friend) }}
                    </span>
                    <span v-else>{{ getFriendStatusText(friend) }}</span>
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                <NButton
                  v-if="qixiGiftActive"
                  type="warning"
                  secondary
                  size="small"
                  :disabled="activityPendingActions.giftQixiSachet || qixiSachetBalance < 1"
                  @click="giftQixiSachetToFriend(friend, $event)"
                >
                  <span class="i-carbon-gift mr-1" />
                  赠香囊 {{ qixiSachetBalance }}
                </NButton>
                <NButton
                  type="info"
                  secondary
                  size="small"
                  @click="handleOp(friend.gid, 'steal', $event)"
                >
                  偷取
                </NButton>
                <NButton
                  type="success"
                  secondary
                  size="small"
                  @click="handleOp(friend.gid, 'farming', $event)"
                >
                  一键务农
                </NButton>
                <NButton
                  type="error"
                  secondary
                  size="small"
                  @click="handleOp(friend.gid, 'bad', $event)"
                >
                  捣乱
                </NButton>
                <NButton
                  secondary
                  size="small"
                  @click="handleToggleBlacklist(friend, $event)"
                >
                  {{ blacklistGidSet.has(Number(friend.gid)) ? '移出黑名单' : '加入黑名单' }}
                </NButton>
                <NButton
                  type="error"
                  secondary
                  size="small"
                  :disabled="!currentAccountRunning"
                  @click="handleDeleteFriend(friend, $event)"
                >
                  删除好友
                </NButton>
                <NButton
                  v-if="isQqAccount && knownFriendGidSet.has(Number(friend.gid))"
                  type="warning"
                  secondary
                  size="small"
                  @click="handleRemoveKnownFriendGid(friend, $event)"
                >
                  移出同步列表
                </NButton>
              </div>
            </div>

            <div v-if="expandedFriends.has(String(friend.gid))" class="border-t bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
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
                  <span class="i-carbon-renew mr-1" />
                  刷新土地
                </NButton>
              </div>
              <div v-if="friendLandsLoading[friend.gid]" class="flex justify-center py-4">
                <div class="i-svg-spinners-90-ring-with-bg text-2xl text-blue-500" />
              </div>
              <div v-else-if="friendLandsError[friend.gid]" class="flex flex-col items-center gap-2 py-5 text-center text-red-600 dark:text-red-300">
                <span class="i-carbon-warning-alt text-2xl" />
                <span>{{ friendLandsError[friend.gid] }}</span>
                <NButton size="small" secondary type="error" @click="refreshFriendLands(friend.gid)">
                  重新读取
                </NButton>
              </div>
              <div v-else-if="!friendLandsLoaded[friend.gid]" class="flex flex-col items-center gap-2 py-5 text-center text-gray-500 dark:text-gray-400">
                <span class="i-carbon-data-view-alt text-2xl" />
                <span>尚未读取该好友土地</span>
                <NButton size="small" secondary @click="refreshFriendLands(friend.gid)">
                  读取土地
                </NButton>
              </div>
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
