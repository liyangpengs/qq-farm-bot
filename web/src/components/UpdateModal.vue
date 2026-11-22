<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useUpdateStore } from '@/stores/update'

const updateStore = useUpdateStore()
const status = computed(() => updateStore.status || {})
const running = computed(() => status.value.state === 'running' || !!status.value.requestPending)
const hasUpdate = computed(() => !!status.value.hasUpdate)
const succeeded = computed(() => status.value.state === 'success')
const failed = computed(() => status.value.state === 'failed')
// No status file at all: the host-side updater from tools/updater is not installed.
const notInstalled = computed(() => !status.value.checkedAt)
const steps = [
  { key: 'prepare', label: '准备' },
  { key: 'build', label: '构建' },
  { key: 'restart', label: '重启' },
  { key: 'health', label: '健康检查' },
]
const activeStep = computed(() => steps.findIndex(step => step.key === status.value.step))
const commits = computed(() => (status.value.commits || []).slice(0, 12))
const checkedText = computed(() => {
  const ts = Number(status.value.checkedAt) || 0
  if (!ts)
    return '尚未检查'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

function close() {
  if (!running.value)
    updateStore.modalOpen = false
}
</script>

<template>
  <NModal :show="updateStore.modalOpen" :mask-closable="!running" :close-on-esc="!running" @update:show="close">
    <NCard class="update-card" role="dialog" aria-modal="true" :bordered="false" title="版本更新" size="medium">
      <div class="update-versions">
        <div class="update-version">
          <span class="update-version__label">当前版本</span>
          <span class="update-version__value">{{ status.deployedShort || '未知' }}</span>
        </div>
        <div class="i-carbon-arrow-right update-versions__arrow" />
        <div class="update-version" :class="{ 'update-version--new': hasUpdate }">
          <span class="update-version__label">最新版本</span>
          <span class="update-version__value">{{ status.latestShort || '未知' }}</span>
        </div>
        <span class="update-versions__checked">检查于 {{ checkedText }}</span>
      </div>

      <div v-if="running" class="update-progress">
        <div v-for="(step, index) in steps" :key="step.key" class="update-step">
          <span
            class="update-step__dot"
            :class="{
              'update-step__dot--done': activeStep > index,
              'update-step__dot--active': activeStep === index,
              'animate-pulse': activeStep === index,
            }"
          />
          <span class="update-step__label" :class="{ 'update-step__label--active': activeStep === index }">{{ step.label }}</span>
        </div>
        <p class="update-note">{{ status.message || '正在更新，页面会自动重连…' }}</p>
      </div>

      <template v-else>
        <p v-if="succeeded" class="update-result update-result--ok">
          {{ status.message || '更新完成' }}，如页面数据未刷新请手动刷新。
        </p>
        <p v-else-if="failed" class="update-result update-result--error">
          {{ status.message || '更新失败' }}
        </p>
        <template v-else-if="hasUpdate">
          <p class="update-note">
            上游有 {{ status.behind || commits.length }} 个新提交：
          </p>
          <ul class="update-commits">
            <li v-for="(item, index) in commits" :key="index">{{ item }}</li>
          </ul>
          <p class="update-warning">
            更新会重建容器并短暂中断服务。微信账号的登录 Code 是一次性的，更新后需要重新扫码。
          </p>
        </template>
        <p v-else-if="notInstalled" class="update-note">
          尚未检测到宿主机更新器。如需在面板内检查和安装更新，请按 docs/updater.md 部署 tools/updater 后重试。
        </p>
        <p v-else class="update-note">
          当前已是最新版本。
        </p>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2">
          <BaseButton variant="secondary" :disabled="running" @click="close">关闭</BaseButton>
          <BaseButton variant="secondary" :loading="updateStore.checking" :disabled="running || notInstalled" @click="updateStore.check">
            检查更新
          </BaseButton>
          <BaseButton
            variant="primary"
            :disabled="running || !hasUpdate || notInstalled"
            @click="updateStore.apply"
          >
            {{ running ? '更新中…' : '立即更新' }}
          </BaseButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.update-card {
  width: min(520px, calc(100vw - 32px));
}
.update-versions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.update-version {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.update-version__label {
  font-size: 11px;
  color: var(--n-text-color-3, #8b8b8b);
}
.update-version__value {
  font-family: var(--font-mono, monospace);
  font-size: 15px;
  font-weight: 600;
}
.update-version--new .update-version__value {
  color: var(--theme-primary, #18a058);
}
.update-versions__arrow {
  color: var(--n-text-color-3, #9a9a9a);
}
.update-versions__checked {
  margin-left: auto;
  font-size: 11px;
  color: var(--n-text-color-3, #9a9a9a);
}
.update-note {
  margin: 12px 0 0;
  color: var(--n-text-color-2, #666);
  font-size: 13px;
  line-height: 1.6;
}
.update-commits {
  margin: 8px 0 0;
  padding: 10px 12px;
  max-height: 220px;
  overflow: auto;
  border-radius: 10px;
  background: var(--n-action-color, rgba(127, 127, 127, 0.08));
  font-size: 12px;
  line-height: 1.8;
  list-style: disc inside;
}
.update-warning {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(240, 160, 32, 0.12);
  color: #b26a00;
  font-size: 12px;
  line-height: 1.6;
}
.update-result {
  margin: 12px 0 0;
  font-size: 13px;
}
.update-result--ok {
  color: #18a058;
}
.update-result--error {
  color: #d03050;
}
.update-progress {
  margin-top: 14px;
}
.update-step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 14px;
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}
.update-step__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(127, 127, 127, 0.35);
}
.update-step__dot--done {
  background: #18a058;
}
.update-step__dot--active {
  background: var(--theme-primary, #18a058);
}
.update-step__label--active {
  color: var(--n-text-color, #333);
  font-weight: 600;
}
</style>
