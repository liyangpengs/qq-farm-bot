<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import AutomationSettingsForm from '@/components/settings/AutomationSettingsForm.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'

// 牧场的自动化开关与养殖策略独立成页，避免和农场账号设置混在一起。
const fertilizerLandTypeOptions = [
  { label: '蓝晶土地', value: 'blue-crystal' },
  { label: '紫金土地', value: 'purple-gold' },
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '智能施肥', value: 'smart' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '不施肥', value: 'none' },
]

const accountStore = useAccountStore()
const settingStore = useSettingStore()
const { currentAccountId } = storeToRefs(accountStore)
const { currentAccountConnected } = storeToRefs(useStatusStore())
const { settings, loading: settingsLoading, loadedAccountId } = storeToRefs(settingStore)

const model = ref<any>({})
const ranchAnimalOptions = ref<Array<{ value: number, label: string, kind: string }>>([])
const saving = ref(false)
const error = ref('')

const ready = computed(() => !!currentAccountId.value && loadedAccountId.value === currentAccountId.value)

/** 只把牧场相关开关交给后端，避免整份账号配置被覆盖。 */
function ranchAutomationOnly(automation: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(automation || {}).filter(([key]) => key.startsWith('ranch_')))
}

function syncFromStore() {
  if (!settings.value) {
    model.value = {}
    return
  }
  const next = JSON.parse(JSON.stringify(settings.value))
  next.automation = { ...next.automation }
  model.value = next
}

function showError(cause: unknown, fallback: string) {
  error.value = getApiErrorMessage(cause, fallback)
}

async function load() {
  error.value = ''
  const accountId = currentAccountId.value
  if (!accountId)
    return
  try {
    await settingStore.fetchSettings(accountId)
    if (accountId !== currentAccountId.value)
      return
    syncFromStore()
  }
  catch (cause) {
    showError(cause, '牧场策略读取失败')
  }
}

watch(() => currentAccountId.value, () => {
  model.value = {}
  void load()
}, { immediate: true })

watch(settings, () => {
  if (ready.value && !saving.value)
    syncFromStore()
})

onMounted(async () => {
  try {
    const response = await api.get('/api/ranch/automation-options')
    if (response.data.ok)
      ranchAnimalOptions.value = response.data.data
  }
  catch (cause) { showError(cause, '牧场动物选项读取失败') }
})

async function save() {
  const accountId = currentAccountId.value
  if (!accountId || saving.value || !ready.value)
    return
  saving.value = true
  error.value = ''
  try {
    const result = await settingStore.saveSettings(accountId, { automation: ranchAutomationOnly(model.value.automation) })
    if (accountId !== currentAccountId.value)
      return
    if (!result.ok)
      throw new Error(result.error || '保存失败')
    syncFromStore()
  }
  catch (cause) {
    showError(cause, '牧场策略保存失败')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page-stack flex flex-col gap-4">
    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后配置牧场自动化与养殖策略" icon="i-carbon-user-avatar" />
    <template v-else>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">
        {{ error }}
      </p>
      <p v-if="settingsLoading || !ready" class="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
        加载中...
      </p>
      <template v-else>
        <AutomationSettingsForm
          v-model="model"
          in-ranch
          panel="strategy"
          hide-save
          :ranch-animal-options="ranchAnimalOptions"
          :account-id="currentAccountId"
          :connected="currentAccountConnected"
          :saving="saving"
          :fertilizer-land-type-options="fertilizerLandTypeOptions"
          :fertilizer-options="fertilizerOptions"
          @save="save"
        />
        <AutomationSettingsForm
          v-model="model"
          in-ranch
          panel="automation"
          hide-save
          :ranch-animal-options="ranchAnimalOptions"
          :saving="saving"
          :fertilizer-land-type-options="fertilizerLandTypeOptions"
          :fertilizer-options="fertilizerOptions"
          @save="save"
        />
        <div class="flex justify-end">
          <BaseButton variant="primary" size="sm" :loading="saving" @click="save">
            保存牧场策略
          </BaseButton>
        </div>
      </template>
    </template>
  </div>
</template>
