<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'

const props = defineProps<{
  show: boolean
  account?: any
}>()

const emit = defineEmits(['close', 'saved'])

const name = ref('')
const loading = ref(false)
const errorMessage = ref('')

watch(() => props.show, (val) => {
  errorMessage.value = ''
  if (val && props.account) {
    name.value = props.account.name || ''
  }
})

async function save() {
  if (!props.account)
    return

  const remark = name.value.trim()
  if (!remark) {
    errorMessage.value = '请输入备注名称'
    return
  }

  loading.value = true
  errorMessage.value = ''
  try {
    // 使用 name 字段存储备注，只发送 id 和 name 两个字段
    const payload = {
      id: props.account.id,
      name: remark,
    }

    const res = await api.post('/api/accounts', payload)
    if (res.data.ok) {
      emit('saved')
      emit('close')
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
}
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading"
    :close-on-esc="!loading"
    @update:show="value => !value && $emit('close')"
  >
    <NCard
      class="remark-modal-card"
      title="修改备注"
      :bordered="false"
      :closable="!loading"
      @close="$emit('close')"
    >
      <div class="space-y-4">
        <div v-if="errorMessage" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
          {{ errorMessage }}
        </div>
        <BaseInput
          v-model="name"
          label="备注名称"
          placeholder="请输入备注名称"
          class="farm-input"
          @keyup.enter="save"
        />

        <div class="flex justify-end gap-2">
          <BaseButton
            variant="outline"
            @click="$emit('close')"
          >
            取消
          </BaseButton>
          <BaseButton
            variant="primary"
            :loading="loading"
            @click="save"
          >
            保存
          </BaseButton>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.remark-modal-card {
  width: min(384px, calc(100vw - 32px));
}
</style>
