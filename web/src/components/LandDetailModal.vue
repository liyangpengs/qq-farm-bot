<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { computed } from 'vue'

const props = defineProps<{ land: any, player: any, connected: boolean }>()
const emit = defineEmits<{ close: [] }>()
const info = computed(() => props.land?.landInfo)
const metrics = [
  { key: 'yieldBonus', label: '产量加成', unit: '%' },
  { key: 'growthReduction', label: '成长提速', unit: '%' },
  { key: 'expBonus', label: '经验加成', unit: '%' },
  { key: 'mutantMultiplier', label: '变异概率', unit: '倍' },
  { key: 'resonanceBonus', label: '共鸣加成', unit: '%' },
]
function metric(level: any, key: string, unit: string) {
  if (!level)
    return '—'
  const value = Number(level[key]) || 0
  return key === 'mutantMultiplier' && !value ? '无' : `${value}${unit}`
}
function integer(value: unknown): bigint | null {
  const text = String(value ?? '')
  return /^\d+$/.test(text) ? BigInt(text) : null
}
const balances = computed(() => ({ 1001: props.player?.gold, 1002: props.player?.coupon, 1005: props.player?.goldBean }))
const costs = computed(() => (info.value?.costs || []).map((cost: any) => {
  const balance = props.connected ? integer(balances.value[cost.id as keyof typeof balances.value]) : null
  const required = integer(cost.count) ?? 0n
  return { ...cost, available: balance, missing: balance === null ? null : required > balance ? required - balance : 0n }
}))
const levelMet = computed(() => props.connected && Number(props.player?.level) >= Number(info.value?.needLevel))
function format(value: unknown) {
  const parsed = integer(value)
  return parsed === null ? '—' : parsed.toLocaleString('zh-CN')
}
</script>

<template>
  <NModal :show="!!land" @update:show="!$event && emit('close')">
    <NCard class="land-detail-modal" :bordered="false" closable role="dialog" aria-modal="true" aria-label="土地详情" @close="emit('close')">
      <template #header>
        <span class="font-display">土地详情 <span class="text-sm opacity-50">#{{ land?.id }}</span></span>
      </template>
      <template v-if="info">
        <div class="land-detail-levels" :class="{ 'land-detail-levels--compare': info.next && info.current }">
          <div v-if="info.current" class="land-detail-soil">
            <img :src="info.current.image" :alt="info.current.name" width="84" height="70">
            <strong>{{ info.current.name }}</strong>
          </div>
          <span v-if="info.next && info.current" class="i-carbon-chevron-right text-2xl opacity-40" aria-hidden="true" />
          <div v-if="info.next" class="land-detail-soil">
            <img :src="info.next.image" :alt="info.next.name" width="84" height="70">
            <strong>{{ info.next.name }}</strong>
          </div>
        </div>
        <table class="land-detail-metrics">
          <thead>
            <tr>
              <th>土地加成</th><th>{{ info.current ? '当前' : '解锁后' }}</th><th v-if="info.current && info.next">
                升级后
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in metrics" :key="row.key">
              <th>{{ row.label }}</th>
              <td>{{ metric(info.current || info.next, row.key, row.unit) }}</td>
              <td v-if="info.current && info.next" :class="{ 'land-detail-improved': info.next[row.key] > info.current[row.key] }">
                {{ metric(info.next, row.key, row.unit) }}<span v-if="info.next[row.key] > info.current[row.key]" aria-label="提升"> ↑</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="info.mode === 'max'" class="land-detail-max">
          当前已满级
        </div>
        <section v-else class="land-detail-requirements">
          <h3>{{ info.mode === 'unlock' ? '解锁条件' : '升级条件' }}</h3>
          <div v-if="info.needLevel !== null" class="land-detail-condition">
            <span>种植等级达到 {{ info.needLevel }} 级</span>
            <strong :class="levelMet ? 'land-detail-improved' : 'land-detail-missing'">{{ connected ? player?.level ?? '—' : '—' }} / {{ info.needLevel }}</strong>
          </div>
          <div v-if="info.prerequisite" class="land-detail-condition">
            <span>解锁第 {{ info.prerequisite.landId }} 块土地</span>
            <strong :class="info.prerequisite.met ? 'land-detail-improved' : 'land-detail-missing'">{{ info.prerequisite.met ? '已满足' : '未满足' }}</strong>
          </div>
          <div v-if="info.current && info.next" class="land-detail-condition">
            <span>当前地块为{{ info.current.name }}</span><span class="land-detail-improved">已满足</span>
          </div>
          <div v-for="cost in costs" :key="cost.id" class="land-detail-cost">
            <div class="land-detail-cost-name">
              <img v-if="cost.image" :src="cost.image" alt="" width="28" height="28"><span>{{ cost.name }}</span>
            </div>
            <div class="land-detail-cost-amount">
              <strong>{{ format(cost.count) }}</strong><span :class="cost.missing === 0n ? 'land-detail-improved' : 'land-detail-missing'">{{ cost.missing === null ? '余额待同步' : cost.missing > 0n ? `还差 ${format(cost.missing)}` : '余额充足' }}</span>
            </div>
          </div>
          <p v-if="info.unknown" class="land-detail-missing">
            部分条件暂未获取
          </p>
          <p v-else-if="info.serverAllowed && connected" class="land-detail-improved">
            当前可{{ info.mode === 'unlock' ? '解锁' : '升级' }}
          </p>
        </section>
      </template>
      <p v-else>
        土地详情暂未获取，请刷新农场。
      </p>
    </NCard>
  </NModal>
</template>

<style scoped>
.land-detail-modal {
  width: min(480px, calc(100vw - 24px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  border-radius: 20px;
}
.land-detail-levels {
  display: grid;
  justify-content: center;
  align-items: center;
  gap: 12px;
  padding: 0 0 18px;
}
.land-detail-levels--compare {
  grid-template-columns: 1fr auto 1fr;
}
.land-detail-soil {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.land-detail-soil img {
  object-fit: contain;
}
.land-detail-metrics {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.land-detail-metrics th,
.land-detail-metrics td {
  padding: 9px 4px;
  text-align: right;
}
.land-detail-metrics th:first-child {
  text-align: left;
  font-weight: 500;
  opacity: 0.7;
}
.land-detail-metrics thead {
  font-size: 12px;
  border-bottom: 1px solid var(--n-border-color);
  opacity: 0.65;
}
.land-detail-requirements {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--n-border-color);
}
.land-detail-requirements h3 {
  margin: 0 0 12px;
  font-weight: 700;
}
.land-detail-condition {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 8px 0;
}
.land-detail-cost {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}
.land-detail-cost-name {
  display: flex;
  align-items: center;
  gap: 10px;
}
.land-detail-cost-name img {
  object-fit: contain;
}
.land-detail-cost-amount {
  display: flex;
  flex-direction: column;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.land-detail-cost-amount span {
  font-size: 12px;
}
.land-detail-improved {
  color: var(--n-color-target, #278452);
}
.land-detail-missing {
  color: #c87138;
}
.land-detail-max {
  margin-top: 20px;
  padding: 10px;
  text-align: center;
  border-radius: 12px;
  background: rgba(69, 155, 93, 0.12);
  color: #278452;
  font-weight: 600;
}
@media (max-width: 360px) {
  .land-detail-metrics th,
  .land-detail-metrics td {
    padding: 8px 2px;
  }
  .land-detail-modal {
    font-size: 13px;
  }
}
</style>
