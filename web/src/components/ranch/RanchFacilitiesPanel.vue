<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { formatCount, formatDuration, RANCH_IMAGE, useRanchActions, useRanchClock, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchAmountDialog from '@/components/ranch/RanchAmountDialog.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import { useRanchStore } from '@/stores/ranch'

const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('facilities')
const { disabled, request } = useRanchActions()
const { serverNow, remainingSeconds } = useRanchClock()

const facilities = computed<any[]>(() => state.value?.facilities || [])
const grass = computed(() => Number(state.value?.grass) || 0)
const grassTarget = ref<any>(null)

function kind(f: any) {
  return f.feed ? { icon: 'i-carbon-wheat', label: '饲料' } : f.ranch ? { icon: 'i-carbon-home', label: '饲养' } : { icon: 'i-carbon-building', label: '设施' }
}
function meter(f: any) {
  if (f.ranch)
    return { label: '动物', value: `${f.ranch.count} / ${f.ranch.capacity}`, percent: f.ranch.capacity ? f.ranch.count / f.ranch.capacity * 100 : 0 }
  if (f.feed)
    return { label: '牧草', value: `${f.feed.count} / ${f.capacity}`, percent: f.capacity ? f.feed.count / f.capacity * 100 : 0 }
  return { label: '容量', value: String(f.capacity), percent: 0 }
}
function upgradeDone(f: any) {
  const end = Number(f.upgradeEndTime)
  return f.upgradeState === 2 || end * (end < 1e11 ? 1000 : 1) <= serverNow.value
}
function submitGrass(count: number) {
  const f = grassTarget.value
  grassTarget.value = null
  if (f)
    void request('addGrass', { facilityId: f.id, count })
}
</script>

<template>
  <div class="personal-panel">
    <RanchGate @retry="refresh">
      <div class="facility-bar">
        <span class="facility-bar__stock"><img :src="RANCH_IMAGE(7001)" alt="">牧草库存 <b>{{ formatCount(state?.grass ?? 0) }}</b></span>
        <NButton circle quaternary size="small" title="刷新设施" aria-label="刷新设施" :loading="loading" @click="refresh">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>

      <div class="facility-grid">
        <article v-for="f in facilities" :key="f.id" class="facility" :class="{ 'is-pending': f.state === 2 }">
          <header class="facility__head">
            <span class="facility__icon" aria-hidden="true"><span :class="kind(f).icon" /></span>
            <div class="min-w-0 flex-1">
              <h3>{{ f.name }} <small>Lv.{{ f.level }}</small></h3>
              <span class="facility__kind">{{ kind(f).label }}</span>
            </div>
            <span v-if="f.state === 2" class="facility__badge">待建造</span>
            <span v-else-if="f.upgradeState" class="facility__badge is-busy">升级中</span>
          </header>

          <div class="facility__meter">
            <div class="facility__meter-labels">
              <span>{{ meter(f).label }}</span><b>{{ meter(f).value }}</b>
            </div>
            <div class="facility__track" aria-hidden="true">
              <i :style="{ width: `${Math.min(100, meter(f).percent)}%` }" />
            </div>
            <p v-if="f.feed" class="facility__note">
              {{ f.feed.remainingSec === '-1' ? '当前没有动物消耗牧草' : `预计可供 ${formatDuration(f.feed.remainingSec)}` }}
            </p>
          </div>

          <div v-if="!f.active && f.moduleType === 7" class="facility__upgrade">
            牧场 21 级解锁
          </div>
          <div v-else-if="f.active && f.upgradeState" class="facility__upgrade">
            <span class="i-carbon-time" aria-hidden="true" />
            <span>{{ upgradeDone(f) ? '升级已完成，等待确认' : `剩余 ${formatDuration(remainingSeconds(f.upgradeEndTime))}` }}</span>
          </div>
          <div v-else-if="f.active && f.next" class="facility__upgrade">
            <div class="facility__next">
              升至 Lv.{{ f.next.level }} · 容量 {{ f.next.capacity }} · {{ formatDuration(f.next.durationSec) }}
              <span v-if="f.next.requiredLevel" :class="{ 'is-unmet': !f.next.available && Number(state?.level) < f.next.requiredLevel }">需牧场 {{ f.next.requiredLevel }} 级</span>
            </div>
            <div class="facility__costs">
              <span v-for="cost in f.next.costs" :key="cost.id" :title="cost.name"><img :src="cost.image" alt="">{{ formatCount(cost.count) }}</span>
            </div>
          </div>
          <p v-else-if="f.active" class="facility__note">
            已满级
          </p>

          <footer v-if="f.active" class="facility__foot">
            <NButton v-if="f.feed" size="small" secondary :disabled="disabled || f.feed.count >= f.capacity || grass < 1" @click="grassTarget = f">
              <span class="i-carbon-add mr-0.5" aria-hidden="true" />补充牧草
            </NButton>
            <NButton v-if="f.upgradeState" size="small" type="primary" :disabled="disabled || !upgradeDone(f)" @click="request('completeUpgrade', { facilityId: f.id })">
              完成升级
            </NButton>
            <NButton v-else-if="f.next" size="small" :type="f.next.available ? 'primary' : 'default'" :secondary="!f.next.available" :disabled="disabled || !f.next.available" @click="request('upgrade', { facilityId: f.id })">
              <span class="i-carbon-upgrade mr-0.5" aria-hidden="true" />升级
            </NButton>
          </footer>
        </article>
      </div>
    </RanchGate>

    <RanchAmountDialog
      :show="!!grassTarget"
      :title="`为${grassTarget?.name || ''}补充牧草`"
      name="牧草"
      :image="RANCH_IMAGE(7001)"
      :caption="`库存 ${formatCount(state?.grass ?? 0)} · 可再放入 ${grassTarget ? grassTarget.capacity - grassTarget.feed.count : 0}`"
      :max="grassTarget ? Math.min(grass, grassTarget.capacity - grassTarget.feed.count) : 1"
      @close="grassTarget = null"
      @submit="submitGrass"
    />
  </div>
</template>

<style scoped>
.facility-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.facility-bar__stock {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-muted);
  font-size: 13px;
}

.facility-bar__stock img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.facility-bar__stock b {
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}

.facility-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 14px;
}

.facility {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

/* 同一行的卡片共用四条行轨：标题 / 容量 / 升级信息 / 按钮。
   某张卡多一行说明（如牧草机的消耗提示）时，其余卡片的升级区和按钮仍保持对齐。 */
@supports (grid-template-rows: subgrid) {
  .facility {
    display: grid;
    grid-row: span 4;
    grid-template-rows: subgrid;
    row-gap: 14px;
  }

  .facility__foot {
    align-self: end;
  }
}

.facility.is-pending {
  border-style: dashed;
}

.facility__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.facility__icon {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: 12px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 20px;
}

.facility__head h3 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
}

.facility__head h3 small {
  margin-left: 4px;
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-500);
}

.facility__kind {
  color: var(--ui-subtle);
  font-size: 12px;
}

.facility__badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  line-height: 20px;
}

.facility__badge.is-busy {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.facility__meter-labels {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--ui-muted);
  font-size: 12px;
}

.facility__meter-labels b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.facility__track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.facility__track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
  transition: width 0.4s ease;
}

.facility__note {
  margin: 6px 0 0;
  color: var(--ui-subtle);
  font-size: 12px;
}

.facility__upgrade {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.facility__upgrade:has(> .i-carbon-time) {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  color: var(--ui-warning);
}

.facility__next span {
  margin-left: 6px;
}

.facility__next .is-unmet {
  color: var(--ui-warning);
}

.facility__costs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.facility__costs span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.facility__costs img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.facility__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
}

.facility__foot:empty {
  display: none;
}
</style>
