<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NRadio, NRadioGroup } from 'naive-ui/es/radio'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { runWxLoginStatusPoll } from '@/utils/wx-login-poll'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<'code' | 'wx_qr' | 'qq_qr'>('code')
const qqTaskId = ref('')
const qqStatus = ref('')
const qqError = ref('')
const qqLoading = ref(false)
const qqQrUrl = ref('')
let qqPollTimer: ReturnType<typeof setTimeout> | undefined
let qqQrObjectUrl = ''
let qqFlowVersion = 0
let qqPollController: AbortController | undefined
let qqPollInFlight: Promise<void> | undefined
let qqPollKey = ''
const wxTaskId = ref('')
const wxStatus = ref('')
const wxError = ref('')
const wxLoading = ref(false)
const wxQrUrl = ref('')
let wxPollTimer: ReturnType<typeof setTimeout> | undefined
let wxQrObjectUrl = ''
let wxFlowVersion = 0
let wxPollController: AbortController | undefined
let wxPollInFlight: Promise<void> | undefined
let wxPollKey = ''

// 表单数据
const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

// 添加账号
async function addAccount(data: any) {
  const name = String(data?.name || '').trim()

  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', { ...data, name })
    if (res.data.ok) {
      emit('saved')
      close()
      return true
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }

  return false
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!form.name.trim()) {
    errorMessage.value = '请输入账号备注'
    return
  }
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }
  form.name = form.name.trim()

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

function stopWxPolling() {
  if (wxPollTimer) {
    clearTimeout(wxPollTimer)
    wxPollTimer = undefined
  }
  wxPollController?.abort()
  wxPollController = undefined
}

function resetWxLogin() {
  const oldTaskId = wxTaskId.value
  wxFlowVersion += 1
  stopWxPolling()
  if (oldTaskId) {
    void api.delete(`/api/wx-login/tasks/${oldTaskId}`, { skipErrorToast: true } as any).catch(() => undefined)
  }
  if (wxQrObjectUrl) {
    URL.revokeObjectURL(wxQrObjectUrl)
    wxQrObjectUrl = ''
  }
  wxTaskId.value = ''
  wxStatus.value = ''
  wxError.value = ''
  wxQrUrl.value = ''
  wxLoading.value = false
}

function isWxFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === wxFlowVersion && taskId === wxTaskId.value
}

// ===== QQ 扫码登录（NapCat bridge）=====
function stopQqPolling() {
  if (qqPollTimer) {
    clearTimeout(qqPollTimer)
    qqPollTimer = undefined
  }
  qqPollController?.abort()
  qqPollController = undefined
}

function resetQqLogin() {
  const oldTaskId = qqTaskId.value
  qqFlowVersion += 1
  stopQqPolling()
  if (oldTaskId) {
    void api.delete(`/api/qq-login/tasks/${oldTaskId}`, { skipErrorToast: true } as any).catch(() => undefined)
  }
  if (qqQrObjectUrl) {
    URL.revokeObjectURL(qqQrObjectUrl)
    qqQrObjectUrl = ''
  }
  qqTaskId.value = ''
  qqStatus.value = ''
  qqError.value = ''
  qqQrUrl.value = ''
  qqLoading.value = false
}

function isQqFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === qqFlowVersion && taskId === qqTaskId.value
}

async function getQqCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return
  const codeResult = await api.post(`/api/qq-login/tasks/${taskId}/code`)
  if (!isQqFlowActive(taskId, flowVersion))
    return
  const code = String(codeResult.data?.data?.code || '').trim()
  if (!code)
    throw new Error('未获取到登录 Code')
  // 复用现有添加账号链路（含 loginBuffer 自动续码），与手动表单同一 payload。
  await addAccount({ name: form.name.trim(), code, platform: 'qq', loginType: 'manual' })
}

async function pollQqLoginRequest(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return
  const controller = new AbortController()
  qqPollController = controller
  try {
    const response = await runWxLoginStatusPoll(() => api.get(`/api/qq-login/tasks/${taskId}/status`, {
      timeout: 40000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any))
    if (!isQqFlowActive(taskId, flowVersion))
      return
    const status = response.data?.data?.status
    if (status === 'waiting') {
      qqStatus.value = '等待 QQ 扫码'
    }
    else if (status === 'scanned') {
      qqStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'authorized') {
      stopQqPolling()
      await getQqCodeAndAdd(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      qqError.value = '二维码已失效，请重新获取'
      return
    }
    qqPollTimer = setTimeout(() => void pollQqLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isQqFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    qqError.value = error.response?.data?.error || error.message || '登录状态检查失败'
  }
  finally {
    if (qqPollController === controller)
      qqPollController = undefined
  }
}

async function pollQqLogin(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return
  const previous = qqPollInFlight
  const previousKey = qqPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isQqFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }
  const current = pollQqLoginRequest(taskId, flowVersion)
  qqPollInFlight = current
  qqPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (qqPollInFlight === current) {
      qqPollInFlight = undefined
      qqPollKey = ''
    }
  }
}

async function startQqLogin() {
  resetQqLogin()
  const flowVersion = qqFlowVersion
  qqLoading.value = true
  try {
    const response = await api.post('/api/qq-login/tasks', {})
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (flowVersion !== qqFlowVersion) {
      void api.delete(`/api/qq-login/tasks/${taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    qqTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, { responseType: 'blob' })
    if (!isQqFlowActive(taskId, flowVersion))
      return
    qqQrObjectUrl = URL.createObjectURL(qrResponse.data)
    qqQrUrl.value = qqQrObjectUrl
    qqStatus.value = '等待 QQ 扫码'
    void pollQqLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion !== qqFlowVersion)
      return
    qqError.value = error.response?.data?.error || error.message || '二维码获取失败'
  }
  finally {
    if (flowVersion === qqFlowVersion)
      qqLoading.value = false
  }
}

async function getWxCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const codeResult = await api.post(`/api/wx-login/tasks/${taskId}/code`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const code = String(codeResult.data?.data?.code || '').trim()
  if (!code)
    throw new Error('未获取到登录 Code')

  // Deliberately use the same account API and payload as the manual form.
  // 备注留空时由后端自动生成默认名称
  await addAccount({ name: form.name.trim(), code, platform: 'wx', loginType: 'manual' })
}

async function confirmWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  wxStatus.value = '正在建立登录会话...'
  await api.post(`/api/wx-login/tasks/${taskId}/confirm`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  await getWxCodeAndAdd(taskId, flowVersion)
}

async function pollWxLoginRequest(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const controller = new AbortController()
  wxPollController = controller
  try {
    const response = await runWxLoginStatusPoll(() => api.get(`/api/wx-login/tasks/${taskId}/status`, {
      timeout: 40000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any))
    if (!isWxFlowActive(taskId, flowVersion))
      return
    const status = response.data?.data?.status
    if (status === 'waiting') {
      wxStatus.value = '等待微信扫码'
    }
    else if (status === 'scanned') {
      wxStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'authorized') {
      stopWxPolling()
      await confirmWxLogin(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      wxError.value = '二维码已失效，请重新获取'
      return
    }
    wxPollTimer = setTimeout(() => void pollWxLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isWxFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    wxError.value = error.response?.data?.error || error.message || '登录状态检查失败'
  }
  finally {
    if (wxPollController === controller)
      wxPollController = undefined
  }
}

async function pollWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const previous = wxPollInFlight
  const previousKey = wxPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isWxFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }

  const current = pollWxLoginRequest(taskId, flowVersion)
  wxPollInFlight = current
  wxPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (wxPollInFlight === current) {
      wxPollInFlight = undefined
      wxPollKey = ''
    }
  }
}

async function startWxLogin() {
  resetWxLogin()
  const flowVersion = wxFlowVersion
  wxLoading.value = true
  try {
    const response = await api.post('/api/wx-login/tasks', { app_id: 'wx5306c5978fdb76e4' })
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (flowVersion !== wxFlowVersion) {
      void api.delete(`/api/wx-login/tasks/${taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    wxTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, { responseType: 'blob' })
    if (!isWxFlowActive(taskId, flowVersion))
      return
    wxQrObjectUrl = URL.createObjectURL(qrResponse.data)
    wxQrUrl.value = wxQrObjectUrl
    wxStatus.value = '等待微信扫码'
    void pollWxLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion !== wxFlowVersion)
      return
    wxError.value = error.response?.data?.error || error.message || '二维码获取失败'
  }
  finally {
    if (flowVersion === wxFlowVersion)
      wxLoading.value = false
  }
}

function close() {
  resetWxLogin()
  resetQqLogin()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    activeLoginTab.value = 'code'
    resetWxLogin()
    if (props.editData) {
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
    }
    else {
      form.name = ''
      form.code = ''
      form.platform = 'qq'
    }
  }
})

watch(activeLoginTab, (tab) => {
  if (tab === 'wx_qr' && !wxTaskId.value)
    void startWxLogin()
  else if (tab !== 'wx_qr')
    resetWxLogin()
  if (tab === 'qq_qr' && !qqTaskId.value)
    void startQqLogin()
  else if (tab !== 'qq_qr')
    resetQqLogin()
})

onBeforeUnmount(() => {
  resetWxLogin()
  resetQqLogin()
})
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading && !wxLoading"
    :close-on-esc="!loading && !wxLoading"
    @update:show="value => !value && close()"
  >
    <NCard
      class="account-modal-card"
      :title="editData ? '编辑账号' : '添加账号'"
      :bordered="false"
      :closable="!loading && !wxLoading"
      @close="close"
    >
      <div class="account-modal-content overflow-y-auto">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <NTabs v-if="!editData" v-model:value="activeLoginTab" class="mb-4" type="line">
          <NTab name="code">
            输入 Code 登录
          </NTab>
          <NTab name="wx_qr">
            微信扫码登录
          </NTab>
          <NTab name="qq_qr">
            QQ 扫码登录
          </NTab>
        </NTabs>

        <div v-if="editData || activeLoginTab === 'code'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
            class="farm-input"
          />

          <NRadioGroup v-if="!editData" v-model:value="form.platform" name="account-platform">
            <div class="flex gap-5">
              <NRadio value="qq">
                QQ 小程序
              </NRadio>
              <NRadio value="wx">
                微信小程序
              </NRadio>
            </div>
          </NRadioGroup>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'wx_qr'" class="space-y-4" role="tabpanel" aria-label="微信扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（选填）"
            placeholder="留空自动生成"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="wxQrUrl" class="bg-white p-2">
              <img :src="wxQrUrl" alt="微信登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ wxLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxStatus }}
            </p>
            <p v-if="wxError" class="text-sm text-red-500">
              {{ wxError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="startWxLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'qq_qr'" class="space-y-4" role="tabpanel" aria-label="QQ 扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（选填）"
            placeholder="留空自动生成"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="qqQrUrl" class="bg-white p-2">
              <img :src="qqQrUrl" alt="QQ 登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ qqLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ qqStatus }}
            </p>
            <p v-if="qqError" class="text-sm text-red-500">
              {{ qqError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="startQqLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.account-modal-card {
  width: min(448px, calc(100vw - 32px));
}

.account-modal-content {
  max-height: calc(90vh - 100px);
}
</style>
