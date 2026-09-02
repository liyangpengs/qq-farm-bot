<script setup lang="ts">
import type { ActivityRulesDto } from '@/stores/activity-center'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'

withDefaults(defineProps<{
  open: boolean
  rules?: ActivityRulesDto | null
  title?: string
  closeLabel?: string
}>(), {
  rules: null,
  title: '',
  closeLabel: '关闭活动说明',
})

const emit = defineEmits<{ close: [] }>()

function handleShowChange(show: boolean) {
  if (!show)
    emit('close')
}
</script>

<template>
  <NModal
    :show="open"
    :mask-closable="true"
    :close-on-esc="true"
    :auto-focus="false"
    @update:show="handleShowChange"
  >
    <NCard
      class="activity-rules-dialog"
      role="dialog"
      aria-modal="true"
      :bordered="false"
      :title="title || rules?.title || '活动说明'"
      :closable="true"
      :aria-label="closeLabel"
      @close="emit('close')"
    >
      <div class="activity-rules-paper">
        <slot name="guide" />
        <slot>
          <div v-if="rules?.paragraphs.length" class="activity-rules-copy">
            <p v-for="(paragraph, index) in rules.paragraphs" :key="index">
              {{ paragraph }}
            </p>
          </div>
          <p v-else class="activity-rules-empty">
            暂无活动说明
          </p>
        </slot>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.activity-rules-dialog {
  width: min(520px, calc(100vw - 32px));
}

.activity-rules-paper {
  max-height: min(68vh, 560px);
  overflow-y: auto;
}

.activity-rules-copy {
  color: var(--ui-ink, var(--n-text-color));
  font-size: 14px;
  line-height: 1.7;
}

.activity-rules-copy p {
  margin: 0 0 12px;
  white-space: pre-line;
}

.activity-rules-copy p:first-child {
  font-weight: 600;
}

.activity-rules-empty {
  margin: 0;
  padding: 32px 0;
  color: var(--ui-muted, var(--n-text-color-3));
  text-align: center;
}
</style>
