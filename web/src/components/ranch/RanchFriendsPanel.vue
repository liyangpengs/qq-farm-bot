<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import { formatCount, RANCH_IMAGE, useRanchActions } from '@/components/ranch/ranch-shared'
import RanchAmountDialog from '@/components/ranch/RanchAmountDialog.vue'
import RanchAnimalCard from '@/components/ranch/RanchAnimalCard.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useToastStore } from '@/stores/toast'

const ranch = useRanchStore()
const { state, loading, error } = storeToRefs(ranch)
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const { disabled, request } = useRanchActions()

const friends = ref<any[]>([])
const listLoaded = ref(false)
const expandedGids = ref<Record<string, boolean>>({})
const detailsByGid = ref<Record<string, any>>({})
const errorsByGid = ref<Record<string, string>>({})
const loadingGid = ref('')
const grassDialogGid = ref('')
const query = ref('')
const failedAvatars = ref<Record<string, boolean>>({})
const showBlacklist = ref(false)
const blacklistGids = ref<number[]>([])
const blacklistLoading = ref(false)
const blacklistSaving = ref(false)
const blacklistError = ref('')
const blacklistBusy = computed(() => blacklistLoading.value || blacklistSaving.value)
const blacklistedSet = computed(() => new Set(blacklistGids.value))
let blacklistRequest = 0
let alive = true
onBeforeUnmount(() => alive = false)

function isCurrentBlacklist(id: string, request: number) {
  return alive && id === String(currentAccountId.value || '') && request === blacklistRequest
}

async function loadBlacklist() {
  const id = String(currentAccountId.value || '')
  if (!id || blacklistBusy.value)
    return
  const request = ++blacklistRequest
  blacklistLoading.value = true
  blacklistError.value = ''
  try {
    const { data } = await api.get('/api/ranch-friend-blacklist', { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
    if (!isCurrentBlacklist(id, request))
      return
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '牧场黑名单读取失败'))
    blacklistGids.value = data.data.gids
  }
  catch (cause) {
    if (isCurrentBlacklist(id, request))
      blacklistError.value = getApiErrorMessage(cause, '牧场黑名单读取失败')
  }
  finally {
    if (isCurrentBlacklist(id, request))
      blacklistLoading.value = false
  }
}

async function toggleBlacklist(gid: string | number) {
  const id = String(currentAccountId.value || '')
  if (!id || blacklistBusy.value || blacklistError.value)
    return
  const request = ++blacklistRequest
  blacklistSaving.value = true
  try {
    const blacklisted = !blacklistedSet.value.has(Number(gid))
    const { data } = await api.post('/api/ranch-friend-blacklist/toggle', { gid: Number(gid), blacklisted }, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
    if (!isCurrentBlacklist(id, request))
      return
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '牧场黑名单保存失败'))
    blacklistGids.value = data.data.gids
    toast.success(data.data.blacklisted ? '已加入牧场黑名单' : '已移出牧场黑名单')
  }
  catch (cause) {
    if (isCurrentBlacklist(id, request))
      toast.error(getApiErrorMessage(cause, '牧场黑名单保存失败'))
  }
  finally {
    if (isCurrentBlacklist(id, request))
      blacklistSaving.value = false
  }
}

function toggleBlacklistView() {
  showBlacklist.value = !showBlacklist.value
  if (showBlacklist.value)
    void loadBlacklist()
}

/** 黑名单视图条目：好友列表里能对上的补名称/头像，纯 GID 的兜底展示。 */
const blacklistItems = computed(() => blacklistGids.value.map((gid) => {
  const friend = friends.value.find(f => Number(f.gid) === gid) || state.value?.friends?.find((f: any) => Number(f.gid) === gid)
  return { gid, name: friend?.name || `GID:${gid}`, avatarUrl: friend?.avatarUrl || '' }
}))

watch(blacklistGids, (gids) => {
  for (const gid of gids)
    collapseFriend(String(gid))
})

function detailOf(gid: unknown) {
  return detailsByGid.value[String(gid ?? '')] ?? null
}

function grassAvailableOf(friendDetail: any) {
  return friendDetail?.grassAvailable ?? '0'
}

function grassRoomOf(friendDetail: any) {
  return friendDetail?.feedMachine ? friendDetail.feedMachine.capacity - friendDetail.feedMachine.count : 0
}

function grassLimitOf(friendDetail: any) {
  return Math.max(0, Math.min(Number(grassAvailableOf(friendDetail)), grassRoomOf(friendDetail)))
}

function detailShelvesOf(friendDetail: any) {
  return (friendDetail?.ranches || []).flatMap((r: any) =>
    (r.shelves || []).map((s: any) => ({ ...s, key: `${r.id}:${s.slot}` })),
  )
}

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return keyword
    ? friends.value.filter(f => String(f.name || '').toLowerCase().includes(keyword) || String(f.gid).includes(keyword))
    : friends.value
})

const visibleEntries = computed(() => visible.value.map((friend) => {
  const gid = String(friend.gid ?? '')
  const detail = detailOf(gid)
  const blacklisted = blacklistedSet.value.has(Number(gid))
  return {
    friend,
    gid,
    expanded: !blacklisted && Boolean(expandedGids.value[gid]),
    blacklisted,
    detail,
    error: errorsByGid.value[gid] || '',
    shelves: detail ? detailShelvesOf(detail) : [],
    grassAvailable: grassAvailableOf(detail),
    grassRoom: grassRoomOf(detail),
    grassLimit: grassLimitOf(detail),
  }
}))

const expandedCount = computed(() => Object.keys(expandedGids.value).length)
const grassDialogDetail = computed(() => grassDialogGid.value ? detailOf(grassDialogGid.value) : null)
const grassDialogMachine = computed(() => grassDialogDetail.value?.feedMachine ?? null)
const grassDialogAvailable = computed(() => grassAvailableOf(grassDialogDetail.value))
const grassDialogLimit = computed(() => grassLimitOf(grassDialogDetail.value))

function resetExpandedState() {
  expandedGids.value = {}
  detailsByGid.value = {}
  errorsByGid.value = {}
  loadingGid.value = ''
  grassDialogGid.value = ''
}

watch(() => state.value?.friendRanch, (live) => {
  if (!live?.gid)
    return
  const liveGid = String(live.gid)
  const nextDetails: Record<string, any> = {}
  for (const [gid, cached] of Object.entries(detailsByGid.value)) {
    if (gid === liveGid || !cached)
      continue
    nextDetails[gid] = {
      ...cached,
      strokeRemaining: live.strokeRemaining,
      mosquitoRemaining: live.mosquitoRemaining,
      grassAvailable: live.grassAvailable,
      ranches: Array.isArray(cached.ranches)
        ? cached.ranches.map((pen: any) => ({
            ...pen,
            animals: Array.isArray(pen.animals)
              ? pen.animals.map((animal: any) => ({
                  ...animal,
                  canStroke: live.strokeRemaining > 0 && Boolean(animal.mutation?.canStroke) && !animal.stroked,
                }))
              : pen.animals,
          }))
        : cached.ranches,
    }
  }
  nextDetails[liveGid] = live
  detailsByGid.value = nextDetails

  if (errorsByGid.value[liveGid]) {
    const nextErrors = { ...errorsByGid.value }
    delete nextErrors[liveGid]
    errorsByGid.value = nextErrors
  }

  const friend = friends.value.find(entry => String(entry.gid) === liveGid)
  if (friend) {
    friend.canHelp = live.cleanableHazards > 0
    friend.helpCount = live.cleanableHazards
    friend.canSteal = live.canSteal
  }
})

async function loadList(id: string) {
  await ranch.load(id, 'friends')
  if (id === String(currentAccountId.value || '') && state.value?.friends) {
    friends.value = state.value.friends
    listLoaded.value = true
  }
}

// 打开面板即满足“打开好友面板”任务条件：先静默上报，再读取好友列表。
async function enter(id: string) {
  const current = () => alive && id === String(currentAccountId.value || '')
  ranch.reset(id)
  await nextTick()
  if (!current())
    return
  const quote = await ranch.quote(id, 'reportEntry', { entry: 'friends' })
  if (quote && !quote.skipped && current())
    await ranch.execute(id, 'reportEntry', { entry: 'friends' }, quote.expected, { quiet: true })
  if (!current())
    return
  const reportError = error.value
  await loadList(id)
  if (current() && reportError && !error.value && state.value?.unlocked)
    error.value = reportError
}

watch(currentAccountId, (id) => {
  resetExpandedState()
  friends.value = []
  listLoaded.value = false
  showBlacklist.value = false
  blacklistRequest++
  blacklistGids.value = []
  blacklistError.value = ''
  blacklistLoading.value = false
  blacklistSaving.value = false
  void loadBlacklist()
  if (id)
    void enter(String(id))
  else ranch.reset()
}, { immediate: true })

async function fetchFriendDetail(id: string, gid: string) {
  loadingGid.value = gid
  if (errorsByGid.value[gid]) {
    const nextErrors = { ...errorsByGid.value }
    delete nextErrors[gid]
    errorsByGid.value = nextErrors
  }
  try {
    await ranch.load(id, 'friends', undefined, gid)
    if (!alive || id !== String(currentAccountId.value || ''))
      return
    if (!detailsByGid.value[gid] && error.value)
      errorsByGid.value = { ...errorsByGid.value, [gid]: error.value }
  }
  finally {
    if (loadingGid.value === gid)
      loadingGid.value = ''
  }
}

function collapseFriend(gid: string) {
  if (expandedGids.value[gid]) {
    const nextExpanded = { ...expandedGids.value }
    delete nextExpanded[gid]
    expandedGids.value = nextExpanded
  }
  if (grassDialogGid.value === gid)
    grassDialogGid.value = ''
}

async function toggle(friend: any, event: Event) {
  const gid = String(friend.gid ?? '')
  const id = String(currentAccountId.value || '')
  if (!id || !gid || disabled.value || blacklistedSet.value.has(Number(gid)))
    return
  if (expandedGids.value[gid]) {
    collapseFriend(gid)
    return
  }
  const scrollEl = (event.currentTarget as HTMLElement).closest<HTMLElement>('.page-scroll')
  const savedTop = scrollEl?.scrollTop
  expandedGids.value = { ...expandedGids.value, [gid]: true }
  await nextTick()
  if (scrollEl && savedTop !== undefined && scrollEl.scrollTop !== savedTop)
    scrollEl.scrollTop = savedTop
  await fetchFriendDetail(id, gid)
}

async function refreshFriend(gid: string) {
  const id = String(currentAccountId.value || '')
  if (!id || !gid || disabled.value)
    return
  await fetchFriendDetail(id, gid)
}

function collapseAll() {
  expandedGids.value = {}
  grassDialogGid.value = ''
}

function openGrassDialog(gid: string) {
  grassDialogGid.value = gid
}

function submitGrass(count: number) {
  const targetDetail = grassDialogDetail.value
  const machine = grassDialogMachine.value
  grassDialogGid.value = ''
  if (targetDetail && machine) {
    void request('addGrass', { hostGid: targetDetail.gid, facilityId: machine.id, count }, {
      costItems: [{ id: 7001, count: String(count) }],
      rewards: [],
    })
  }
}

async function reloadList() {
  const id = String(currentAccountId.value || '')
  if (id && !disabled.value) {
    resetExpandedState()
    void loadBlacklist()
    await loadList(id)
  }
}
</script>

<template>
  <div class="friends">
    <div class="page-toolbar !mb-0">
      <span class="friends__count">{{ showBlacklist ? `黑名单 ${blacklistGids.length} 位` : `共 ${friends.length} 位好友` }}</span>
      <div class="page-toolbar__actions">
        <label v-if="!showBlacklist" class="friends__search">
          <span class="i-carbon-search" aria-hidden="true" />
          <input v-model="query" type="search" placeholder="搜索好友" aria-label="搜索好友">
        </label>
        <NButton v-if="!showBlacklist && expandedCount > 1" size="small" quaternary @click="collapseAll">
          全部收起
        </NButton>
        <NButton secondary size="small" :disabled="!currentAccountId" :title="showBlacklist ? '返回好友列表' : '牧场黑名单'" :aria-label="showBlacklist ? '返回好友列表' : '牧场黑名单'" @click="toggleBlacklistView">
          <template #icon>
            <span class="i-carbon-subtract-alt" />
          </template>
          {{ showBlacklist ? '返回好友' : '牧场黑名单' }}
        </NButton>
        <NButton secondary circle :title="showBlacklist ? '刷新黑名单' : '刷新好友'" :aria-label="showBlacklist ? '刷新黑名单' : '刷新好友'" :loading="showBlacklist ? blacklistLoading : loading && !loadingGid" :disabled="showBlacklist ? blacklistBusy : disabled && !loading" @click="showBlacklist ? loadBlacklist() : reloadList()">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </div>

    <div v-if="showBlacklist" class="blacklist">
      <p class="blacklist__hint">
        自动巡查会跳过黑名单中的对象。服务端明确提示非好友时，也会自动加入。
      </p>
      <p v-if="blacklistLoading" class="text-sm text-gray-500" role="status">
        读取黑名单中…
      </p>
      <EmptyState v-else-if="blacklistError" title="牧场黑名单读取失败" :description="blacklistError" tone="error" icon="i-carbon-warning-alt">
        <NButton secondary @click="loadBlacklist">
          重新读取
        </NButton>
      </EmptyState>
      <EmptyState v-else-if="!blacklistItems.length" title="黑名单为空" icon="i-carbon-subtract-alt" />
      <div v-else class="blacklist__list">
        <div v-for="item in blacklistItems" :key="item.gid" class="blacklist__item">
          <div class="friend-avatar">
            <img v-if="item.avatarUrl" :src="item.avatarUrl" alt="" loading="lazy">
            <span v-else class="i-carbon-user" />
          </div>
          <div class="min-w-0 flex-1">
            <strong class="block truncate text-sm">{{ item.name }}</strong>
            <span class="text-xs text-gray-400">GID {{ item.gid }}</span>
          </div>
          <NButton size="small" secondary :disabled="blacklistBusy" @click="toggleBlacklist(item.gid)">
            移出黑名单
          </NButton>
        </div>
      </div>
    </div>

    <RanchGate v-else @retry="reloadList">
      <div v-if="loading && !listLoaded" class="friends__loading" role="status" aria-label="正在读取好友">
        <span class="i-svg-spinners-90-ring-with-bg" />
      </div>
      <EmptyState v-else-if="listLoaded && !friends.length" title="暂无好友" description="添加游戏好友后可以互相拜访牧场" icon="i-carbon-user-multiple" />
      <EmptyState v-else-if="listLoaded && !visibleEntries.length" title="没有匹配的好友" description="换个昵称或 GID 试试" icon="i-carbon-search" />

      <div v-else class="friends__list">
        <div v-for="entry in visibleEntries" :key="entry.gid" class="friend-card" :class="{ 'is-expanded': entry.expanded, 'is-blacklisted': entry.blacklisted }">
          <div class="friend-row">
            <button type="button" class="friend-open" :aria-expanded="entry.expanded" :aria-label="`${entry.friend.name}，查看牧场`" :disabled="disabled || entry.blacklisted" @click="toggle(entry.friend, $event)">
              <span class="friend-avatar">
                <img v-if="entry.friend.avatarUrl && !failedAvatars[entry.gid]" :src="entry.friend.avatarUrl" alt="" loading="lazy" @error="failedAvatars[entry.gid] = true">
                <span v-else class="i-carbon-user" />
              </span>
              <span class="friend-main">
                <span class="friend-name-row">
                  <strong class="friend-name" :title="entry.friend.name">{{ entry.friend.name }}</strong>
                  <span class="friend-gid">{{ entry.gid }}</span>
                </span>
                <span class="friend-tags">
                  <span v-if="entry.blacklisted" class="f-tag f-tag--blocked">已拉黑</span>
                  <template v-else>
                    <span v-if="entry.friend.canHelp" class="f-tag">
                      <span class="i-carbon-clean text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      {{ entry.friend.helpCount > 0 ? `可清理 ${entry.friend.helpCount}` : '可清理' }}
                    </span>
                    <template v-if="entry.expanded && entry.detail">
                      <span class="f-tag f-tag--level">牧场 Lv.{{ entry.detail.level }}</span>
                      <span class="f-tag" :class="{ 'f-tag--steal': entry.detail.canSteal }">
                        <span class="i-carbon-shopping-bag" />{{ entry.detail.canSteal ? `可偷 ${entry.detail.stealableShelves} 个货架` : '暂无可偷产物' }}
                      </span>
                    </template>
                    <template v-else>
                      <span v-if="entry.friend.canSteal" class="f-tag f-tag--steal">可偷取</span>
                      <span v-if="!entry.friend.canHelp && !entry.friend.canSteal" class="f-tag">点击查看牧场</span>
                    </template>
                  </template>
                </span>
              </span>
              <span class="friend-chevron i-carbon-chevron-down" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="friend-blacklist-btn"
              :class="{ 'is-out': entry.blacklisted }"
              :aria-label="entry.blacklisted ? `移出${entry.friend.name}黑名单` : `将${entry.friend.name}加入黑名单`"
              :disabled="blacklistBusy || !!blacklistError"
              :title="blacklistError || undefined"
              @click="toggleBlacklist(entry.gid)"
            >
              {{ entry.blacklisted ? '移出黑名单' : '加入黑名单' }}
            </button>
          </div>

          <div v-if="entry.expanded" class="friend-shelves">
            <div v-if="loadingGid === entry.gid && !entry.detail" class="flex justify-center py-6">
              <span class="i-svg-spinners-90-ring-with-bg text-2xl text-green-600" />
            </div>
            <template v-else-if="entry.detail">
              <p v-if="entry.detail.notice" class="friend-shelves__notice" role="alert">
                {{ entry.detail.notice }}
              </p>

              <div class="friend-overview">
                <div v-if="entry.detail.career" class="friend-overview__career">
                  <CareerHarvestSteal :career="entry.detail.career" variant="tiles" />
                </div>
                <div class="friend-overview__toolbar">
                  <div class="friend-overview__stats">
                    <span v-if="entry.detail.feedMachine" class="friend-stat">
                      <span class="i-carbon-wheat text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      <span>牧草机 <b>{{ formatCount(entry.detail.feedMachine.count) }} / {{ formatCount(entry.detail.feedMachine.capacity) }}</b></span>
                    </span>
                    <span class="friend-stat" :class="{ 'is-zero': !entry.detail.strokeRemaining }">
                      <span class="i-carbon-favorite text-rose-500 dark:text-rose-400" aria-hidden="true" />
                      <span>今日可抚摸 <b>{{ entry.detail.strokeRemaining }}</b> 次</span>
                    </span>
                    <span class="friend-stat" :class="{ 'is-zero': !entry.detail.mosquitoRemaining }">
                      <span class="i-carbon-debug text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      <span>今日可放蚊子 <b>{{ entry.detail.mosquitoRemaining }}</b> 次</span>
                    </span>
                  </div>
                  <div class="friend-overview__actions">
                    <NButton
                      v-if="entry.detail.feedMachine"
                      size="small"
                      :type="entry.grassLimit > 0 ? 'primary' : 'default'"
                      secondary
                      :disabled="disabled || !entry.grassLimit"
                      @click="openGrassDialog(entry.gid)"
                    >
                      <template #icon>
                        <span class="i-carbon-wheat" />
                      </template>
                      {{ entry.grassRoom <= 0 ? '牧草已满' : !entry.grassLimit ? '牧草库存不足' : '赠送牧草' }}
                    </NButton>
                    <NButton
                      size="small"
                      :type="entry.detail.cleanableHazards > 0 ? 'primary' : 'default'"
                      secondary
                      :disabled="disabled || !entry.detail.cleanableHazards"
                      @click="request('cleanFriend', { hostGid: entry.gid })"
                    >
                      <template #icon>
                        <span class="i-carbon-clean" />
                      </template>
                      {{ entry.detail.cleanableHazards > 0 ? `一键清理 (${entry.detail.cleanableHazards})` : '一键清理' }}
                    </NButton>
                    <NButton
                      size="small"
                      quaternary
                      circle
                      title="刷新好友牧场"
                      aria-label="刷新好友牧场"
                      :loading="loadingGid === entry.gid"
                      :disabled="disabled"
                      @click="refreshFriend(entry.gid)"
                    >
                      <template #icon>
                        <span class="i-carbon-renew" />
                      </template>
                    </NButton>
                  </div>
                </div>
              </div>

              <section v-for="pen in entry.detail.ranches" :key="pen.id" class="friend-section friend-pen">
                <header class="friend-section__head">
                  <div class="friend-section__title">
                    <i class="friend-section__bar" aria-hidden="true" />
                    <h4>{{ pen.name }}</h4>
                    <span class="friend-section__meta">{{ pen.animals.length }} 只</span>
                    <span class="friend-pill" :class="{ 'is-full': !pen.mosquitoRoom }">
                      <span class="i-carbon-debug" aria-hidden="true" />
                      蚊子 <b>{{ pen.mosquitoes }} / {{ pen.mosquitoLimit }}</b>
                    </span>
                  </div>
                  <NButton
                    size="small"
                    :type="pen.mosquitoRoom > 0 && entry.detail.mosquitoRemaining > 0 ? 'primary' : 'default'"
                    secondary
                    :disabled="disabled || !pen.mosquitoRoom || !entry.detail.mosquitoRemaining"
                    :aria-label="`向好友${pen.name}放蚊子`"
                    @click="request('putMosquito', { hostGid: entry.gid, ranchId: pen.id })"
                  >
                    <template #icon>
                      <span class="i-carbon-debug" />
                    </template>
                    放蚊子
                  </NButton>
                </header>
                <div v-if="pen.animals.length" class="friend-pen__animals">
                  <RanchAnimalCard
                    v-for="animal in pen.animals"
                    :key="animal.id"
                    :animal="animal"
                    friend
                    actionable
                    :disabled="disabled"
                    @stroke="request('stroke', { hostGid: entry.gid, ranchId: pen.id, animalId: animal.id })"
                  />
                </div>
                <p v-else class="friend-section__empty">
                  {{ pen.name }}里暂时没有动物
                </p>
              </section>

              <section class="friend-section friend-shelf-box">
                <header class="friend-section__head">
                  <div class="friend-section__title">
                    <i class="friend-section__bar" aria-hidden="true" />
                    <h4>货架产物</h4>
                    <span class="friend-section__meta">{{ entry.shelves.length ? `${entry.shelves.length} 个货架` : '空' }}</span>
                    <span v-if="entry.detail.canSteal" class="friend-pill is-highlight">
                      可偷 {{ entry.detail.stealableShelves }} 个
                    </span>
                  </div>
                  <NButton size="small" type="primary" :disabled="disabled || !entry.detail.canSteal" @click="request('steal', { hostGid: entry.gid })">
                    <template #icon>
                      <span class="i-carbon-shopping-bag" />
                    </template>
                    一键偷取
                  </NButton>
                </header>
                <div v-if="entry.shelves.length" class="friend-shelves__grid">
                  <div v-for="shelf in entry.shelves" :key="shelf.key" class="shelf" :class="{ 'is-stealable': shelf.canSteal }">
                    <span class="shelf__slot">货架 {{ shelf.slot }}</span>
                    <div class="shelf__products">
                      <span v-for="product in shelf.products" :key="product.id" :title="product.name">
                        <img :src="product.image" alt="">{{ product.name }}<b>×{{ formatCount(product.count) }}</b>
                      </span>
                    </div>
                    <span class="shelf__state">{{ shelf.canSteal ? '可偷取' : '不可偷' }}</span>
                  </div>
                </div>
                <p v-else class="friend-section__empty">
                  好友的货架上暂时没有产物
                </p>
              </section>
            </template>
            <p v-else-if="entry.error" class="friend-shelves__notice" role="alert">
              {{ entry.error }}
            </p>
          </div>
        </div>
      </div>
    </RanchGate>
    <RanchAmountDialog
      :show="!!grassDialogGid && !!grassDialogMachine"
      title="赠送牧草"
      name="牧草"
      :image="RANCH_IMAGE(7001)"
      :caption="`赠送给 ${grassDialogDetail?.name ?? ''} · 可用牧草 ${formatCount(grassDialogAvailable)}`"
      :max="grassDialogLimit"
      submit-text="确认赠送"
      @close="grassDialogGid = ''"
      @submit="submitGrass"
    />
  </div>
</template>

<style scoped>
.friends,
.friends__list,
.friend-card,
.friend-shelves {
  overflow-anchor: none;
}

.friends {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 24px;
}

.friends__count {
  color: var(--ui-muted);
  font-size: 13px;
}

.friends__search {
  display: flex;
  width: 16rem;
  height: 34px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  color: var(--ui-subtle);
  background: var(--glass-input);
}

.friends__search:focus-within {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-primary) 14%, transparent);
}

.friends__search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: var(--ui-ink);
  background: transparent;
  font-size: 13px;
}

.friends__loading {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--ui-primary);
  font-size: 28px;
}

.friends__list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

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
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
}

.friend-open {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 14px;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.friend-open:not(:disabled):hover {
  background: color-mix(in srgb, var(--ui-surface-soft) 60%, transparent);
}

.friend-open:focus-visible,
.friend-blacklist-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ui-primary) 55%, transparent);
  outline-offset: 2px;
}

.friend-open:disabled,
.friend-blacklist-btn:disabled {
  cursor: default;
}

.friend-avatar {
  display: grid;
  width: 44px;
  height: 44px;
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

.f-tag--level {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.f-tag--steal {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
}

.f-tag--blocked {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-weight: var(--fw-600);
}

.friend-blacklist-btn {
  height: 22px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--ui-danger) 35%, transparent);
  border-radius: 7px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.friend-blacklist-btn:hover {
  background: color-mix(in srgb, var(--ui-danger) 18%, transparent);
}

.friend-blacklist-btn.is-out {
  color: var(--ui-primary);
  border-color: color-mix(in srgb, var(--ui-primary) 35%, transparent);
  background: var(--ui-primary-soft);
}

.friend-blacklist-btn.is-out:hover {
  background: color-mix(in srgb, var(--ui-primary) 18%, transparent);
}

.friend-card.is-blacklisted {
  opacity: 0.72;
}

.blacklist {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.blacklist__hint {
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
}

.blacklist__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.blacklist__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
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

.friend-shelves {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px 18px;
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-surface-soft) 55%, transparent);
}

.friend-shelves__notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 13px;
}

.friend-overview {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.friend-overview__career {
  padding: 12px 14px;
}

.friend-overview__career :deep(.career-tiles) {
  gap: 10px;
}

.friend-overview__career :deep(.career-tile) {
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
}

.friend-overview__career :deep(.career-tile__value) {
  font-size: 16px;
  line-height: 1.25;
}

.friend-overview__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  padding: 11px 14px;
}

.friend-overview__career + .friend-overview__toolbar {
  border-top: 1px solid var(--ui-border);
}

.friend-overview__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.friend-stat {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  padding: 0 11px 0 9px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.friend-stat b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.friend-stat.is-zero {
  opacity: 0.65;
}

.friend-overview__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.friend-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 14px 16px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.friend-section__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.friend-section__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.friend-section__bar {
  width: 3px;
  height: 14px;
  flex: none;
  border-radius: 2px;
  background: var(--ui-primary);
}

.friend-section__title h4 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  line-height: 1.3;
}

.friend-section__meta {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.friend-pill {
  display: inline-flex;
  height: 22px;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.friend-pill b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.friend-pill.is-full {
  opacity: 0.72;
}

.friend-pill.is-highlight {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
}

.friend-section__empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--ui-border-strong);
  border-radius: 10px;
  color: var(--ui-subtle);
  background: color-mix(in srgb, var(--ui-surface-soft) 50%, transparent);
  font-size: 13px;
  text-align: center;
}

.friend-pen__animals {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.friend-shelves__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}

.shelf {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface-soft);
}

.shelf.is-stealable {
  border-color: color-mix(in srgb, var(--ui-primary) 42%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary-soft) 45%, var(--ui-surface-soft));
}

.shelf__slot {
  color: var(--ui-subtle);
  font-size: 12px;
  white-space: nowrap;
}

.shelf__products {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.shelf__products > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-muted);
  font-size: 13px;
}

.shelf__products img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.shelf__products b {
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}

.shelf__state {
  color: var(--ui-subtle);
  font-size: 12px;
  white-space: nowrap;
}

.shelf.is-stealable .shelf__state {
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}

@media (max-width: 1199px) {
  .friend-pen__animals {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
}

@media (max-width: 767px) {
  .friend-row {
    padding: 12px;
  }

  .friend-open {
    grid-template-columns: 40px minmax(0, 1fr) 16px;
    gap: 8px;
  }

  .friend-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
  }

  .friends__search {
    width: auto;
    flex: 1;
  }

  .friend-shelves {
    gap: 12px;
    padding: 12px;
  }

  .friend-overview__career,
  .friend-overview__toolbar {
    padding: 10px 12px;
  }

  .friend-overview__actions {
    width: 100%;
  }

  .friend-overview__actions :deep(.n-button:not(.n-button--circle)) {
    flex: 1 1 auto;
  }

  .friend-section {
    padding: 12px;
  }

  .friend-pen__animals {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
}

@media (max-width: 479px) {
  .friend-pen__animals {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
}
</style>
