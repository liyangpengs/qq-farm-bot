<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  show: boolean
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
  type?: 'danger' | 'primary'
  isAlert?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

function handleShowChange(show: boolean) {
  if (!show && !props.loading)
    emit('cancel')
}
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading"
    :close-on-esc="!loading"
    :auto-focus="false"
    @update:show="handleShowChange"
  >
    <NCard
      class="confirm-card"
      role="dialog"
      aria-modal="true"
      :bordered="false"
      :title="title || '确认操作'"
      size="medium"
    >
      <p v-if="message !== ''" class="confirm-card__message">
        {{ message ?? '确定要执行此操作吗？' }}
      </p>
      <slot />
      <template #footer>
        <div class="flex justify-end gap-2">
          <BaseButton
            v-if="!isAlert"
            variant="secondary"
            :disabled="loading"
            @click="emit('cancel')"
          >
            {{ cancelText || '取消' }}
          </BaseButton>
          <BaseButton
            :variant="type === 'danger' ? 'danger' : 'primary'"
            :loading="loading"
            @click="emit('confirm')"
          >
            {{ confirmText || '确定' }}
          </BaseButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.confirm-card {
  width: min(420px, calc(100vw - 32px));
}

.confirm-card__message {
  margin: 0;
  white-space: pre-line;
  color: var(--n-text-color);
  line-height: 1.65;
}
</style>
