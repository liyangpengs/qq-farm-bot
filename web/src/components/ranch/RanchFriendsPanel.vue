<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'
import { formatCount, useRanchActions } from '@/components/ranch/ranch-shared'
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
const selected = ref('')
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
    if (data.data.blacklisted && Number(selected.value) === Number(gid))
      selected.value = ''
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

const visible = computed(() => {
  const keyword = query.value.trim()
  return keyword ? friends.value.filter(f => String(f.name || '').includes(keyword) || String(f.gid).includes(keyword)) : friends.value
})
const detail = computed(() => selected.value && state.value?.friendRanch?.gid === selected.value ? state.value.friendRanch : null)
const detailShelves = computed(() => (detail.value?.ranches || []).flatMap((r: any) => r.shelves.map((s: any) => ({ ...s, key: `${r.id}:${s.slot}` }))))
watch(detail, (live) => {
  if (!live)
    return
  const friend = friends.value.find(entry => entry.gid === live.gid)
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
  selected.value = ''
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

async function toggle(friend: any) {
  const id = String(currentAccountId.value || '')
  if (!id || disabled.value || blacklistedSet.value.has(Number(friend.gid)))
    return
  if (selected.value === friend.gid) {
    selected.value = ''
    return
  }
  selected.value = friend.gid
  await ranch.load(id, 'friends', undefined, friend.gid)
}
async function reloadList() {
  const id = String(currentAccountId.value || '')
  if (id && !disabled.value) {
    selected.value = ''
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
        <NButton secondary size="small" :disabled="!currentAccountId" :title="showBlacklist ? '返回好友列表' : '牧场黑名单'" :aria-label="showBlacklist ? '返回好友列表' : '牧场黑名单'" @click="toggleBlacklistView">
          <template #icon>
            <span class="i-carbon-subtract-alt" />
          </template>
          {{ showBlacklist ? '返回好友' : '牧场黑名单' }}
        </NButton>
        <NButton secondary circle :title="showBlacklist ? '刷新黑名单' : '刷新好友'" :aria-label="showBlacklist ? '刷新黑名单' : '刷新好友'" :loading="showBlacklist ? blacklistLoading : loading && !selected" :disabled="showBlacklist ? blacklistBusy : disabled && !loading" @click="showBlacklist ? loadBlacklist() : reloadList()">
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
      <EmptyState v-else-if="listLoaded && !visible.length" title="没有匹配的好友" description="换个昵称或 GID 试试" icon="i-carbon-search" />

      <div v-else class="friends__list">
        <div v-for="friend in visible" :key="friend.gid" class="friend-card" :class="{ 'is-expanded': selected === friend.gid, 'is-blacklisted': blacklistedSet.has(Number(friend.gid)) }">
          <div class="friend-row">
            <button type="button" class="friend-open" :aria-expanded="selected === friend.gid" :aria-label="`${friend.name}，查看牧场`" :disabled="disabled || blacklistedSet.has(Number(friend.gid))" @click="toggle(friend)">
              <span class="friend-avatar">
                <img v-if="friend.avatarUrl && !failedAvatars[friend.gid]" :src="friend.avatarUrl" alt="" loading="lazy" @error="failedAvatars[friend.gid] = true">
                <span v-else class="i-carbon-user" />
              </span>
              <span class="friend-main">
                <span class="friend-name-row">
                  <strong class="friend-name" :title="friend.name">{{ friend.name }}</strong>
                  <span class="friend-gid">{{ friend.gid }}</span>
                </span>
                <span class="friend-tags">
                  <span v-if="blacklistedSet.has(Number(friend.gid))" class="f-tag f-tag--blocked">已拉黑</span>
                  <template v-else>
                    <span v-if="friend.canHelp" class="f-tag">
                      <span class="i-carbon-clean text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      {{ friend.helpCount > 0 ? `可清理 ${friend.helpCount}` : '可清理' }}
                    </span>
                    <template v-if="selected === friend.gid && detail">
                      <span class="f-tag f-tag--level">牧场 Lv.{{ detail.level }}</span>
                      <span class="f-tag" :class="{ 'f-tag--steal': detail.canSteal }">
                        <span class="i-carbon-shopping-bag" />{{ detail.canSteal ? `可偷 ${detail.stealableShelves} 个货架` : '暂无可偷产物' }}
                      </span>
                    </template>
                    <template v-else>
                      <span v-if="friend.canSteal" class="f-tag f-tag--steal">可偷取</span>
                      <span v-if="!friend.canHelp && !friend.canSteal" class="f-tag">点击查看牧场</span>
                    </template>
                  </template>
                </span>
              </span>
              <span class="friend-chevron i-carbon-chevron-down" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="friend-blacklist-btn"
              :class="{ 'is-out': blacklistedSet.has(Number(friend.gid)) }"
              :aria-label="blacklistedSet.has(Number(friend.gid)) ? `移出${friend.name}黑名单` : `将${friend.name}加入黑名单`"
              :disabled="blacklistBusy || !!blacklistError"
              :title="blacklistError || undefined"
              @click="toggleBlacklist(friend.gid)"
            >
              {{ blacklistedSet.has(Number(friend.gid)) ? '移出黑名单' : '加入黑名单' }}
            </button>
          </div>

          <div v-if="selected === friend.gid" class="friend-shelves">
            <div v-if="loading && !detail" class="flex justify-center py-6">
              <span class="i-svg-spinners-90-ring-with-bg text-2xl text-green-600" />
            </div>
            <template v-else-if="detail">
              <p v-if="detail.notice" class="friend-shelves__notice" role="alert">
                {{ detail.notice }}
              </p>
              <CareerHarvestSteal v-if="detail.career" :career="detail.career" />
              <div class="friend-interactions">
                <span>今日可抚摸 <b>{{ detail.strokeRemaining }}</b> 次</span>
                <span>今日可放蚊子 <b>{{ detail.mosquitoRemaining }}</b> 次</span>
                <NButton size="small" secondary :disabled="disabled || !detail.cleanableHazards" @click="request('cleanFriend', { hostGid: friend.gid })">
                  一键清理
                </NButton>
              </div>
              <section v-for="pen in detail.ranches" :key="pen.id" class="friend-pen">
                <div class="friend-shelves__head">
                  <h4>{{ pen.name }} <small>蚊子 {{ pen.mosquitoes }} / {{ pen.mosquitoLimit }}</small></h4>
                  <NButton size="small" secondary :disabled="disabled || !pen.mosquitoRoom || !detail.mosquitoRemaining" :aria-label="`向好友${pen.name}放蚊子`" @click="request('putMosquito', { hostGid: friend.gid, ranchId: pen.id })">
                    放蚊子
                  </NButton>
                </div>
                <div class="friend-pen__animals">
                  <RanchAnimalCard
                    v-for="animal in pen.animals" :key="animal.id" :animal="animal" :pen="pen.name"
                    friend actionable :disabled="disabled"
                    @stroke="request('stroke', { hostGid: friend.gid, ranchId: pen.id, animalId: animal.id })"
                  />
                </div>
              </section>
              <div class="friend-shelves__head">
                <span><span class="i-carbon-box" aria-hidden="true" />货架产物</span>
                <NButton size="small" type="primary" :disabled="disabled || !detail.canSteal" @click="request('steal', { hostGid: friend.gid })">
                  <template #icon>
                    <span class="i-carbon-shopping-bag" />
                  </template>
                  一键偷取
                </NButton>
              </div>
              <div v-if="detailShelves.length" class="friend-shelves__grid">
                <div v-for="shelf in detailShelves" :key="shelf.key" class="shelf" :class="{ 'is-stealable': shelf.canSteal }">
                  <span class="shelf__slot">货架 {{ shelf.slot }}</span>
                  <div class="shelf__products">
                    <span v-for="product in shelf.products" :key="product.id" :title="product.name">
                      <img :src="product.image" alt="">{{ product.name }}<b>×{{ formatCount(product.count) }}</b>
                    </span>
                  </div>
                  <span class="shelf__state">{{ shelf.canSteal ? '可偷取' : '不可偷' }}</span>
                </div>
              </div>
              <p v-else class="friend-shelves__empty">
                好友的货架上暂时没有产物
              </p>
            </template>
            <p v-else-if="error" class="friend-shelves__notice" role="alert">
              {{ error }}
            </p>
          </div>
        </div>
      </div>
    </RanchGate>
  </div>
</template>

<style scoped>
.friend-interactions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
  color: var(--ui-muted);
  font-size: 12px;
}

.friend-interactions b {
  color: var(--ui-primary);
}
.friend-pen {
  display: grid;
  gap: 10px;
  margin: 14px 0;
}
.friend-pen h4 {
  margin: 0;
  font-size: 14px;
}
.friend-pen h4 small {
  margin-left: 6px;
  color: var(--ui-subtle);
  font-weight: normal;
}
.friend-pen__animals {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 10px;
}

.friends {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
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
  gap: 10px;
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
  gap: 12px;
  padding: 16px;
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-surface-soft) 55%, transparent);
}

.friend-shelves__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.friend-shelves__head > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-600);
}

.friend-shelves__notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 13px;
}

.friend-shelves__empty {
  margin: 0;
  color: var(--ui-subtle);
  font-size: 13px;
  text-align: center;
}

.friend-shelves__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 8px;
}

.shelf {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.shelf.is-stealable {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
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
    padding: 12px;
  }
}
</style>
