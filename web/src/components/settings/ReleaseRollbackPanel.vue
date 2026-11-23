<script setup lang="ts">
import { NCheckbox } from 'naive-ui/es/checkbox'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
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

const props = defineProps<{
  releases: RollbackReleaseItem[]
  summary: ReleasesSummary
  mode: 'source' | 'docker' | 'binary' | 'unknown'
  applySupported: boolean
  applyUnsupportedReason: string
  deployBusy: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  statusUpdated: [status: any]
}>()

const toast = useToastStore()
const requestConfig = { skipErrorToast: true, timeout: 90_000 }

const selectedIds = ref<string[]>([])
const actionBusy = ref(false)
const actionError = ref('')

const confirmRollbackOpen = ref(false)
const rollbackTarget = ref<RollbackReleaseItem | null>(null)

const confirmDeleteOpen = ref(false)
const deleteMode = ref<'single' | 'batch' | 'orphans'>('single')
const deleteTargets = ref<RollbackReleaseItem[]>([])

const isBusy = computed(() => Boolean(props.disabled || props.deployBusy || actionBusy.value))

watch(() => props.releases, (list) => {
  const allowedIds = new Set(list.filter(item => !item.isActive && item.canDelete).map(item => item.releaseId))
  selectedIds.value = selectedIds.value.filter(id => allowedIds.has(id))
}, { deep: true })

const selectedSet = computed(() => new Set(selectedIds.value))
const releaseGroups = computed(() => [props.releases.slice(0, 3), props.releases.slice(3)].filter(group => group.length))
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

const showBatchControls = computed(() =>
  props.releases.some(item => !item.isActive) || hasOrphans.value,
)

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
  return `确定回滚到 ${label}（${formatReleaseTime(item.createdAt)}）吗？${webNote}切换期间会话宿主继续保持游戏连接在线，不会回滚账号数据或已发生的真实消耗。`
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
    return `确定清理未关联的冗余文件（旧会话宿主 ${props.summary.orphanHostCount} 个、无主前端 ${props.summary.orphanWebCount} 个）吗？将永久删除对应 releases 目录，预计释放 ${formatBytes(props.summary.orphanSizeBytes)} 磁盘空间。`
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

defineExpose({
  selectedIds,
  outdatedDeletableItems,
  toggleItemSelected,
  toggleSelectOutdated,
  clearSelection,
  requestRollback,
  requestDeleteSingle,
  requestBatchDelete,
  requestCleanOrphans,
  confirmRollback,
  confirmDelete,
})
</script>

<template>
  <div class="rollback-panel">
    <div class="rollback-panel__header">
      <div class="rollback-panel__title-row">
        <h4 class="rollback-panel__title">
          历史版本与回滚
        </h4>
        <span class="rollback-panel__summary-pill">
          共 {{ summary.totalCount }} 个 · 占用 {{ formatBytes(summary.totalSizeBytes) }}
        </span>
      </div>
      <p class="rollback-panel__desc">
        QQ、微信客户端版本一致且支持当前会话宿主的备份可以回滚。
      </p>
    </div>

    <div v-if="showBatchControls" class="rollback-toolbar">
      <div class="rollback-toolbar__group">
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="isBusy || outdatedDeletableItems.length === 0"
          @click="toggleSelectOutdated"
        >
          {{ allOutdatedSelected ? `取消过时选中 (${outdatedDeletableItems.length})` : `选中过时版本 (${outdatedDeletableItems.length})` }}
        </BaseButton>
        <BaseButton
          v-if="selectedIds.length > 0"
          variant="text"
          size="sm"
          :disabled="isBusy"
          @click="clearSelection"
        >
          取消选择
        </BaseButton>
      </div>
      <div class="rollback-toolbar__group">
        <BaseButton
          v-if="hasOrphans"
          variant="secondary"
          size="sm"
          :disabled="isBusy"
          @click="requestCleanOrphans"
        >
          清理冗余 ({{ formatBytes(summary.orphanSizeBytes) }})
        </BaseButton>
        <BaseButton
          variant="secondary"
          size="sm"
          class="rollback-toolbar__delete-btn"
          :disabled="isBusy || selectedIds.length === 0"
          @click="requestBatchDelete"
        >
          {{ selectedIds.length ? `批量删除 (${selectedIds.length} · ${formatBytes(selectedBytes)})` : '批量删除' }}
        </BaseButton>
      </div>
    </div>

    <div v-if="mode === 'docker' || mode === 'binary'" class="rollback-empty">
      {{ mode === 'docker' ? 'Docker 容器部署请通过镜像标签回退或清理宿主机旧镜像。' : '独立可执行文件模式不使用 releases 目录备份。' }}
    </div>

    <div v-else-if="releases.length === 0" class="rollback-empty">
      暂无历史版本备份，通过 start.sh 启动或执行在线更新后会在这里显示可回滚版本。
    </div>

    <div v-else class="release-list" role="list" aria-label="历史版本">
      <div v-for="(group, index) in releaseGroups" :key="index" class="release-list__group" role="presentation">
        <div
          v-for="item in group"
          :key="item.releaseId"
          class="release-item"
          :class="{
            'release-item--active': item.isActive,
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
            <div class="release-item__meta">
              <code class="release-item__sha">{{ item.shortCommit || 'local' }}</code>
              <span class="release-item__time">{{ formatReleaseTime(item.createdAt) }}</span>
              <span class="release-item__size">{{ formatBytes(item.sizeBytes) }}</span>
              <span
                class="release-badge"
                :class="item.isActive
                  ? 'release-badge--active'
                  : item.compat.compatible
                    ? 'release-badge--compat'
                    : 'release-badge--outdated'"
              >
                {{ item.isActive ? '当前运行' : item.compat.compatible ? '可回滚' : item.compat.outdated ? '已过时' : '无法校验' }}
              </span>
              <span v-if="item.pairedWebReleaseId" class="release-badge release-badge--subtle">
                含前端
              </span>
            </div>

            <div class="release-item__subject" :title="item.commitSubject || item.releaseId">
              {{ item.commitSubject || item.releaseId }}
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
              :title="rollbackDisabledReason(item)"
              @click="requestRollback(item)"
            >
              回滚
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              class="release-item__delete-btn"
              :disabled="isBusy || !item.canDelete"
              @click="requestDeleteSingle(item)"
            >
              删除
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <div v-if="actionError" role="alert" class="text-xs text-red-600 dark:text-red-400">
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
  </div>
</template>

<style scoped>
.rollback-panel {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
}

.rollback-panel__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rollback-panel__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rollback-panel__title {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.rollback-panel__summary-pill {
  padding: 2px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-500);
}

.rollback-panel__desc {
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

.rollback-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rollback-toolbar__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.rollback-toolbar__delete-btn {
  color: var(--ui-danger);
}

.rollback-empty {
  padding: 16px 14px;
  border: 1px dashed var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}

.release-list {
  position: relative;
  overflow-y: auto;
}

.release-list__group {
  display: grid;
  gap: 8px;
  padding-right: 4px;
}

/* 前三行撑开列表，后续版本从滚动区底部接续。 */
.release-list__group + .release-list__group {
  position: absolute;
  inset: 100% 0 auto;
  padding-top: 8px;
}

.release-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
}

.release-item--active {
  border-color: color-mix(in srgb, var(--ui-primary) 42%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary-soft) 55%, var(--ui-surface-soft));
}

.release-item--outdated {
  background: color-mix(in srgb, var(--ui-surface-soft) 85%, transparent);
}

.release-item__check {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 22px;
}

.release-item__active-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--ui-primary);
}

.release-item__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.release-item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 16px;
}

.release-item__sha {
  color: var(--ui-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: var(--fw-600);
}

.release-item__time,
.release-item__size {
  color: var(--ui-muted);
}

.release-badge {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--fw-600);
  line-height: 15px;
}

.release-badge--active,
.release-badge--compat {
  background: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  color: var(--ui-primary);
}

.release-badge--outdated {
  background: color-mix(in srgb, var(--ui-warning) 18%, transparent);
  color: var(--ui-warning);
}

.release-badge--subtle {
  border: 1px solid var(--ui-border);
  color: var(--ui-muted);
}

.release-item__subject {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 12px;
  font-weight: var(--fw-500);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  gap: 4px;
}

.release-item__delete-btn {
  color: var(--ui-danger);
}
</style>
