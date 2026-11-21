<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { formatCount, formatDuration, formatRanchReward, useRanchActions } from '@/components/ranch/ranch-shared'
import { useRanchStore } from '@/stores/ranch'

const { pending, confirm, cancel } = useRanchActions()
const { busy } = storeToRefs(useRanchStore())
const quote = computed(() => pending.value?.quote)

/** 罐头桶以秒计量：报价里给的是最多消耗的秒数。 */
function costAmount(item: { id: number, count: string }) {
  return [1006, 7003, 7004].includes(Number(item.id)) ? `最多 ${formatDuration(item.count)}` : `×${formatCount(item.count)}`
}
function costName(item: { id: number, name: string }) {
  return Number(item.id) === 7003 ? '普通罐头桶' : Number(item.id) === 7004 ? '有机罐头桶' : item.name
}
</script>

<template>
  <ConfirmModal :show="!!pending" :title="quote?.label || '确认牧场操作'" message="" :loading="busy" :type="quote?.action === 'release' ? 'danger' : 'primary'" :confirm-text="quote?.action === 'release' ? '确认放生' : '确认'" @cancel="cancel" @confirm="confirm">
    <div v-if="quote" class="quote">
      <p v-if="quote.action === 'feed' && pending?.input.all === true" class="quote__count">
        可喂养 <b>{{ quote.count }}</b> 只动物
      </p>
      <p v-else-if="quote.count > 1" class="quote__count">
        本次共 <b>{{ quote.count }}</b> 项
      </p>
      <section v-if="quote.costItems.length" class="quote__group">
        <h4>消耗</h4>
        <div v-for="cost in quote.costItems" :key="cost.id" class="quote__row">
          <span class="quote__well"><img v-if="cost.image" :src="cost.image" alt=""></span>
          <span class="quote__name">{{ costName(cost) }}</span>
          <b class="quote__amount is-cost">{{ costAmount(cost) }}</b>
        </div>
      </section>
      <section v-if="quote.rewards.length" class="quote__group">
        <h4>获得</h4>
        <div v-for="reward in quote.rewards" :key="reward.id" class="quote__row">
          <span class="quote__well"><img v-if="reward.image" :src="reward.image" alt=""></span>
          <span class="quote__name">{{ reward.name }}</span>
          <b class="quote__amount">{{ formatRanchReward(reward) }}</b>
        </div>
      </section>
      <p v-if="quote.message || !quote.costItems.length && !quote.rewards.length" class="quote__plain">
        {{ quote.message || '确认执行这次操作？' }}
      </p>
    </div>
  </ConfirmModal>
</template>

<style scoped>
.quote {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.quote__count,
.quote__plain {
  margin: 0;
  color: var(--ui-muted);
  font-size: 13px;
}

.quote__count b {
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}

.quote__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.quote__group h4 {
  margin: 0 0 2px;
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.quote__row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 6px;
  border-radius: 10px;
  background: var(--ui-surface-soft);
}

.quote__well {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 9px;
  background: var(--ui-surface-strong);
}

.quote__well img {
  width: 78%;
  height: 78%;
  object-fit: contain;
}

.quote__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quote__amount {
  color: var(--ui-primary);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.quote__amount.is-cost {
  color: var(--ui-warning);
}
</style>
