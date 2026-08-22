<script setup lang="ts">
import {NCard, NModal, NRadio, NRadioGroup, NTab, NTabs} from 'naive-ui'
import {onBeforeUnmount, reactive, ref, watch} from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import {runWxLoginStatusPoll} from '@/utils/wx-login-poll'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<'code' | 'wx_qr'>('code')
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
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    } else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  } catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  } finally {
    loading.value = false
  }
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }

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
      payload = {id: props.editData.id, name: form.name}
    } else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  } else {
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
    void api.delete(`/api/wx-login/tasks/${oldTaskId}`, {skipErrorToast: true} as any).catch(() => undefined)
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
  await addAccount({name: form.name, code, platform: 'wx', loginType: 'manual'})
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
    } else if (status === 'scanned') {
      wxStatus.value = '已扫码，请在手机上确认'
    } else if (status === 'authorized') {
      stopWxPolling()
      await confirmWxLogin(taskId, flowVersion)
      return
    } else if (['cancelled', 'expired', 'failed'].includes(status)) {
      wxError.value = '二维码已失效，请重新获取'
      return
    }
    wxPollTimer = setTimeout(() => void pollWxLogin(taskId, flowVersion), 1200)
  } catch (error: any) {
    if (!isWxFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    wxError.value = error.response?.data?.error || error.message || '登录状态检查失败'
  } finally {
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
  } finally {
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
    const response = await api.post('/api/wx-login/tasks', {app_id: 'wx5306c5978fdb76e4'})
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (flowVersion !== wxFlowVersion) {
      void api.delete(`/api/wx-login/tasks/${taskId}`, {skipErrorToast: true} as any).catch(() => undefined)
      return
    }
    wxTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, {responseType: 'blob'})
    if (!isWxFlowActive(taskId, flowVersion))
      return
    wxQrObjectUrl = URL.createObjectURL(qrResponse.data)
    wxQrUrl.value = wxQrObjectUrl
    wxStatus.value = '等待微信扫码'
    void pollWxLogin(taskId, flowVersion)
  } catch (error: any) {
    if (flowVersion !== wxFlowVersion)
      return
    wxError.value = error.response?.data?.error || error.message || '二维码获取失败'
  } finally {
    if (flowVersion === wxFlowVersion)
      wxLoading.value = false
  }
}

function close() {
  resetWxLogin()
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
    } else {
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
})

onBeforeUnmount(resetWxLogin)
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
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm"
             style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <NTabs v-if="form.platform === 'wx'" v-model:value="activeLoginTab" class="mb-4" type="line">
          <NTab name="code">
            输入 Code 登录
          </NTab>
          <NTab name="wx_qr">
            微信扫码登录
          </NTab>
        </NTabs>

        <div v-if="activeLoginTab === 'code'" class="space-y-4">
          <BaseInput
              v-model="form.name"
              label="账号备注（可选）"
              placeholder="留空默认账号"
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
        <div v-else class="space-y-4" role="tabpanel" aria-label="微信扫码登录">
          <BaseInput
              v-model="form.name"
              label="账号备注（可选）"
              placeholder="留空使用默认账号"
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
