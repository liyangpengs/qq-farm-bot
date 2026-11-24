<script setup lang="ts">
import type { OfflineChannelConfig, OfflineConfig, PushChannelChange } from '@/stores/setting'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NSwitch } from 'naive-ui/es/switch'
import { computed, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import {
  getPushChannelDocUrl,
  getPushChannelLabel,
  isPushChannelConfigured,
  normalizeChannelEntry,
  PUSH_CHANNEL_OPTIONS,
  validateDingTalkWebhook,
} from '@/stores/setting'
import { useToastStore } from '@/stores/toast'

interface ChannelListItem {
  value: string
  label: string
  configured: boolean
  enabled: boolean
}

const props = defineProps<{
  config: OfflineConfig
  supportsChannels: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: 'saveChannel', change: PushChannelChange, onDone: (ok: boolean) => void): void
}>()

const toast = useToastStore()

const listOpen = ref(false)
const searchQuery = ref('')

const editingChannel = ref<string | null>(null)
const draftEndpoint = ref('')
const draftToken = ref('')
const draftSecret = ref('')
const draftEnabled = ref(true)
const channelTesting = ref(false)
const channelActionError = ref('')

const channelMap = computed(() => {
  const map = new Map<string, OfflineChannelConfig>()
  for (const item of props.config.channels)
    map.set(item.channel, item)
  return map
})

const configuredChannels = computed(() =>
  props.config.channels.filter(item => isPushChannelConfigured(item)),
)

const activeChannels = computed(() =>
  configuredChannels.value.filter(item => item.enabled),
)

const summaryBadge = computed(() => {
  if (activeChannels.value.length > 0)
    return { text: `已启用 ${activeChannels.value.length} 个`, tone: 'active' as const }
  if (configuredChannels.value.length > 0)
    return { text: `已配置 ${configuredChannels.value.length} 个（未启用）`, tone: 'idle' as const }
  return { text: '未配置', tone: 'empty' as const }
})

const sortedChannelItems = computed<ChannelListItem[]>(() => {
  const kw = searchQuery.value.trim().toLowerCase()
  const list = PUSH_CHANNEL_OPTIONS
    .filter(opt => !kw || opt.label.toLowerCase().includes(kw) || opt.value.toLowerCase().includes(kw))
    .map((opt) => {
      const saved = channelMap.value.get(opt.value) || null
      const configured = saved ? isPushChannelConfigured(saved) : false
      return {
        value: opt.value,
        label: opt.label,
        configured,
        enabled: configured && Boolean(saved?.enabled),
      }
    })

  return list.sort((a, b) => {
    const rank = (x: ChannelListItem) => (x.enabled ? 0 : x.configured ? 1 : 2)
    return rank(a) - rank(b)
  })
})

const editingLabel = computed(() => editingChannel.value ? getPushChannelLabel(editingChannel.value) : '')
const editingDocUrl = computed(() => editingChannel.value ? getPushChannelDocUrl(editingChannel.value) : '')
const editingExisting = computed(() => editingChannel.value ? channelMap.value.get(editingChannel.value) || null : null)
const editingWasConfigured = computed(() => isPushChannelConfigured(editingExisting.value || undefined))

const isDingTalk = computed(() => editingChannel.value === 'dingtalk')
const isWebhook = computed(() => editingChannel.value === 'webhook')
const isMeow = computed(() => editingChannel.value === 'meow')
const usesEndpoint = computed(() => isWebhook.value || isDingTalk.value || isMeow.value)

const endpointLabel = computed(() => isDingTalk.value ? 'Webhook 地址' : isMeow.value ? '接口地址（可选）' : '接口地址')
const endpointPlaceholder = computed(() => isDingTalk.value
  ? '从钉钉群机器人设置页复制完整 Webhook'
  : '接收消息的接口地址')
const tokenLabel = computed(() => isMeow.value ? '昵称' : 'Token')
const tokenPlaceholder = computed(() => isMeow.value ? 'MeoW 注册昵称' : '接收端 token')

const dingTalkInlineError = computed(() => {
  if (!isDingTalk.value || !draftEndpoint.value.trim())
    return ''
  return validateDingTalkWebhook(draftEndpoint.value)
})

const isDraftConfigured = computed(() => {
  if (!editingChannel.value)
    return false
  return isPushChannelConfigured({
    channel: editingChannel.value,
    endpoint: draftEndpoint.value,
    token: draftToken.value,
  })
})

const canEnableDraft = computed(() => isDraftConfigured.value && !dingTalkInlineError.value)
const effectiveDraftEnabled = computed(() => canEnableDraft.value && draftEnabled.value)
const modalBusy = computed(() => Boolean(props.saving) || channelTesting.value)

function openListModal() {
  searchQuery.value = ''
  listOpen.value = true
}

function openChannelEditor(channelValue: string, hint?: string) {
  const existing = channelMap.value.get(channelValue)
  editingChannel.value = channelValue
  draftEndpoint.value = existing?.endpoint || ''
  draftToken.value = existing?.token || ''
  draftSecret.value = existing?.secret || ''
  draftEnabled.value = existing && isPushChannelConfigured(existing) ? existing.enabled : true
  channelActionError.value = ''
  if (hint)
    toast.info(hint)
}

function openDocs(url: string) {
  if (url)
    window.open(url, '_blank', 'noopener,noreferrer')
}

function handleToggle(channel: string, enabled: boolean) {
  emit('saveChannel', { channel, enabled }, (ok) => {
    if (ok)
      toast.success(`${enabled ? '已启用' : '已停用'} ${getPushChannelLabel(channel)}`)
  })
}

function handleDisabledSwitchTap(item: ChannelListItem) {
  if (item.configured || props.saving)
    return
  openChannelEditor(item.value, '请先完成配置后再启用')
}

function handleDraftEnabledChange(value?: boolean) {
  if (!canEnableDraft.value) {
    toast.warning('请先填写有效的推送配置后再启用')
    return
  }
  draftEnabled.value = Boolean(value)
}

async function handleTestChannel() {
  if (!editingChannel.value || channelTesting.value)
    return
  channelActionError.value = ''
  if (!isDraftConfigured.value) {
    channelActionError.value = isDingTalk.value
      ? '请填写钉钉机器人 Webhook 地址'
      : isWebhook.value
        ? '请填写 Webhook 接口地址'
        : isMeow.value
          ? '请填写 MeoW 昵称'
          : '请填写接收端 Token'
    return
  }
  if (isDingTalk.value) {
    const err = validateDingTalkWebhook(draftEndpoint.value)
    if (err) {
      channelActionError.value = err
      return
    }
  }

  channelTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', {
      channel: editingChannel.value,
      endpoint: draftEndpoint.value.trim(),
      token: isDingTalk.value ? '' : draftToken.value.trim(),
      secret: isDingTalk.value ? draftSecret.value.trim() : '',
      title: props.config.title || '账号下线提醒',
      msg: props.config.msg || '账号下线',
    })
    if (data?.ok) {
      toast.success(`${editingLabel.value} 测试消息发送成功`)
    }
    else {
      channelActionError.value = `测试失败: ${getApiErrorMessage(data, '未知错误')}`
    }
  }
  catch (e: any) {
    channelActionError.value = `测试失败: ${getApiErrorMessage(e, '请求失败')}`
  }
  finally {
    channelTesting.value = false
  }
}

function handleSaveChannel() {
  if (!editingChannel.value || modalBusy.value)
    return
  channelActionError.value = ''

  if (!isDraftConfigured.value) {
    channelActionError.value = isDingTalk.value
      ? '请填写钉钉机器人 Webhook 地址；如需移除该渠道，请点击左下角“清空配置”'
      : isWebhook.value
        ? '请填写接口地址；如需移除该渠道，请点击左下角“清空配置”'
        : isMeow.value
          ? '请填写昵称；如需移除该渠道，请点击左下角“清空配置”'
          : '请填写 Token；如需移除该渠道，请点击左下角“清空配置”'
    return
  }

  if (isDingTalk.value) {
    const err = validateDingTalkWebhook(draftEndpoint.value)
    if (err) {
      channelActionError.value = err
      return
    }
  }

  const normalized = normalizeChannelEntry({
    channel: editingChannel.value,
    enabled: effectiveDraftEnabled.value,
    endpoint: usesEndpoint.value ? draftEndpoint.value.trim() : '',
    token: isDingTalk.value ? '' : draftToken.value.trim(),
    secret: isDingTalk.value ? draftSecret.value.trim() : '',
  })
  if (!normalized) {
    channelActionError.value = '推送渠道配置无效'
    return
  }

  emit('saveChannel', normalized, (ok) => {
    if (ok) {
      editingChannel.value = null
      toast.success('推送渠道配置已保存')
    }
  })
}

function handleClearChannel() {
  if (!editingChannel.value || modalBusy.value)
    return
  const target = editingChannel.value
  const label = editingLabel.value
  emit('saveChannel', { channel: target, enabled: false, token: '', endpoint: '', secret: '' }, (ok) => {
    if (ok) {
      editingChannel.value = null
      toast.info(`已清空 ${label} 配置`)
    }
  })
}
</script>

<template>
  <div class="push-section">
    <div class="push-section__head">
      <div class="flex flex-wrap items-center gap-2">
        <span class="push-section__title">推送渠道</span>
        <span
          class="push-channel-badge"
          :class="`push-channel-badge--${summaryBadge.tone}`"
        >
          {{ summaryBadge.text }}
        </span>
      </div>
      <BaseButton variant="secondary" size="sm" @click="openListModal">
        管理推送渠道
      </BaseButton>
    </div>

    <div v-if="configuredChannels.length > 0" class="push-channel-summary-list">
      <div
        v-for="item in configuredChannels"
        :key="item.channel"
        class="push-channel-row"
      >
        <button
          type="button"
          class="push-channel-row__main"
          @click="openChannelEditor(item.channel)"
        >
          <span class="push-channel-row__name">{{ getPushChannelLabel(item.channel) }}</span>
          <span
            class="push-channel-row__state"
            :class="item.enabled ? 'push-channel-row__state--on' : 'push-channel-row__state--off'"
          >
            {{ item.enabled ? '已启用' : '已配置 · 未启用' }}
          </span>
        </button>
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="push-channel-edit-btn"
            @click="openChannelEditor(item.channel)"
          >
            配置
          </button>
          <NSwitch
            v-if="supportsChannels"
            :aria-label="`启用 ${getPushChannelLabel(item.channel)}`"
            :value="item.enabled"
            :disabled="saving"
            size="small"
            @update:value="val => handleToggle(item.channel, val)"
          />
        </div>
      </div>
    </div>

    <button
      v-else
      type="button"
      class="push-channel-empty"
      @click="openListModal"
    >
      暂未配置推送渠道，点击查看全部渠道并配置
    </button>
  </div>

  <!-- 一级弹窗：列出全部推送渠道 -->
  <NModal v-model:show="listOpen" :close-on-esc="!saving">
    <NCard
      class="push-modal-card"
      role="dialog"
      aria-modal="true"
      aria-label="推送渠道"
      title="推送渠道"
      :bordered="false"
      size="medium"
      closable
      @close="listOpen = false"
    >
      <div class="grid gap-3">
        <p v-if="!supportsChannels" class="text-xs text-[var(--ui-muted)] leading-relaxed">
          当前服务端只支持一个渠道，保存新渠道会替换原渠道。
        </p>

        <BaseInput
          v-model="searchQuery"
          aria-label="搜索推送渠道"
          placeholder="搜索推送渠道"
          clearable
        />

        <div class="push-modal-list">
          <div
            v-for="item in sortedChannelItems"
            :key="item.value"
            class="push-channel-row"
          >
            <button
              type="button"
              class="push-channel-row__main"
              @click="openChannelEditor(item.value)"
            >
              <span class="push-channel-row__name">{{ item.label }}</span>
              <span
                class="push-channel-row__state"
                :class="item.enabled
                  ? 'push-channel-row__state--on'
                  : item.configured
                    ? 'push-channel-row__state--off'
                    : 'push-channel-row__state--empty'"
              >
                {{ item.enabled ? '已启用' : item.configured ? '已配置 · 未启用' : '未配置' }}
              </span>
            </button>

            <div class="flex shrink-0 items-center gap-2">
              <div
                v-if="supportsChannels"
                class="inline-flex items-center"
                @click="!item.configured && handleDisabledSwitchTap(item)"
              >
                <NSwitch
                  :value="item.enabled"
                  :disabled="!item.configured || saving"
                  :aria-label="`启用 ${item.label}`"
                  size="small"
                  @update:value="val => handleToggle(item.value, val)"
                />
              </div>
            </div>
          </div>

          <p
            v-if="sortedChannelItems.length === 0"
            class="py-6 text-center text-xs text-[var(--ui-muted)]"
          >
            没有匹配的推送渠道
          </p>
        </div>
      </div>
    </NCard>
  </NModal>

  <!-- 二级弹窗：单个渠道详细设置 + 单独测试 + 启用开关 -->
  <NModal
    :show="editingChannel !== null"
    :mask-closable="!modalBusy"
    :close-on-esc="!modalBusy"
    @update:show="show => { if (!show && !modalBusy) editingChannel = null }"
  >
    <NCard
      class="push-modal-card push-modal-card--detail"
      role="dialog"
      aria-modal="true"
      :aria-label="`配置 ${editingLabel}`"
      :title="editingLabel ? `配置 · ${editingLabel}` : '配置推送渠道'"
      :bordered="false"
      size="medium"
      :closable="!modalBusy"
      @close="editingChannel = null"
    >
      <template v-if="editingDocUrl" #header-extra>
        <button
          type="button"
          class="mr-2 inline-flex items-center gap-1 text-xs text-[var(--ui-primary)] hover:underline"
          @click="openDocs(editingDocUrl)"
        >
          官方文档
          <span class="i-carbon-launch" aria-hidden="true" />
        </button>
      </template>

      <div class="grid gap-4">
        <BaseInput
          v-if="usesEndpoint"
          id="push-channel-endpoint"
          v-model="draftEndpoint"
          :label="endpointLabel"
          :placeholder="endpointPlaceholder"
          :disabled="modalBusy"
        />

        <BaseInput
          v-if="!isDingTalk"
          id="push-channel-token"
          v-model="draftToken"
          :type="isMeow ? 'text' : 'password'"
          :label="tokenLabel"
          :placeholder="tokenPlaceholder"
          :disabled="modalBusy"
        />

        <template v-else>
          <BaseInput
            id="push-channel-secret"
            v-model="draftSecret"
            label="加签密钥（可选）"
            type="password"
            placeholder="仅在机器人开启加签时填写 SEC..."
            :disabled="modalBusy"
          />
          <p class="text-xs text-[var(--ui-muted)] leading-relaxed">
            复制群机器人的完整 Webhook 地址；仅开启“加签”时需要填写密钥。
          </p>
        </template>

        <p v-if="dingTalkInlineError" class="text-xs text-red-600 dark:text-red-400">
          {{ dingTalkInlineError }}
        </p>

        <div v-if="supportsChannels" class="push-modal-toggle flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm text-[var(--ui-ink)] font-medium">
              启用此渠道
            </div>
            <div class="text-xs text-[var(--ui-muted)]">
              {{ canEnableDraft ? '开启后将在触发所选通知类型时向该渠道发送消息' : '需先填写有效配置后才允许启用' }}
            </div>
          </div>
          <NSwitch
            size="small"
            :aria-label="`启用 ${editingLabel}`"
            :value="effectiveDraftEnabled"
            :disabled="!canEnableDraft || modalBusy"
            @update:value="handleDraftEnabledChange"
          />
        </div>

        <p v-if="channelActionError" role="alert" class="text-xs text-red-600 dark:text-red-400">
          {{ channelActionError }}
        </p>
      </div>

      <template #footer>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <BaseButton
              v-if="editingWasConfigured"
              variant="secondary"
              size="sm"
              :disabled="modalBusy"
              @click="handleClearChannel"
            >
              清空配置
            </BaseButton>
          </div>
          <div class="flex items-center gap-2">
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="channelTesting"
              :disabled="!canEnableDraft || saving"
              @click="handleTestChannel"
            >
              测试通知
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="saving"
              :disabled="channelTesting"
              @click="handleSaveChannel"
            >
              保存配置
            </BaseButton>
          </div>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.push-section {
  display: grid;
  gap: 12px;
  padding-top: 18px;
  border-top: 1px solid var(--ui-border);
}

.push-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.push-section__title {
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.push-modal-toggle {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}

.push-channel-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

.push-channel-badge--active {
  background: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  color: var(--ui-primary);
}

.push-channel-badge--idle {
  background: color-mix(in srgb, #d97706 14%, transparent);
  color: #b45309;
}

.push-channel-badge--empty {
  background: color-mix(in srgb, var(--ui-surface-strong) 75%, transparent);
  color: var(--ui-muted);
}

.push-channel-summary-list {
  display: grid;
  gap: 8px;
}

.push-channel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 54%, transparent);
}

.push-channel-row__main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  background: transparent;
}

.push-channel-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: 500;
}

.push-channel-row__state {
  flex-shrink: 0;
  font-size: 12px;
}

.push-channel-row__state--on {
  color: var(--ui-primary);
}

.push-channel-row__state--off {
  color: #d97706;
}

.push-channel-row__state--empty {
  color: var(--ui-subtle);
}

.push-channel-edit-btn {
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--ui-muted);
  font-size: 12px;
}

.push-channel-edit-btn:hover {
  color: var(--ui-primary);
}

.push-channel-empty {
  width: 100%;
  padding: 14px 12px;
  border: 1px dashed var(--ui-border);
  border-radius: var(--ui-radius-control);
  color: var(--ui-muted);
  font-size: 12px;
  text-align: center;
  background: color-mix(in srgb, var(--ui-surface-strong) 36%, transparent);
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.push-channel-empty:hover {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
}

.push-modal-card {
  width: min(500px, calc(100vw - 32px));
}

.push-modal-card--detail {
  width: min(460px, calc(100vw - 32px));
}

.push-modal-list {
  display: grid;
  gap: 8px;
  max-height: min(56vh, 440px);
  overflow-y: auto;
  padding-right: 2px;
}
</style>
