<script setup lang="ts">
import { NCheckbox } from 'naive-ui/es/checkbox'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'

export interface ReleaseCompatInfo {
  compatible: boolean
  outdated: boolean
  reasons: string[]
}

export interface RollbackReleaseItem {
  releaseId: string
  createdAt: number
  commit: string
  shortCommit: string
  commitSubject: string
  pairedWebReleaseId: string
  sizeBytes: number
  isActive: boolean
  isPrevious: boolean
  canRollback: boolean
  canDelete: boolean
  compat: ReleaseCompatInfo
}

export interface ReleasesSummary {
  totalCount: number
  compatibleCount: number
  outdatedCount: number
  totalSizeBytes: number
  outdatedSizeBytes: number
  orphanHostCount: number
  orphanWebCount: number
  orphanSizeBytes: number
}

const props = withDefaults(defineProps<{
  releases: RollbackReleaseItem[]
  summary: ReleasesSummary
  mode: 'source' | 'docker' | 'binary' | 'unknown'
  applySupported: boolean
  applyUnsupportedReason: string
  deployBusy: boolean
  keepBackups?: boolean
  disabled?: boolean
}>(), {
  keepBackups: true,
})

const emit = defineEmits<{
  statusUpdated: [status: any]
  backupChanged: [keepBackups: boolean]
}>()

const toast = useToastStore()
const requestConfig = { skipErrorToast: true, timeout: 90_000 }

const selectedIds = ref<string[]>([])
const actionBusy = ref(false)
const backupBusy = ref(false)
const actionError = ref('')

const confirmRollbackOpen = ref(false)
const rollbackTarget = ref<RollbackReleaseItem | null>(null)

const confirmDeleteOpen = ref(false)
const deleteMode = ref<'single' | 'batch' | 'orphans'>('single')
const deleteTargets = ref<RollbackReleaseItem[]>([])

const isBusy = computed(() => Boolean(props.disabled || props.deployBusy || actionBusy.value || backupBusy.value))
const backupEnabled = computed(() => props.keepBackups !== false)
const showBackupSwitch = computed(() => props.mode !== 'docker' && props.mode !== 'binary')

watch(() => props.releases, (list) => {
  const allowedIds = new Set(list.filter(item => !item.isActive && item.canDelete).map(item => item.releaseId))
  selectedIds.value = selectedIds.value.filter(id => allowedIds.has(id))
}, { deep: true })

const selectedSet = computed(() => new Set(selectedIds.value))
/**
 * 列表至少露出三行，更高时随左侧面板一起拉伸，多出的版本在列表内滚动。
 * 超过三个时多露出半行，提示列表可以滚动。
 */
const visibleRows = computed(() => props.releases.length > 3 ? 3.5 : Math.max(1, props.releases.length))
const hasOrphans = computed(() => props.summary.orphanHostCount + props.summary.orphanWebCount > 0)

const outdatedDeletableItems = computed(() =>
  props.releases.filter(item => !item.isActive && item.canDelete && item.compat.outdated),
)

const allOutdatedSelected = computed(() => {
  const outdated = outdatedDeletableItems.value
  return outdated.length > 0 && outdated.every(item => selectedSet.value.has(item.releaseId))
})

const selectedItems = computed(() =>
  props.releases.filter(item => selectedSet.value.has(item.releaseId)),
)

const selectedBytes = computed(() =>
  selectedItems.value.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
)

/** 只在有可执行的批量操作时显示，避免常驻一排禁用按钮。 */
const showToolbar = computed(() =>
  selectedIds.value.length > 0 || outdatedDeletableItems.value.length > 0 || hasOrphans.value,
)

function releaseStatus(item: RollbackReleaseItem): { label: string, tone: 'active' | 'warn' } | null {
  if (item.isActive)
    return { label: '当前运行', tone: 'active' }
  if (item.compat.compatible)
    return null
  return { label: item.compat.outdated ? '已过时' : '无法校验', tone: 'warn' }
}

function formatBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024)
    return `${value} B`
  if (value < 1024 * 1024)
    return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatReleaseTime(ms: number): string {
  if (!ms)
    return '-'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toggleItemSelected(releaseId: string, checked: boolean): void {
  const next = new Set(selectedIds.value)
  if (checked)
    next.add(releaseId)
  else
    next.delete(releaseId)
  selectedIds.value = [...next]
}

function toggleSelectOutdated(): void {
  const outdated = outdatedDeletableItems.value
  if (outdated.length === 0)
    return
  if (allOutdatedSelected.value) {
    const outdatedSet = new Set(outdated.map(item => item.releaseId))
    selectedIds.value = selectedIds.value.filter(id => !outdatedSet.has(id))
  }
  else {
    const next = new Set(selectedIds.value)
    for (const item of outdated)
      next.add(item.releaseId)
    selectedIds.value = [...next]
  }
}

function clearSelection(): void {
  selectedIds.value = []
}

function rollbackDisabledReason(item: RollbackReleaseItem): string {
  if (props.deployBusy || props.disabled)
    return '当前已有更新或部署任务正在运行'
  if (!props.applySupported)
    return props.applyUnsupportedReason || '当前运行模式不支持网页内回滚'
  if (!item.compat.compatible)
    return item.compat.reasons.join('；') || '与当前运行环境不兼容'
  return ''
}

function requestRollback(item: RollbackReleaseItem): void {
  if (isBusy.value || !item.canRollback)
    return
  actionError.value = ''
  rollbackTarget.value = item
  confirmRollbackOpen.value = true
}

function requestDeleteSingle(item: RollbackReleaseItem): void {
  if (isBusy.value || !item.canDelete)
    return
  actionError.value = ''
  deleteMode.value = 'single'
  deleteTargets.value = [item]
  confirmDeleteOpen.value = true
}

function requestBatchDelete(): void {
  if (isBusy.value || selectedItems.value.length === 0)
    return
  actionError.value = ''
  deleteMode.value = 'batch'
  deleteTargets.value = [...selectedItems.value]
  confirmDeleteOpen.value = true
}

function requestCleanOrphans(): void {
  if (isBusy.value || !hasOrphans.value)
    return
  actionError.value = ''
  deleteMode.value = 'orphans'
  deleteTargets.value = []
  confirmDeleteOpen.value = true
}

const rollbackConfirmMessage = computed(() => {
  const item = rollbackTarget.value
  if (!item)
    return ''
  const label = item.shortCommit || item.releaseId
  const webNote = item.pairedWebReleaseId ? '并同步切换对应前端页面，' : ''
  return `确定回滚到 ${label}（${formatReleaseTime(item.createdAt)}）吗？${webNote}切换期间挂机中的游戏连接保持在线，不会回滚账号数据或已发生的真实消耗。`
})

const deleteConfirmTitle = computed(() => {
  if (deleteMode.value === 'orphans')
    return '清理冗余备份文件'
  if (deleteMode.value === 'batch')
    return `批量删除 ${deleteTargets.value.length} 个历史版本`
  return '删除历史版本备份'
})

const deleteConfirmMessage = computed(() => {
  if (deleteMode.value === 'orphans') {
    return `确定清理未关联的冗余文件（旧版连接服务 ${props.summary.orphanHostCount} 个、旧网页端 ${props.summary.orphanWebCount} 个）吗？将永久删除对应 releases 目录，预计释放 ${formatBytes(props.summary.orphanSizeBytes)} 磁盘空间。`
  }
  const bytes = deleteTargets.value.reduce((sum, item) => sum + (item.sizeBytes || 0), 0)
  if (deleteMode.value === 'batch') {
    return `确定永久删除选中的 ${deleteTargets.value.length} 个历史版本及其独享的前端备份文件吗？预计释放 ${formatBytes(bytes)} 磁盘空间，删除后不可恢复。`
  }
  const target = deleteTargets.value[0]
  if (!target)
    return ''
  return `确定永久删除版本 ${target.shortCommit || target.releaseId} 及其对应的 releases 备份文件吗？预计释放 ${formatBytes(target.sizeBytes)} 磁盘空间。`
})

async function confirmRollback(): Promise<void> {
  const item = rollbackTarget.value
  if (!item || actionBusy.value)
    return
  actionBusy.value = true
  actionError.value = ''
  try {
    const { data } = await api.post('/api/system/update/rollback', { releaseId: item.releaseId }, requestConfig)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '启动回滚失败'))
    if (data.data?.status)
      emit('statusUpdated', data.data.status)
    confirmRollbackOpen.value = false
    rollbackTarget.value = null
    toast.info('已在后台开始回滚，切换期间游戏连接保持在线')
  }
  catch (e) {
    actionError.value = getApiErrorMessage(e, '启动回滚失败')
    confirmRollbackOpen.value = false
  }
  finally {
    actionBusy.value = false
  }
}

async function confirmDelete(): Promise<void> {
  if (actionBusy.value)
    return
  actionBusy.value = true
  actionError.value = ''
  try {
    const payload = deleteMode.value === 'orphans'
      ? { releaseIds: [], cleanOrphans: true }
      : { releaseIds: deleteTargets.value.map(item => item.releaseId), cleanOrphans: false }
    const { data } = await api.post('/api/system/update/releases/delete', payload, requestConfig)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '删除历史版本失败'))

    const deletedSet = new Set<string>(data.data?.deletedReleaseIds || [])
    selectedIds.value = selectedIds.value.filter(id => !deletedSet.has(id))
    if (data.data?.status)
      emit('statusUpdated', data.data.status)
    confirmDeleteOpen.value = false
    deleteTargets.value = []
    const freed = Number(data.data?.freedBytes) || 0
    toast.success(`已清理备份文件，释放 ${formatBytes(freed)} 磁盘空间`)
  }
  catch (e) {
    actionError.value = getApiErrorMessage(e, '删除历史版本失败')
    confirmDeleteOpen.value = false
  }
  finally {
    actionBusy.value = false
  }
}

async function handleToggleBackup(nextValue: boolean | undefined): Promise<void> {
  if (nextValue === undefined || isBusy.value || nextValue === backupEnabled.value)
    return
  backupBusy.value = true
  actionError.value = ''
  try {
    const { data } = await api.put('/api/system/update/backup-setting', { keepBackups: nextValue }, requestConfig)
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '更新备份设置失败'))
    const saved: boolean = data.data.keepBackups
    emit('backupChanged', saved)
    toast.success(saved ? '已开启备份，下次更新会保留上一版' : '已关闭备份，下次更新生效')
  }
  catch (e) {
    actionError.value = getApiErrorMessage(e, '更新备份设置失败')
  }
  finally {
    backupBusy.value = false
  }
}

defineExpose({
  backupEnabled,
  backupBusy,
  selectedIds,
  outdatedDeletableItems,
  toggleItemSelected,
  toggleSelectOutdated,
  clearSelection,
  handleToggleBackup,
  requestRollback,
  requestDeleteSingle,
  requestBatchDelete,
  requestCleanOrphans,
  confirmRollback,
  confirmDelete,
})
</script>

<template>
  <section class="rollback-panel" aria-labelledby="rollback-panel-title">
    <header class="rollback-panel__head">
      <div class="rollback-panel__heading">
        <h5 id="rollback-panel-title" class="rollback-panel__title">
          历史版本与回滚
        </h5>
        <span v-if="summary.totalCount > 0" class="rollback-panel__summary">
          {{ summary.totalCount }} 个 · {{ formatBytes(summary.totalSizeBytes) }}
        </span>
      </div>

      <div v-if="showToolbar || showBackupSwitch" class="rollback-panel__actions">
        <template v-if="showToolbar">
          <template v-if="selectedIds.length > 0">
            <span class="rollback-panel__selection" aria-live="polite">
              已选 {{ selectedIds.length }} 项 · {{ formatBytes(selectedBytes) }}
            </span>
            <BaseButton variant="text" size="sm" :disabled="isBusy" @click="clearSelection">
              取消选择
            </BaseButton>
            <BaseButton variant="secondary" size="sm" class="rollback-panel__danger" :disabled="isBusy" @click="requestBatchDelete">
              批量删除
            </BaseButton>
          </template>
          <template v-else>
            <BaseButton
              v-if="outdatedDeletableItems.length > 0"
              variant="secondary"
              size="sm"
              :disabled="isBusy"
              @click="toggleSelectOutdated"
            >
              选中过时版本 ({{ outdatedDeletableItems.length }})
            </BaseButton>
            <BaseButton v-if="hasOrphans" variant="secondary" size="sm" :disabled="isBusy" @click="requestCleanOrphans">
              清理冗余 ({{ formatBytes(summary.orphanSizeBytes) }})
            </BaseButton>
          </template>
        </template>

        <div
          v-if="showBackupSwitch"
          class="rollback-panel__backup"
          :class="{ 'rollback-panel__backup--divided': showToolbar }"
        >
          <BaseSwitch
            :model-value="backupEnabled"
            label="备份"
            :disabled="isBusy"
            @update:model-value="handleToggleBackup"
          />
        </div>
      </div>
    </header>

    <p class="rollback-panel__desc">
      <template v-if="!showBackupSwitch || backupEnabled">
        QQ、微信客户端版本一致，且兼容当前游戏连接服务的历史版本可以回滚。
      </template>
      <template v-else>
        从下次更新起只保留正在使用的版本。已有备份仍可回滚或手动删除。
      </template>
    </p>

    <div v-if="mode === 'docker' || mode === 'binary'" class="rollback-empty">
      {{ mode === 'docker' ? 'Docker 容器部署请通过镜像标签回退或清理宿主机旧镜像。' : '独立可执行文件模式不使用 releases 目录备份。' }}
    </div>

    <div v-else-if="releases.length === 0" class="rollback-empty">
      {{ backupEnabled
        ? '暂无历史版本备份，通过 start.sh 启动或执行在线更新后会在这里显示可回滚版本。'
        : '暂无历史版本备份，当前已关闭备份，后续更新不会保留旧版备份。' }}
    </div>

    <div
      v-else
      class="release-list"
      role="list"
      aria-label="历史版本"
      :style="{ '--release-visible-rows': visibleRows }"
    >
      <div
        v-for="item in releases"
        :key="item.releaseId"
        class="release-item"
        :class="{
          'release-item--active': item.isActive,
          'release-item--selected': selectedSet.has(item.releaseId),
          'release-item--outdated': !item.isActive && item.compat.outdated,
        }"
        role="listitem"
      >
        <div class="release-item__check">
          <NCheckbox
            v-if="!item.isActive"
            :checked="selectedSet.has(item.releaseId)"
            :disabled="isBusy || !item.canDelete"
            :aria-label="`选择版本 ${item.shortCommit || item.releaseId}`"
            @update:checked="toggleItemSelected(item.releaseId, $event)"
          />
          <span v-else class="release-item__active-dot" title="当前运行中" />
        </div>

        <div class="release-item__body">
          <div class="release-item__subject" :title="item.commitSubject || item.releaseId">
            {{ item.commitSubject || item.releaseId }}
          </div>
          <div class="release-item__meta">
            <code class="release-item__sha" :title="item.pairedWebReleaseId ? '含对应前端页面' : undefined">{{ item.shortCommit || 'local' }}</code>
            <span>{{ formatReleaseTime(item.createdAt) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ formatBytes(item.sizeBytes) }}</span>
            <span
              v-if="releaseStatus(item)"
              class="release-badge"
              :class="`release-badge--${releaseStatus(item)!.tone}`"
            >
              {{ releaseStatus(item)!.label }}
            </span>
          </div>
          <div v-if="!item.isActive && item.compat.reasons.length" class="release-item__reason">
            {{ item.compat.reasons.join(' · ') }}
          </div>
        </div>

        <div v-if="!item.isActive" class="release-item__actions">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="isBusy || !item.canRollback"
            :title="rollbackDisabledReason(item) || `回滚到 ${item.shortCommit || item.releaseId}`"
            @click="requestRollback(item)"
          >
            回滚
          </BaseButton>
          <BaseButton
            variant="ghost"
            size="sm"
            class="release-item__delete"
            :disabled="isBusy || !item.canDelete"
            :title="`删除 ${item.shortCommit || item.releaseId} 的备份`"
            :aria-label="`删除版本 ${item.shortCommit || item.releaseId}`"
            @click="requestDeleteSingle(item)"
          >
            <span class="i-carbon-trash-can" aria-hidden="true" />
          </BaseButton>
        </div>
      </div>
    </div>

    <div v-if="actionError" role="alert" class="rollback-panel__error">
      {{ actionError }}
    </div>

    <ConfirmModal
      :show="confirmRollbackOpen"
      :loading="actionBusy"
      title="确认版本回滚"
      :message="rollbackConfirmMessage"
      confirm-text="开始回滚"
      type="primary"
      @close="!actionBusy && (confirmRollbackOpen = false)"
      @cancel="!actionBusy && (confirmRollbackOpen = false)"
      @confirm="confirmRollback"
    />

    <ConfirmModal
      :show="confirmDeleteOpen"
      :loading="actionBusy"
      :title="deleteConfirmTitle"
      :message="deleteConfirmMessage"
      confirm-text="确认删除"
      type="danger"
      @close="!actionBusy && (confirmDeleteOpen = false)"
      @cancel="!actionBusy && (confirmDeleteOpen = false)"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.rollback-panel {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
}

/* 与左侧「当前版本」同一套标题行：标题 + 摘要，右侧放操作。 */
.rollback-panel__head {
  display: flex;
  min-height: 32px;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.rollback-panel__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.rollback-panel__title {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-600);
  line-height: 20px;
  white-space: nowrap;
}

.rollback-panel__summary {
  padding: 1px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-500);
  line-height: 18px;
  white-space: nowrap;
}

.rollback-panel__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.rollback-panel__backup {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
}

.rollback-panel__backup--divided {
  padding-left: 8px;
  border-left: 1px solid var(--ui-border);
}

.rollback-panel__selection {
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
}

.rollback-panel__danger {
  color: var(--ui-danger);
}

.rollback-panel__desc {
  margin-top: -4px;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

.rollback-panel__error {
  color: var(--ui-danger);
  font-size: 12px;
}

.rollback-empty {
  display: grid;
  flex: 1 1 auto;
  min-height: 96px;
  place-items: center;
  padding: 16px 14px;
  border: 1px dashed var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}

/*
 * 列表不参与撑高：size 包含让它的自身高度只取最少露出的行数，
 * 双栏时随左侧面板拉伸到同一底边，单栏时固定露出三行，其余在列表内滚动。
 */
.release-list {
  --release-row: 60px;
  --release-gap: 8px;
  display: flex;
  flex: 1 1 auto;
  min-height: calc(
    var(--release-row) * var(--release-visible-rows, 3) + var(--release-gap) * (var(--release-visible-rows, 3) - 1)
  );
  flex-direction: column;
  gap: var(--release-gap);
  contain: size;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.release-item {
  display: flex;
  min-height: var(--release-row);
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.release-item:hover {
  border-color: var(--ui-border-strong);
}

.release-item--active {
  border-color: color-mix(in srgb, var(--ui-primary) 38%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary-soft) 60%, var(--ui-surface-soft));
}

.release-item--selected {
  border-color: color-mix(in srgb, var(--ui-danger) 30%, var(--ui-border));
}

.release-item--outdated .release-item__subject {
  color: var(--ui-muted);
}

.release-item__check {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
}

.release-item__active-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--ui-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-primary) 18%, transparent);
}

.release-item__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.release-item__subject {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-500);
  line-height: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.release-item__meta {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 17px;
}

.release-item__sha {
  color: var(--ui-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: var(--fw-600);
}

.release-badge {
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--fw-600);
  line-height: 16px;
}

.release-badge--active {
  background: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  color: var(--ui-primary);
}

.release-badge--warn {
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
}

.release-item__reason {
  color: var(--ui-warning);
  font-size: 11px;
  line-height: 1.45;
}

.release-item__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
}

.release-item__delete {
  width: 30px;
  min-width: 30px;
  padding: 0 !important;
  color: var(--ui-muted);
}

.release-item__delete:not(:disabled):hover {
  color: var(--ui-danger);
}
</style>
