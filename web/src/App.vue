<script setup lang="ts">
import { NConfigProvider } from 'naive-ui/es/config-provider'
import { NDialogProvider } from 'naive-ui/es/dialog'
import { NGlobalStyle } from 'naive-ui/es/global-style'
import { dateZhCN, zhCN } from 'naive-ui/es/locales'
import { NMessageProvider } from 'naive-ui/es/message'
import { NNotificationProvider } from 'naive-ui/es/notification'
import { darkTheme } from 'naive-ui/es/themes'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterView } from 'vue-router'
import PanelStatusBanner from '@/components/PanelStatusBanner.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { useAppStore } from '@/stores/app'
import { useAppUpdateStore } from '@/stores/app-update'
import { useStatusStore } from '@/stores/status'
import { createNaiveThemeOverrides } from '@/ui/naive-theme'

const { isDark } = storeToRefs(useAppStore())
const appUpdateStore = useAppUpdateStore()
const statusStore = useStatusStore()
const { realtimeReconnecting, realtimeReconnectCount, serverWebBuildId } = storeToRefs(statusStore)
const themeOverrides = computed(() => createNaiveThemeOverrides(isDark.value))

watch([realtimeReconnecting, realtimeReconnectCount], ([reconnecting, count]) => {
  appUpdateStore.syncSocketState(reconnecting, count)
}, { immediate: true })

watch(serverWebBuildId, (buildId) => {
  if (buildId)
    appUpdateStore.observeBuildId(buildId)
}, { immediate: true })

onMounted(() => {
  appUpdateStore.startMonitoring()
})

onBeforeUnmount(() => {
  appUpdateStore.stopMonitoring()
})
</script>

<template>
  <NConfigProvider
    :theme="isDark ? darkTheme : null"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NGlobalStyle />
    <NMessageProvider placement="top-right" :max="4" keep-alive-on-hover>
      <NDialogProvider>
        <NNotificationProvider placement="top-right" :max="4">
          <div class="app-shell h-screen w-screen overflow-hidden">
            <RouterView />
            <PanelStatusBanner />
            <ToastContainer />
          </div>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
