<script setup lang="ts">
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { onMounted, reactive, ref } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'

interface AdminUser {
  username: string
  role: string
  qq: string
  accountLimit: number
  card?: {
    code?: string
    description?: string
    type?: string
    isPermanent?: boolean
    expiresAt?: number | null
    enabled?: boolean
  } | null
}

interface AdminCard {
  code: string
  description: string
  type: string
  enabled: boolean
  usedBy?: string | null
  usedAt?: number | null
  createdAt?: number
  days?: number
  durationValue?: number
  durationUnit?: string
  isPermanent?: boolean
  value?: number
}

const toast = useToastStore()
const activeTab = ref('users')
const loading = ref(false)

const users = ref<AdminUser[]>([])
const cards = ref<AdminCard[]>([])
const loginLogs = ref<any[]>([])
const claimStatus = reactive({ enabled: false, availableTimeCards: 0 })

const announcementForm = reactive({ content: '', showOnce: true, updatedAt: 0 })
const announcementSaving = ref(false)

// ---------- 抓包服务 ----------
const captureForm = reactive({
  enabled: false,
  embedded: true,
  apiBase: 'http://127.0.0.1:8450',
  apiToken: '',
  autoImportQqGids: true,
})
const captureTokenConfigured = ref(false)
const captureSaving = ref(false)
const captureTesting = ref(false)

// ---------- 用户编辑 ----------
const editVisible = ref(false)
const editSaving = ref(false)
const editForm = reactive({
  username: '',
  newUsername: '',
  password: '',
  qq: '',
  accountLimit: 1,
  isPermanent: false,
  expiresAt: '',
})

// ---------- 用户续费 ----------
const renewVisible = ref(false)
const renewSaving = ref(false)
const renewTarget = ref('')
const renewCardCode = ref('')

// ---------- 卡密创建 ----------
const cardCreateVisible = ref(false)
const cardCreateSaving = ref(false)
const cardForm = reactive({
  description: '',
  type: 'time',
  durationValue: 30,
  durationUnit: 'day',
  isPermanent: false,
  value: 30,
  count: 1,
})

// ---------- 通用确认 ----------
const confirmShow = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmType = ref<'danger' | 'primary'>('danger')
let confirmAction: null | (() => Promise<void> | void) = null

function askConfirm(title: string, message: string, action: () => Promise<void> | void, type: 'danger' | 'primary' = 'danger') {
  confirmTitle.value = title
  confirmMessage.value = message
  confirmType.value = type
  confirmAction = action
  confirmShow.value = true
}

async function runConfirm() {
  const action = confirmAction
  confirmShow.value = false
  confirmAction = null
  if (action)
    await action()
}

async function loadUsers() {
  const res = await api.get('/api/admin/users')
  if (res.data.ok)
    users.value = res.data.data || []
}

async function loadCards() {
  const res = await api.get('/api/admin/cards')
  if (res.data.ok)
    cards.value = res.data.data || []
}

async function loadClaimStatus() {
  try {
    const res = await api.get('/api/card-claim/status')
    if (res.data.ok) {
      claimStatus.enabled = !!res.data.enabled
      claimStatus.availableTimeCards = Number(res.data.availableTimeCards || 0)
    }
  }
  catch {
    // 忽略
  }
}

async function loadAnnouncement() {
  const res = await api.get('/api/admin/announcement')
  if (res.data.ok && res.data.data) {
    announcementForm.content = res.data.data.content || ''
    announcementForm.showOnce = res.data.data.showOnce !== false
    announcementForm.updatedAt = res.data.data.updatedAt || 0
  }
}

async function loadLoginLogs() {
  const res = await api.get('/api/admin/login-logs', { params: { limit: 100 } })
  if (res.data.ok)
    loginLogs.value = res.data.data?.logs || []
}

async function loadCaptureConfig() {
  try {
    const res = await api.get('/api/admin/capture-config')
    if (res.data.ok && res.data.data) {
      const data = res.data.data
      captureForm.enabled = !!data.enabled
      captureForm.embedded = data.embedded !== false
      captureForm.apiBase = data.apiBase || 'http://127.0.0.1:8450'
      captureForm.apiToken = ''
      captureForm.autoImportQqGids = data.autoImportQqGids !== false
      captureTokenConfigured.value = !!data.tokenConfigured
    }
  }
  catch {
    // 忽略
  }
}

async function saveCaptureConfig() {
  captureSaving.value = true
  try {
    const res = await api.post('/api/admin/capture-config', {
      confirmed: true,
      enabled: captureForm.enabled,
      embedded: captureForm.embedded,
      apiBase: captureForm.apiBase,
      apiToken: captureForm.apiToken,
      autoImportQqGids: captureForm.autoImportQqGids,
    })
    if (res.data.ok) {
      toast.success('抓包服务配置已保存')
      await loadCaptureConfig()
    }
  }
  finally {
    captureSaving.value = false
  }
}

async function testCaptureConfig() {
  captureTesting.value = true
  try {
    const res = await api.post('/api/admin/capture-config/test', {
      embedded: captureForm.embedded,
      apiBase: captureForm.apiBase,
      apiToken: captureForm.apiToken,
    }, { timeout: 20000 })
    if (res.data.ok) {
      const port = Number(res.data.data?.proxyPort) || 18000
      toast.success(`连接成功，代理端口 ${port} 可用`)
    }
  }
  catch {
    // 错误已由拦截器提示
  }
  finally {
    captureTesting.value = false
  }
}

async function refreshAll() {
  loading.value = true
  try {
    await Promise.all([loadUsers(), loadCards(), loadClaimStatus(), loadAnnouncement(), loadLoginLogs(), loadCaptureConfig()])
  }
  finally {
    loading.value = false
  }
}

function formatTime(value?: number | null) {
  if (!value)
    return '-'
  return new Date(value).toLocaleString()
}

function cardStatusText(user: AdminUser) {
  const card = user.card
  if (!card)
    return '无卡密'
  if (card.isPermanent)
    return '永久'
  if (!card.expiresAt)
    return '未激活'
  return card.expiresAt < Date.now() ? '已过期' : `到期 ${formatTime(card.expiresAt)}`
}

function cardStatusClass(user: AdminUser) {
  const card = user.card
  if (!card)
    return 'text-muted'
  if (card.isPermanent)
    return 'text-success'
  if (!card.expiresAt)
    return 'text-muted'
  return card.expiresAt < Date.now() ? 'text-danger' : 'text-success'
}

// ---------- 用户操作 ----------
function openEdit(user: AdminUser) {
  editForm.username = user.username
  editForm.newUsername = user.username
  editForm.password = ''
  editForm.qq = user.qq || ''
  editForm.accountLimit = user.accountLimit || 1
  editForm.isPermanent = !!user.card?.isPermanent
  editForm.expiresAt = user.card?.expiresAt
    ? new Date(user.card.expiresAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : ''
  editVisible.value = true
}

async function saveEdit() {
  if (editForm.qq && !/^\d{5,12}$/.test(editForm.qq)) {
    toast.error('绑定QQ格式不正确（需为5-12位数字）')
    return
  }
  const payload: Record<string, any> = {
    confirmed: true,
    newUsername: editForm.newUsername || editForm.username,
    qq: editForm.qq,
    accountLimit: Number(editForm.accountLimit) || 1,
  }
  if (editForm.password)
    payload.password = editForm.password
  if (editForm.isPermanent) {
    payload.isPermanent = true
  }
  else if (editForm.expiresAt) {
    payload.expiresAt = new Date(editForm.expiresAt).getTime()
  }
  editSaving.value = true
  try {
    const res = await api.post(`/api/admin/users/${encodeURIComponent(editForm.username)}/edit`, payload)
    if (res.data.ok) {
      toast.success('用户已更新')
      editVisible.value = false
      await loadUsers()
    }
  }
  finally {
    editSaving.value = false
  }
}

function openRenew(user: AdminUser) {
  renewTarget.value = user.username
  renewCardCode.value = ''
  renewVisible.value = true
}

async function saveRenew() {
  if (!renewCardCode.value.trim()) {
    toast.error('请输入卡密')
    return
  }
  renewSaving.value = true
  try {
    const res = await api.post(`/api/admin/users/${encodeURIComponent(renewTarget.value)}/renew`, {
      confirmed: true,
      cardCode: renewCardCode.value.trim(),
    })
    if (res.data.ok) {
      toast.success('续费成功')
      renewVisible.value = false
      await loadUsers()
    }
  }
  finally {
    renewSaving.value = false
  }
}

function deleteUser(user: AdminUser) {
  askConfirm('删除用户', `确定删除用户「${user.username}」吗？该操作不可恢复。`, async () => {
    const res = await api.delete(`/api/admin/users/${encodeURIComponent(user.username)}`, {
      data: { confirmed: true },
    })
    if (res.data.ok) {
      toast.success('用户已删除')
      await loadUsers()
    }
  })
}

function clearExpired() {
  askConfirm('清理到期用户', '确定清理所有已到期的用户吗？', async () => {
    const res = await api.post('/api/admin/users/clear-expired', { confirmed: true })
    if (res.data.ok) {
      toast.success(`已清理 ${res.data.deletedCount || 0} 个到期用户`)
      await loadUsers()
    }
  })
}

// ---------- 卡密操作 ----------
function openCreateCard() {
  cardForm.description = ''
  cardForm.type = 'time'
  cardForm.durationValue = 30
  cardForm.durationUnit = 'day'
  cardForm.isPermanent = false
  cardForm.value = 30
  cardForm.count = 1
  cardCreateVisible.value = true
}

async function saveCreateCard() {
  if (!cardForm.description.trim()) {
    toast.error('请输入卡密描述')
    return
  }
  const payload: Record<string, any> = {
    confirmed: true,
    description: cardForm.description.trim(),
    type: cardForm.type,
    count: Number(cardForm.count) || 1,
  }
  if (cardForm.type === 'quota') {
    payload.value = Number(cardForm.value) || 1
    payload.days = payload.value
  }
  else {
    payload.durationValue = cardForm.isPermanent ? -1 : Number(cardForm.durationValue)
    payload.durationUnit = cardForm.durationUnit
    payload.isPermanent = cardForm.isPermanent
    payload.days = cardForm.isPermanent ? -1 : Number(cardForm.durationValue)
  }
  cardCreateSaving.value = true
  try {
    const res = await api.post('/api/admin/cards', payload)
    if (res.data.ok) {
      const count = res.data.batch ? res.data.count : 1
      toast.success(`已生成 ${count} 张卡密`)
      cardCreateVisible.value = false
      await loadCards()
      await loadClaimStatus()
    }
  }
  finally {
    cardCreateSaving.value = false
  }
}

async function toggleCard(card: AdminCard) {
  const res = await api.post(`/api/admin/cards/${encodeURIComponent(card.code)}`, {
    confirmed: true,
    enabled: !card.enabled,
  })
  if (res.data.ok) {
    card.enabled = !card.enabled
    await loadClaimStatus()
  }
}

function deleteCard(card: AdminCard) {
  askConfirm('删除卡密', `确定删除卡密「${card.code}」吗？`, async () => {
    const res = await api.delete(`/api/admin/cards/${encodeURIComponent(card.code)}`, {
      data: { confirmed: true },
    })
    if (res.data.ok) {
      toast.success('卡密已删除')
      await loadCards()
      await loadClaimStatus()
    }
  })
}

async function updateClaimStatus(enabled: boolean | undefined) {
  const next = enabled === true
  const res = await api.post('/api/admin/card-claim/status', { confirmed: true, enabled: next })
  if (res.data.ok) {
    claimStatus.enabled = !!res.data.enabled
    claimStatus.availableTimeCards = Number(res.data.availableTimeCards || 0)
    toast.success(next ? '已开启卡密领取' : '已关闭卡密领取')
  }
  else {
    claimStatus.enabled = !next
  }
}

// ---------- 公告 ----------
async function saveAnnouncement() {
  announcementSaving.value = true
  try {
    const res = await api.post('/api/admin/announcement', {
      content: announcementForm.content,
      showOnce: announcementForm.showOnce,
    })
    if (res.data.ok) {
      announcementForm.updatedAt = res.data.data?.updatedAt || Date.now()
      toast.success('公告已保存')
    }
  }
  finally {
    announcementSaving.value = false
  }
}

function deleteLoginLogs() {
  askConfirm('清空登录日志', '确定清空所有登录日志吗？', async () => {
    const res = await api.delete('/api/admin/login-logs')
    if (res.data.ok) {
      toast.success('登录日志已清空')
      await loadLoginLogs()
    }
  })
}

onMounted(refreshAll)
</script>

<template>
  <div class="admin-page">
    <header class="admin-header">
      <div>
        <h1>系统管理</h1>
        <p>用户、卡密与系统公告的集中管理</p>
      </div>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="refreshAll">
        刷新
      </BaseButton>
    </header>

    <NTabs v-model:value="activeTab" type="line" animated>
      <NTab name="users" tab="用户管理" />
      <NTab name="cards" tab="卡密管理" />
      <NTab name="announcement" tab="系统公告" />
      <NTab name="logs" tab="登录日志" />
      <NTab name="capture" tab="抓包服务" />
    </NTabs>

    <!-- 用户管理 -->
    <section v-if="activeTab === 'users'" class="admin-panel">
      <div class="panel-toolbar">
        <BaseButton variant="secondary" size="sm" @click="clearExpired">
          清理到期用户
        </BaseButton>
      </div>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>绑定QQ</th>
              <th>账号限额</th>
              <th>卡密状态</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.username">
              <td>{{ user.username }}</td>
              <td>{{ user.qq || '-' }}</td>
              <td>{{ user.accountLimit }}</td>
              <td :class="cardStatusClass(user)">{{ cardStatusText(user) }}</td>
              <td class="col-actions">
                <div class="row-actions">
                  <BaseButton variant="text" size="sm" @click="openEdit(user)">
                    编辑
                  </BaseButton>
                  <BaseButton variant="text" size="sm" @click="openRenew(user)">
                    续费
                  </BaseButton>
                  <BaseButton variant="text" size="sm" @click="deleteUser(user)">
                    删除
                  </BaseButton>
                </div>
              </td>
            </tr>
            <tr v-if="users.length === 0">
              <td colspan="5" class="empty-cell">暂无用户</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 卡密管理 -->
    <section v-else-if="activeTab === 'cards'" class="admin-panel">
      <div class="panel-toolbar panel-toolbar--between">
        <div class="claim-toggle">
          <BaseSwitch
            :model-value="claimStatus.enabled"
            @update:model-value="updateClaimStatus"
          />
          <span>允许用户领取时间卡密（可用 {{ claimStatus.availableTimeCards }} 张）</span>
        </div>
        <BaseButton variant="primary" size="sm" @click="openCreateCard">
          生成卡密
        </BaseButton>
      </div>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>卡密</th>
              <th>描述</th>
              <th>类型</th>
              <th>时长/额度</th>
              <th>状态</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="card in cards" :key="card.code">
              <td class="mono">{{ card.code }}</td>
              <td>{{ card.description || '-' }}</td>
              <td>{{ card.type === 'quota' ? '额度卡' : '时间卡' }}</td>
              <td>{{ card.type === 'quota' ? `${card.value ?? card.days ?? '-'} 次` : (card.isPermanent ? '永久' : `${card.durationValue ?? card.days ?? '-'} ${card.durationUnit === 'hour' ? '小时' : '天'}`) }}</td>
              <td>
                <span v-if="card.usedBy" class="text-muted">已使用</span>
                <span v-else :class="card.enabled ? 'text-success' : 'text-muted'">
                  {{ card.enabled ? '未使用' : '已禁用' }}
                </span>
              </td>
              <td class="col-actions">
                <div class="row-actions">
                  <BaseButton variant="text" size="sm" :disabled="!!card.usedBy" @click="toggleCard(card)">
                    {{ card.enabled ? '禁用' : '启用' }}
                  </BaseButton>
                  <BaseButton variant="text" size="sm" @click="deleteCard(card)">
                    删除
                  </BaseButton>
                </div>
              </td>
            </tr>
            <tr v-if="cards.length === 0">
              <td colspan="6" class="empty-cell">暂无卡密</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 系统公告 -->
    <section v-else-if="activeTab === 'announcement'" class="admin-panel">
      <div class="announcement-form">
        <label class="form-label">公告内容</label>
        <textarea
          v-model="announcementForm.content"
          class="announcement-textarea"
          rows="10"
          placeholder="输入需要展示给用户的公告内容，留空则关闭公告"
        />
        <div class="announcement-options">
          <BaseSwitch v-model="announcementForm.showOnce" label="每个用户仅展示一次" />
          <span class="text-muted">上次更新：{{ formatTime(announcementForm.updatedAt) }}</span>
        </div>
        <div class="panel-footer">
          <BaseButton variant="primary" :loading="announcementSaving" @click="saveAnnouncement">
            保存公告
          </BaseButton>
        </div>
      </div>
    </section>

    <!-- 登录日志 -->
    <section v-else-if="activeTab === 'logs'" class="admin-panel">
      <div class="panel-toolbar">
        <BaseButton variant="secondary" size="sm" @click="deleteLoginLogs">
          清空日志
        </BaseButton>
      </div>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>用户名</th>
              <th>结果</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(log, index) in loginLogs" :key="index">
              <td>{{ formatTime(log.at || log.time) }}</td>
              <td>{{ log.username || '-' }}</td>
              <td :class="log.success ? 'text-success' : 'text-danger'">
                {{ log.success ? '成功' : (log.reason || '失败') }}
              </td>
              <td>{{ log.ip || '-' }}</td>
            </tr>
            <tr v-if="loginLogs.length === 0">
              <td colspan="4" class="empty-cell">暂无日志</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 抓包服务 -->
    <section v-else-if="activeTab === 'capture'" class="admin-panel">
      <div class="capture-form">
        <p class="text-muted">
          启用后，「添加账号」对话框会显示「抓包登录」入口，用户可通过手机代理直接抓取登录 Code。
        </p>
        <BaseSwitch v-model="captureForm.enabled" label="启用抓包服务" />
        <BaseSwitch v-model="captureForm.embedded" label="内嵌模式（进程内运行，无需独立端口和 Token）" />
        <template v-if="!captureForm.embedded">
          <BaseInput v-model="captureForm.apiBase" label="抓包服务地址" placeholder="http://127.0.0.1:8450" />
          <BaseInput
            v-model="captureForm.apiToken"
            type="password"
            label="API Token"
            :placeholder="captureTokenConfigured ? '已配置，留空则保持不变' : '请输入 API Token'"
          />
        </template>
        <BaseSwitch v-model="captureForm.autoImportQqGids" label="自动导入 QQ 好友 GID" />
        <div class="panel-footer">
          <BaseButton variant="secondary" :loading="captureTesting" @click="testCaptureConfig">
            测试连接
          </BaseButton>
          <BaseButton variant="primary" :loading="captureSaving" @click="saveCaptureConfig">
            保存配置
          </BaseButton>
        </div>
      </div>
    </section>

    <!-- 编辑用户 -->
    <NModal
      :show="editVisible"
      preset="card"
      title="编辑用户"
      :style="{ width: 'min(460px, calc(100vw - 32px))' }"
      @update:show="editVisible = $event"
    >
      <div class="modal-form">
        <BaseInput v-model="editForm.username" label="用户名" disabled />
        <BaseInput v-model="editForm.newUsername" label="新用户名" placeholder="留空则保持不变" />
        <BaseInput v-model="editForm.password" type="password" label="新密码" placeholder="留空则保持不变" />
        <BaseInput v-model="editForm.qq" label="绑定QQ" placeholder="5-12位数字，留空解除绑定" />
        <BaseInput v-model="editForm.accountLimit" type="number" label="账号限额" :min="1" :max="100" />
        <BaseSwitch v-model="editForm.isPermanent" label="永久有效" />
        <BaseInput
          v-if="!editForm.isPermanent"
          v-model="editForm.expiresAt"
          type="datetime-local"
          label="到期时间"
        />
      </div>
      <template #footer>
        <div class="modal-footer">
          <BaseButton variant="secondary" @click="editVisible = false">
            取消
          </BaseButton>
          <BaseButton variant="primary" :loading="editSaving" @click="saveEdit">
            保存
          </BaseButton>
        </div>
      </template>
    </NModal>

    <!-- 续费 -->
    <NModal
      :show="renewVisible"
      preset="card"
      title="用户续费"
      :style="{ width: 'min(420px, calc(100vw - 32px))' }"
      @update:show="renewVisible = $event"
    >
      <div class="modal-form">
        <p class="text-muted">为用户「{{ renewTarget }}」使用卡密续费</p>
        <BaseInput v-model="renewCardCode" label="卡密" placeholder="请输入卡密" />
      </div>
      <template #footer>
        <div class="modal-footer">
          <BaseButton variant="secondary" @click="renewVisible = false">
            取消
          </BaseButton>
          <BaseButton variant="primary" :loading="renewSaving" @click="saveRenew">
            确认续费
          </BaseButton>
        </div>
      </template>
    </NModal>

    <!-- 生成卡密 -->
    <NModal
      :show="cardCreateVisible"
      preset="card"
      title="生成卡密"
      :style="{ width: 'min(460px, calc(100vw - 32px))' }"
      @update:show="cardCreateVisible = $event"
    >
      <div class="modal-form">
        <BaseInput v-model="cardForm.description" label="描述" placeholder="例如：月卡" />
        <BaseSelect
          v-model="cardForm.type"
          label="类型"
          :options="[{ label: '时间卡', value: 'time' }, { label: '额度卡', value: 'quota' }]"
        />
        <template v-if="cardForm.type === 'time'">
          <BaseSwitch v-model="cardForm.isPermanent" label="永久卡" />
          <template v-if="!cardForm.isPermanent">
            <BaseInput v-model="cardForm.durationValue" type="number" label="时长" :min="1" />
            <BaseSelect
              v-model="cardForm.durationUnit"
              label="单位"
              :options="[{ label: '天', value: 'day' }, { label: '小时', value: 'hour' }]"
            />
          </template>
        </template>
        <BaseInput v-else v-model="cardForm.value" type="number" label="额度" :min="1" />
        <BaseInput v-model="cardForm.count" type="number" label="生成数量" :min="1" :max="100" />
      </div>
      <template #footer>
        <div class="modal-footer">
          <BaseButton variant="secondary" @click="cardCreateVisible = false">
            取消
          </BaseButton>
          <BaseButton variant="primary" :loading="cardCreateSaving" @click="saveCreateCard">
            生成
          </BaseButton>
        </div>
      </template>
    </NModal>

    <ConfirmModal
      :show="confirmShow"
      :title="confirmTitle"
      :message="confirmMessage"
      :type="confirmType"
      @confirm="runConfirm"
      @cancel="confirmShow = false"
    />
  </div>
</template>

<style scoped>
.admin-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.admin-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.admin-header h1 {
  margin: 0;
  font-size: 22px;
}

.admin-header p {
  margin: 4px 0 0;
  color: var(--ui-muted);
  font-size: 13px;
}

.admin-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--ui-border);
  border-radius: 16px;
  background: rgba(250, 251, 247, 0.82);
  box-shadow: var(--ui-shadow-sm);
}

.panel-toolbar {
  display: flex;
  gap: 10px;
}

.panel-toolbar--between {
  align-items: center;
  justify-content: space-between;
}

.claim-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.table-wrap {
  overflow-x: auto;
}

.admin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.admin-table th,
.admin-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  white-space: nowrap;
}

.admin-table th {
  color: var(--ui-muted);
  font-weight: 600;
}

.col-actions {
  text-align: right;
}

.row-actions {
  display: inline-flex;
  gap: 4px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty-cell {
  color: var(--ui-muted);
  text-align: center;
}

.text-muted {
  color: var(--ui-muted);
}

.text-success {
  color: #2e714b;
}

.text-danger {
  color: #984049;
}

.announcement-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.capture-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 560px;
}

.form-label {
  font-size: 13px;
  font-weight: 600;
}

.announcement-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: #fff;
  color: var(--ui-ink);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}

.announcement-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.panel-footer,
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

@media (max-width: 640px) {
  .panel-toolbar--between {
    flex-direction: column;
    align-items: stretch;
  }

  .announcement-options {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
