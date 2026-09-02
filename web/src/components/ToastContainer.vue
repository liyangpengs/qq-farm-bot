<script setup lang="ts">
import { useMessage } from 'naive-ui/es/message'
import { storeToRefs } from 'pinia'
import { watch } from 'vue'
import { useToastStore } from '@/stores/toast'

const toastStore = useToastStore()
const { toasts } = storeToRefs(toastStore)
const message = useMessage()
const displayedIds = new Set<number>()

watch(toasts, (items) => {
  for (const toast of [...items]) {
    if (displayedIds.has(toast.id))
      continue

    displayedIds.add(toast.id)
    const options = {
      duration: toast.duration ?? 3000,
      closable: true,
      keepAliveOnHover: true,
    }

    if (toast.type === 'success')
      message.success(toast.message, options)
    else if (toast.type === 'error')
      message.error(toast.message, options)
    else if (toast.type === 'warning')
      message.warning(toast.message, options)
    else
      message.info(toast.message, options)

    toastStore.remove(toast.id)
  }
}, { deep: true, immediate: true })
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
