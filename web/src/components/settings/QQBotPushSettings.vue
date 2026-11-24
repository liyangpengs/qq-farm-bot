<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NModal } from 'naive-ui/es/modal'
import { NCard } from 'naive-ui/es/card'
import PushMessageCard from '@/components/settings/PushMessageCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { getApiErrorMessage } from '@/api'
import { getPlatformClass, getPlatformLabel, useAccountStore, type Account } from '@/stores/account'
import {
  QQ_BOT_EVENT_OPTIONS,
  useQqBotPushStore,
  type QqBotPushConfig,
  type QqBotPushDetails,
  type QqBotPushRecord,
} from '@/stores/qqBotPush'
import { useToastStore } from '@/stores/toast'

const store = useQqBotPushStore()
const accountStore = useAccountStore()
const toast = useToastStore()

const local = ref<QqBotPushConfig>({ ...store.config, eventKeys: [...store.config.eventKeys] })
const saving = ref(false)
const testing = ref(false)
const capturing = ref(false)
const dirty = ref(false)   // 用户正在编辑，避免轮询 fetch 覆盖本地输入
let syncing = false        // 同步标志，避免同步动作触发 dirty
// 删除接收用户确认
const showDeleteConfirm = ref(false)
const userToDelete = ref<string>('')
const deletingUser = ref(false)
// 账号头像加载失败记录
const accountAvatarErrors = ref<Set<string>>(new Set())

function syncLocalFromStore() {
  syncing = true
  local.value = { ...store.config, eventKeys: [...store.config.eventKeys] }
  // 保持当前选中用户；若尚未选中或已失效，默认选中默认接收用户
  const currentUsers: string[] = (store.status.users || []).map((u: any) => u.openid)
  if (!selectedUserOpenid.value || (currentUsers.length && !currentUsers.includes(selectedUserOpenid.value))) {
    selectedUserOpenid.value = local.value.openid && currentUsers.includes(local.value.openid)
      ? local.value.openid
      : (currentUsers[0] || '')
  }
  dirty.value = false
  Promise.resolve().then(() => { syncing = false })
}

const statusText = computed(() => {
  const s = store.status
  if (s.connected) return '网关已连接'
  if (s.connecting) return '正在连接...'
  if (s.openid) return '已绑定用户，网关离线'
  return '未连接'
})

const statusClass = computed(() => {
  const s = store.status
  if (s.connected) return 'text-green-600 dark:text-green-400'
  if (s.connecting) return 'text-amber-600 dark:text-amber-400'
  return 'text-gray-500 dark:text-gray-400'
})

const users = computed(() => store.status.users || [])
const accounts = computed<Account[]>(() => accountStore.accounts || [])
const selectedUserOpenid = ref('')
const selectedUser = computed(() => users.value.find(u => u.openid === selectedUserOpenid.value) || null)
// 有接收用户时，openid 输入框只读并展示当前选中用户；无用户时可手动填
const openidDisplay = computed(() => (users.value.length && selectedUser.value)
  ? selectedUser.value.openid
  : local.value.openid)

// ---- 推送统计查看 ----
const detailKind = ref<'' | 'sent' | 'queued' | 'media'>('')
const details = ref<QqBotPushDetails>({ records: [], queue: [], media: [] })
const detailsLoading = ref(false)
const detailRecipient = ref('')  // 一级：接收 QQ 账号 openid，''=全部
const detailAccount = ref('')    // 二级：农场账号 id，''=全部
const detailDate = ref('')       // 日期筛选 YYYY-MM-DD，''=全部

function recipientLabel(openid: string): string {
  return users.value.find((u: any) => u.openid === openid)?.nickname || (openid ? `${openid.slice(0, 8)}…` : '未知')
}

function accountLabel(id: string): string {
  const acc = accounts.value.find((a: any) => String(a.id) === String(id))
  return acc?.name || acc?.nick || id || '未知账号'
}

// 一级胶囊：从记录 + 接收用户里汇总出现过的接收 QQ
const detailRecipients = computed<string[]>(() => {
  const set = new Set<string>()
  for (const u of users.value) if (u.openid) set.add(u.openid)
  for (const r of details.value.records) if (r.recipientOpenid) set.add(r.recipientOpenid)
  return Array.from(set)
})

// 二级：当前接收 QQ 下出现过的农场账号
const detailAccounts = computed<string[]>(() => {
  const set = new Set<string>()
  for (const r of details.value.records) {
    if (detailRecipient.value && r.recipientOpenid !== detailRecipient.value) continue
    if (r.accountId) set.add(r.accountId)
  }
  return Array.from(set)
})

// 日期胶囊：从所有记录里汇总出现过的日期，倒序（最新在前）
const detailDates = computed<string[]>(() => {
  const set = new Set<string>()
  for (const r of details.value.records) if (r.dateKey) set.add(r.dateKey)
  return Array.from(set).sort((a, b) => b.localeCompare(a))
})

function dateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-')
  if (y && m && d) return `${Number(m)}月${Number(d)}日`
  return dateKey
}

const deletingDay = ref(false)
async function deleteDayRecords() {
  const key = detailDate.value
  if (!key || deletingDay.value) return
  if (!window.confirm(`确定删除 ${dateLabel(key)} 的全部推送记录吗？此操作不可恢复。`)) return
  deletingDay.value = true
  try {
    const next = await store.deleteRecords(key)
    if (next) {
      details.value = next
      toast.success(`已删除 ${dateLabel(key)} 的推送记录`)
    } else {
      toast.error('删除失败')
    }
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '删除失败')
  } finally {
    deletingDay.value = false
  }
}

const filteredRecords = computed<QqBotPushRecord[]>(() => {
  return details.value.records
    .filter(r => !detailRecipient.value || r.recipientOpenid === detailRecipient.value)
    .filter(r => !detailAccount.value || r.accountId === detailAccount.value)
    .filter(r => !detailDate.value || r.dateKey === detailDate.value)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
})

const filteredQueue = computed<any[]>(() => {
  return details.value.queue
    .filter((q: any) => !detailAccount.value || String(q.accountId) === detailAccount.value)
})

const mediaMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const m of details.value.media) if (m.name && m.localPath) map[m.name] = m.localPath
  return map
})

async function openDetails(kind: 'sent' | 'queued' | 'media') {
  detailKind.value = kind
  detailsLoading.value = true
  detailDate.value = ''
  detailAccount.value = ''
  detailRecipient.value = ''
  try {
    details.value = await store.fetchDetails()
  } finally {
    detailsLoading.value = false
  }
}

function shortOpenid(openid: string) {
  if (!openid) return ''
  return openid.length > 12 ? `${openid.slice(0, 6)}...${openid.slice(-4)}` : openid
}

function toggleEvent(key: string, checked: boolean) {
  const keys = new Set(local.value.eventKeys)
  if (checked) keys.add(key)
  else keys.delete(key)
  local.value.eventKeys = QQ_BOT_EVENT_OPTIONS.filter(o => keys.has(o.key)).map(o => o.key)
}

onMounted(async () => {
  // 必须等 fetch 完成后再用 store.config 初始化 local，
  // 否则会用默认空值覆盖后端已保存的 AppSecret/openid。
  await Promise.all([store.fetch().catch(() => {}), accountStore.fetchAccounts().catch(() => {})])
  syncLocalFromStore()
  store.startPolling()
})

// 轮询/捕获/切换用户后，若用户没在编辑则同步最新配置到表单
watch(() => store.config, () => {
  if (!dirty.value) syncLocalFromStore()
}, { deep: true })

// 用户一改动表单就置 dirty，避免后台轮询覆盖未保存的输入
watch(local, () => { if (!syncing) dirty.value = true }, { deep: true })

onUnmounted(() => {
  store.stopPolling()
})

async function handleSave() {
  saving.value = true
  try {
    const res = await store.save(local.value) as any
    if (res?.ok) {
      dirty.value = false
      toast.success('QQ 机器人推送设置已保存')
    }
    else toast.error(getApiErrorMessage(res, '保存失败'))
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '保存失败'))
  }
  finally {
    saving.value = false
  }
}

async function handleTest() {
  testing.value = true
  try {
    const res = await store.testSend() as any
    if (res?.ok) toast.success('测试消息已发送到 QQ')
    else toast.error(getApiErrorMessage(res, '测试发送失败'))
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '测试发送失败'))
  }
  finally {
    testing.value = false
  }
}

async function handleCapture() {
  capturing.value = true
  try {
    const res = await store.capture() as any
    if (res?.ok) toast.success('已开始监听，请用 QQ 给机器人发一条消息')
    else toast.error(getApiErrorMessage(res, '启动捕获失败'))
    await store.fetch()
    syncLocalFromStore()
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '启动捕获失败'))
  }
  finally {
    capturing.value = false
  }
}

async function handleSelectUser(openid: string) {
  try {
    const res = await store.selectUser(openid) as any
    if (res?.ok) {
      await store.fetch()
      syncLocalFromStore()
      toast.success('已切换接收用户')
    }
    else toast.error(getApiErrorMessage(res, '切换用户失败'))
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '切换用户失败'))
  }
}

function isCurrentUser(openid: string) {
  return !!local.value.openid && local.value.openid === openid
}

function accountAvatar(acc: Account): string {
  return String(acc.avatar || '').trim()
}
function canShowAccountAvatar(acc: Account): boolean {
  return !!accountAvatar(acc) && !accountAvatarErrors.value.has(String(acc.id))
}
function onAccountAvatarError(acc: Account) {
  accountAvatarErrors.value.add(String(acc.id))
}

// 删除接收用户
function askDeleteUser(openid: string) {
  userToDelete.value = openid
  showDeleteConfirm.value = true
}
async function confirmDeleteUser() {
  if (!userToDelete.value || deletingUser.value) return
  deletingUser.value = true
  try {
    const res = await store.deleteUser(userToDelete.value) as any
    if (res?.ok) {
      toast.success('接收用户已删除')
      await store.fetch()
      // 若删除的是当前选中用户，先置空让 syncLocalFromStore 自动选一个新的
      if (selectedUserOpenid.value === userToDelete.value) selectedUserOpenid.value = ''
      syncLocalFromStore()
      showDeleteConfirm.value = false
    }
    else toast.error(getApiErrorMessage(res, '删除失败'))
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '删除失败'))
  }
  finally {
    deletingUser.value = false
  }
}

// 账号路由：某账号是否推送给指定用户
function accountHasUser(accountId: string, openid: string): boolean {
  const routes = local.value.accountRoutes || {}
  const list = routes[accountId]
  if (Array.isArray(list)) return list.includes(openid)
  // 未配置时继承默认 openid
  return !!local.value.openid && local.value.openid === openid
}

function toggleAccountUser(accountId: string, openid: string, checked: boolean) {
  const routes = { ...(local.value.accountRoutes || {}) }
  // 首次修改某账号时，把它当前的接收用户（默认或已配置）作为初值
  let list: string[]
  if (Array.isArray(routes[accountId])) {
    list = [...routes[accountId]]
  } else {
    list = local.value.openid ? [local.value.openid] : []
  }
  if (checked && !list.includes(openid)) list.push(openid)
  if (!checked) list = list.filter(o => o !== openid)
  routes[accountId] = list
  local.value.accountRoutes = routes
  dirty.value = true
}
</script>

<template>
  <div class="space-y-3">
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-4">
      <section class="farm-card rounded-lg p-3 lg:col-span-3">
      <div class="mb-3 flex items-start gap-2.5">
        <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
          <span class="i-carbon-chat text-xl" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
              QQ 机器人推送
            </h4>
            <BaseSwitch v-model="local.enabled" />
          </div>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            将重要日志以单聊消息推送到 QQ，多条自动聚合以规避频率限制
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div class="min-w-0 flex flex-col gap-1.5">
          <span class="text-sm text-gray-700 font-medium dark:text-gray-300">AppID</span>
          <BaseInput v-model="local.appId" placeholder="机器人 AppID" />
        </div>
        <div class="min-w-0 flex flex-col gap-1.5">
          <span class="text-sm text-gray-700 font-medium dark:text-gray-300">AppSecret</span>
          <BaseInput v-model="local.appSecret" type="password" placeholder="在开放平台管理端复制" />
        </div>
        <div class="min-w-0 flex flex-col gap-1.5 sm:col-span-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-gray-700 font-medium dark:text-gray-300">
              接收用户 openid
              <span v-if="users.length" class="ml-1 text-xs text-gray-400">（当前选中）</span>
            </span>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="capturing"
              :disabled="users.length > 0"
              :title="users.length > 0 ? '已有接收用户，请在下方「接收用户」卡片中添加' : ''"
              @click="handleCapture"
            >
              从消息捕获
            </BaseButton>
          </div>
          <BaseInput
            :model-value="openidDisplay"
            :disabled="users.length > 0"
            :placeholder="users.length > 0 ? '' : '点击右侧按钮后用 QQ 给机器人发一条消息，或手动填写'"
          />
        </div>
        <div class="min-w-0 flex flex-col gap-1.5">
          <span class="text-sm text-gray-700 font-medium dark:text-gray-300">聚合窗口（秒）</span>
          <BaseInput v-model.number="local.batchWindowSec" type="number" :min="5" :max="600" />
          <span class="text-xs text-gray-400">窗口内的日志合并为一条消息，默认 60 秒</span>
        </div>
        <div class="min-w-0 flex flex-col gap-1.5">
          <span class="text-sm text-gray-700 font-medium dark:text-gray-300">每日上限 / 每分钟上限</span>
          <div class="flex gap-2">
            <BaseInput v-model.number="local.dailyLimit" type="number" :min="1" :max="1000" />
            <BaseInput v-model.number="local.minuteLimit" type="number" :min="1" :max="20" />
          </div>
          <span class="text-xs text-gray-400">官方限制：每好友 20 条/分钟、1000 条/天，留有余量</span>
        </div>
      </div>
      </section>

      <!-- 推送统计 + 连接状态：上下 2:1 -->
      <div class="flex h-full flex-col gap-3">
        <section class="farm-card flex-[2] rounded-2xl bg-white p-4 shadow-md dark:bg-gray-800">
          <h4 class="mb-3 flex items-center gap-2 text-base font-display font-medium">
            <span class="i-carbon-chart-column" />
            <span>推送统计</span>
          </h4>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex cursor-pointer items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30" @click="openDetails('sent')">
              <div class="flex items-center gap-2">
                <span class="i-carbon-send select-none text-base text-blue-500" />
                <span class="text-xs text-gray-500 dark:text-gray-400 2xl:text-sm">本次已发送</span>
              </div>
              <div class="text-sm font-bold 2xl:text-base">{{ store.status.sentToday }}</div>
            </div>
            <div class="flex cursor-pointer items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30" @click="openDetails('queued')">
              <div class="flex items-center gap-2">
                <span class="i-carbon-time select-none text-base text-amber-500" />
                <span class="text-xs text-gray-500 dark:text-gray-400 2xl:text-sm">待发送</span>
              </div>
              <div class="text-sm font-bold 2xl:text-base">{{ store.status.queued }}</div>
            </div>
            <div class="col-span-2 flex cursor-pointer items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30" @click="openDetails('media')">
              <div class="flex items-center gap-2">
                <span class="i-carbon-image select-none text-base text-green-500" />
                <span class="text-xs text-gray-500 dark:text-gray-400 2xl:text-sm">素材缓存</span>
              </div>
              <div class="text-sm font-bold 2xl:text-base">{{ store.status.mediaCount }}</div>
            </div>
          </div>
        </section>

        <!-- 网关连接状态（无标题） -->
        <section class="farm-card flex-1 rounded-2xl bg-white p-4 shadow-md dark:bg-gray-800">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
              <span
                class="i-carbon-wifi text-lg"
                :class="store.status.connected ? 'text-green-500' : 'text-gray-400'"
              />
              <span>网关状态</span>
            </div>
            <span class="text-lg font-bold" :class="statusClass">{{ statusText }}</span>
          </div>
          <div v-if="store.status.lastError" class="mt-2 truncate text-xs text-red-500 dark:text-red-400" :title="store.status.lastError">
            {{ store.status.lastError }}
          </div>
        </section>
      </div>
    </div>

    <section class="farm-card rounded-lg p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            接收用户
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            点选一个用户，在下方设置哪些农场账号推送给它
          </p>
        </div>
        <BaseButton variant="primary" size="sm" :loading="capturing" @click="handleCapture">
          捕获新用户
        </BaseButton>
      </div>
      <div v-if="users.length" class="flex flex-wrap gap-2">
        <button
          v-for="u in users"
          :key="u.openid"
          type="button"
          class="flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-left transition-colors"
          :class="selectedUserOpenid === u.openid
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/25'
            : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'"
          @click="selectedUserOpenid = u.openid"
        >
          <img
            v-if="u.avatar"
            :src="u.avatar"
            alt=""
            class="h-7 w-7 shrink-0 rounded-full object-cover"
          >
          <span v-else class="h-7 w-7 flex shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-500 dark:bg-gray-700">
            <span class="i-carbon-user-avatar text-base" />
          </span>
          <span class="max-w-28 truncate text-sm text-gray-800 dark:text-gray-200">{{ u.nickname || shortOpenid(u.openid) }}</span>
          <span
            v-if="isCurrentUser(u.openid)"
            class="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-900/40 dark:text-blue-300"
          >默认</span>
          <span
            role="button"
            tabindex="0"
            :title="`删除用户 ${u.nickname || shortOpenid(u.openid)}`"
            class="i-carbon-trash-can text-sm text-gray-400 hover:text-red-500"
            @click.stop="askDeleteUser(u.openid)"
          />
        </button>
      </div>
      <div v-else class="rounded-lg border border-dashed border-gray-300 px-3 py-5 text-center text-sm text-gray-400 dark:border-gray-700">
        暂无用户。点击「捕获新用户」，再用 QQ 给机器人发一条消息。
      </div>

      <!-- 当前选中用户的推送目标：只列出该用户的账号开关 -->
      <div v-if="selectedUser" class="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <span>推送账号</span>
            <span class="text-gray-400">· {{ selectedUser.nickname || shortOpenid(selectedUser.openid) }}</span>
          </div>
          <BaseButton
            v-if="!isCurrentUser(selectedUser.openid)"
            variant="text"
            size="sm"
            @click="handleSelectUser(selectedUser.openid)"
          >
            设为默认
          </BaseButton>
        </div>
        <div v-if="accounts.length" class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <div
            v-for="acc in accounts"
            :key="acc.id"
            class="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 dark:border-gray-700"
          >
            <img
              v-if="canShowAccountAvatar(acc)"
              :src="accountAvatar(acc)"
              :alt="acc.name || acc.id"
              class="h-7 w-7 shrink-0 rounded-full object-cover"
              @error="onAccountAvatarError(acc)"
            >
            <span v-else class="h-7 w-7 flex shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-400 dark:bg-gray-700">
              <span class="i-carbon-user text-base" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm text-gray-800 dark:text-gray-200">{{ acc.name || acc.nick || acc.id }}</div>
              <div class="flex items-center gap-1.5">
                <span
                  v-if="acc.platform"
                  class="rounded px-1 py-0.5 text-[10px] leading-tight font-medium"
                  :class="getPlatformClass(acc.platform)"
                >{{ getPlatformLabel(acc.platform) }}</span>
                <span class="truncate text-xs text-gray-400">{{ acc.uin || acc.id }}</span>
              </div>
            </div>
            <BaseSwitch
              :model-value="accountHasUser(acc.id, selectedUser.openid)"
              @update:model-value="toggleAccountUser(acc.id, selectedUser.openid, !!$event)"
            />
          </div>
        </div>
        <div v-else class="text-xs text-gray-400">暂无农场账号，请先在「账号管理」添加账号。</div>
        <p class="mt-2 text-xs text-gray-400">
          开启表示该账号的日志推送给此用户。未给任何用户单独开启的账号，将推送给「默认」用户。
        </p>
      </div>
    </section>

    <!-- 推送事件 + 通知与显示：左右栏 -->
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <section class="farm-card rounded-lg p-3">
        <h4 class="mb-2 text-base text-gray-900 font-bold dark:text-gray-100">
          推送事件
        </h4>
        <div class="grid grid-cols-2 gap-1.5">
          <div
            v-for="opt in QQ_BOT_EVENT_OPTIONS"
            :key="opt.key"
            class="rounded-lg border border-gray-200 px-3 py-1 dark:border-gray-700"
          >
            <BaseSwitch
              :model-value="local.eventKeys.includes(opt.key)"
              :label="opt.label"
              @update:model-value="toggleEvent(opt.key, !!$event)"
            />
            <p class="mt-0.5 pl-0.5 text-xs text-gray-400">{{ opt.desc }}</p>
          </div>
        </div>
      </section>

      <section class="farm-card rounded-lg p-3">
        <h4 class="mb-2 text-base text-gray-900 font-bold dark:text-gray-100">
          通知与显示
        </h4>
        <div class="grid grid-cols-2 gap-1.5">
          <div class="rounded-lg border border-gray-200 px-3 py-1 dark:border-gray-700">
            <BaseSwitch v-model="local.offlineNotify" label="账号下线时推送" />
          </div>
          <div class="rounded-lg border border-gray-200 px-3 py-1 dark:border-gray-700">
            <span class="text-sm text-gray-500 dark:text-gray-400">微信账号掉线推送自带「重新登录」按钮</span>
          </div>
          <div class="rounded-lg border border-gray-200 px-3 py-1 dark:border-gray-700">
            <BaseSwitch v-model="local.includeIcons" label="显示事件/物品图标" />
          </div>
          <div class="rounded-lg border border-gray-200 px-3 py-1 dark:border-gray-700">
            <BaseSwitch v-model="local.includeAvatars" label="显示好友头像" />
          </div>
          <div class="rounded-lg border border-gray-200 px-3 py-1 dark:border-gray-700">
            <BaseSwitch v-model="local.showAccount" label="显示账号名" />
          </div>
        </div>
        <div v-if="store.status.relogin?.length" class="mt-3 space-y-1">
          <div
            v-for="session in store.status.relogin"
            :key="session.accountId"
            class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/25 dark:text-amber-300"
          >
            正在等待扫码登录（账号 {{ session.accountId }}，阶段：{{ session.stage }}）
          </div>
        </div>
      </section>
    </div>

    <div class="flex flex-wrap gap-2">
      <BaseButton variant="secondary" size="sm" :loading="testing" :disabled="!local.enabled" @click="handleTest">
        测试通知
      </BaseButton>
      <BaseButton variant="primary" size="sm" :loading="saving" @click="handleSave">
        保存 QQ 机器人设置
      </BaseButton>
    </div>

    <p class="text-xs leading-relaxed text-gray-400">
      使用提示：在 QQ 开放平台将事件订阅方式设为 WebSocket，并把你的 QQ 加入内部体验号码；保存设置后点击「从消息捕获」，再用 QQ 给机器人发任意一条消息即可绑定。用户需在机器人资料卡打开「允许主动消息」。账号下线时会推送原因提醒；微信账号的提醒附带「重新登录」按钮，点击后用已保存的扫码凭据自动重新获取登录 Code 并上线（无需再次扫码，首次需先在 Web 面板扫码登录一次）。QQ 账号请在 Web 面板手动处理。
    </p>

    <ConfirmModal
      :show="showDeleteConfirm"
      :loading="deletingUser"
      title="删除接收用户"
      :message="`确定要移除接收用户 ${users.find(u => u.openid === userToDelete)?.nickname || shortOpenid(userToDelete)} 吗？该账号的推送目标配置会一并清理。`"
      confirm-text="删除"
      type="danger"
      @close="!deletingUser && (showDeleteConfirm = false)"
      @cancel="!deletingUser && (showDeleteConfirm = false)"
      @confirm="confirmDeleteUser"
    />

    <!-- 推送记录弹窗（复用土地详情的 NModal + NCard 样式） -->
    <NModal :show="detailKind === 'sent'" @update:show="!$event && (detailKind = '')">
      <NCard class="push-detail-modal" :bordered="false" closable role="dialog" aria-modal="true" aria-label="推送记录" @close="detailKind = ''">
        <template #header>
          <span class="font-display">推送记录 <span class="text-sm opacity-50">共 {{ filteredRecords.length }} 条</span></span>
        </template>
        <div class="push-detail-scroll dialog-scroll">
          <div class="mb-2 space-y-1.5">
            <div class="flex flex-wrap items-center gap-1">
              <span class="w-12 shrink-0 text-[11px] text-gray-400">接收</span>
              <button class="detail-chip" :class="!detailRecipient ? 'detail-chip-active' : ''" @click="detailRecipient = ''; detailAccount = ''">全部</button>
              <button v-for="oid in detailRecipients" :key="oid" class="detail-chip" :class="detailRecipient === oid ? 'detail-chip-active' : ''" @click="detailRecipient = oid; detailAccount = ''">{{ recipientLabel(oid) }}</button>
            </div>
            <div class="flex flex-wrap items-center gap-1">
              <span class="w-12 shrink-0 text-[11px] text-gray-400">账号</span>
              <button class="detail-chip" :class="!detailAccount ? 'detail-chip-active' : ''" @click="detailAccount = ''">全部</button>
              <button v-for="aid in detailAccounts" :key="aid" class="detail-chip" :class="detailAccount === aid ? 'detail-chip-active' : ''" @click="detailAccount = aid">{{ accountLabel(aid) }}</button>
            </div>
            <div class="flex flex-wrap items-center gap-1">
              <span class="w-12 shrink-0 text-[11px] text-gray-400">日期</span>
              <button class="detail-chip" :class="!detailDate ? 'detail-chip-active' : ''" @click="detailDate = ''">全部</button>
              <button v-for="d in detailDates" :key="d" class="detail-chip" :class="detailDate === d ? 'detail-chip-active' : ''" @click="detailDate = d">{{ dateLabel(d) }}</button>
              <button v-if="detailDate" class="ml-1 rounded-full border border-red-300 px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-900/20" :disabled="deletingDay" @click="deleteDayRecords">{{ deletingDay ? '删除中…' : '删除当天' }}</button>
            </div>
          </div>
          <div v-if="detailsLoading" class="py-8 text-center text-xs text-gray-400">加载中…</div>
          <div v-else-if="!filteredRecords.length" class="py-8 text-center text-xs text-gray-400">暂无推送记录</div>
          <div v-else class="space-y-2">
            <div v-for="r in filteredRecords" :key="r.id">
              <div class="mb-1 flex items-center gap-2 text-[11px] text-gray-400">
                <span>{{ new Date(r.time).toLocaleString('zh-CN', { hour12: false }) }}</span>
                <span>· {{ accountLabel(r.accountId) }}</span>
                <span v-if="r.recipientName">→ {{ r.recipientName }}</span>
              </div>
              <PushMessageCard :content="r.content" :media-map="mediaMap" />
            </div>
          </div>
        </div>
      </NCard>
    </NModal>

    <!-- 待发送队列弹窗 -->
    <NModal :show="detailKind === 'queued'" @update:show="!$event && (detailKind = '')">
      <NCard class="push-detail-modal" :bordered="false" closable role="dialog" aria-modal="true" aria-label="待发送队列" @close="detailKind = ''">
        <template #header>
          <span class="font-display">待发送队列 <span class="text-sm opacity-50">共 {{ filteredQueue.length }} 条</span></span>
        </template>
        <div class="push-detail-scroll dialog-scroll">
          <div class="mb-2 flex flex-wrap items-center gap-1">
            <button class="detail-chip" :class="!detailAccount ? 'detail-chip-active' : ''" @click="detailAccount = ''">全部</button>
            <button v-for="a in Array.from(new Set(details.queue.map((q: any) => String(q.accountId))))" :key="a" class="detail-chip" :class="detailAccount === a ? 'detail-chip-active' : ''" @click="detailAccount = a">{{ accountLabel(a) }}</button>
          </div>
          <div v-if="detailsLoading" class="py-8 text-center text-xs text-gray-400">加载中…</div>
          <div v-else-if="!filteredQueue.length" class="py-8 text-center text-xs text-gray-400">队列为空</div>
          <div v-else class="space-y-2">
            <div v-for="(q, i) in filteredQueue" :key="i" class="rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-800/60">
              <div class="mb-1 flex items-center gap-2 text-[11px] text-gray-400">
                <span>{{ accountLabel(q.accountId) }}</span>
                <span v-if="q.retry">· 图标重传 {{ q.retry }} 次</span>
              </div>
              <div class="font-medium text-gray-700 dark:text-gray-200">{{ q.label }}</div>
              <div class="mt-0.5 text-gray-600 dark:text-gray-300">{{ q.msg }}</div>
            </div>
          </div>
        </div>
      </NCard>
    </NModal>

    <!-- 图标素材库弹窗 -->
    <NModal :show="detailKind === 'media'" @update:show="!$event && (detailKind = '')">
      <NCard class="push-detail-modal" :bordered="false" closable role="dialog" aria-modal="true" aria-label="图标素材库" @close="detailKind = ''">
        <template #header>
          <span class="font-display">图标素材库 <span class="text-sm opacity-50">共 {{ details.media.length }} 张（不区分账号）</span></span>
        </template>
        <div class="push-detail-scroll dialog-scroll">
          <div v-if="detailsLoading" class="py-8 text-center text-xs text-gray-400">加载中…</div>
          <div v-else-if="!details.media.length" class="py-8 text-center text-xs text-gray-400">暂无素材</div>
          <div v-else class="grid grid-cols-5 gap-2 sm:grid-cols-6">
            <div v-for="m in details.media" :key="m.key" class="flex flex-col items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1.5 dark:border-gray-700 dark:bg-gray-800/60" :title="m.name">
              <img v-if="m.localPath?.startsWith('/game-config/')" :src="m.localPath" :alt="m.name" class="h-8 w-8 object-contain" loading="lazy">
              <div v-else class="i-carbon-image h-8 w-8 text-gray-300" />
              <span class="w-full truncate text-center text-[10px] text-gray-500 dark:text-gray-400">{{ m.name }}</span>
            </div>
          </div>
        </div>
      </NCard>
    </NModal>
  </div>
</template>

<!-- 非 scoped：NModal 内容 teleport 到 body，需要全局类 -->
<style>
.detail-chip {
  border-radius: 9999px;
  border: 1px solid rgb(229 231 235);
  padding: 3px 10px;
  font-size: 12px;
  line-height: 1.25rem;
  color: rgb(107 114 128);
  transition: all .15s;
  white-space: nowrap;
}
.detail-chip:hover { border-color: rgb(156 163 175); }
.detail-chip-active {
  border-color: rgb(34 197 94);
  background-color: rgb(34 197 94 / .1);
  color: rgb(22 163 74);
}
.dark .detail-chip { border-color: rgb(55 65 81); color: rgb(156 163 175); }
.dark .detail-chip-active { border-color: rgb(74 222 128); color: rgb(74 222 128); }
/* 推送详情弹窗：与土地详情一致的 NModal + NCard 样式 */
.push-detail-modal {
  width: min(640px, calc(100vw - 24px));
  max-height: calc(100dvh - 32px);
  border-radius: 20px;
}
.push-detail-modal .n-card-header {
  padding: 16px 24px;
  border-bottom: 1px solid rgba(58, 86, 68, 0.11);
}
.push-detail-modal .n-card-content {
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding-top: 16px;
}
.push-detail-scroll {
  min-height: 0;
  max-height: calc(100dvh - 160px);
  overflow-y: auto;
}
@media (max-width: 640px) {
  .push-detail-modal { width: calc(100vw - 16px); }
  .push-detail-modal .n-card-header { padding: 12px 16px; }
  .push-detail-modal .n-card-content { padding-left: 16px; padding-right: 16px; }
}
</style>
