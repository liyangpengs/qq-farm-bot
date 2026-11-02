<script setup lang="ts">
import type { MallGoodsDto } from '@/stores/commerce'
import { NButton } from 'naive-ui/es/button'
import { computed, ref, watch } from 'vue'
import CommerceItemImage from './CommerceItemImage.vue'

const props = defineProps<{
  open: boolean
  goods: MallGoodsDto | null
  limitLabel?: string
  pending?: boolean
}>()

const emit = defineEmits<{
  close: []
  confirm: [count: number]
}>()

const count = ref(1)
const maxCount = computed(() => Math.max(1, Math.min(9999, props.goods?.limit?.remaining ?? 9999)))
const totalCost = computed(() => (props.goods?.price.count || 0) * count.value)
const balanceUnknown = computed(() => !props.goods?.isFree && props.goods?.price.balance == null)
const insufficient = computed(() => {
  const balance = props.goods?.price.balance
  return !props.goods?.isFree && balance !== null && balance !== undefined && totalCost.value > balance
})

watch(() => [props.open, props.goods?.id], () => count.value = 1)

function setCount(value: number) {
  count.value = Math.min(maxCount.value, Math.max(1, Math.floor(value) || 1))
}
</script>

<template>
  <div v-if="open && goods" class="purchase-mask" @click.self="!pending && emit('close')">
    <section class="purchase-dialog" role="dialog" aria-modal="true" :aria-label="`购买${goods.name}`">
      <!-- 头部：小图 + 名称 + 单价，主图不再单独占据大块面积 -->
      <header class="purchase-head">
        <CommerceItemImage :src="goods.rewards[0]?.image" :alt="goods.rewards[0]?.name" size="md" />
        <div class="purchase-head__text">
          <h2>{{ goods.name }}</h2>
          <p>
            <template v-if="goods.isFree">
              免费领取
            </template>
            <template v-else>
              单价
              <CommerceItemImage :src="goods.price.image" :alt="goods.price.name" size="sm" />
              <b>{{ goods.price.count.toLocaleString() }}</b>
              <del v-if="goods.originalPrice">{{ goods.originalPrice.toLocaleString() }}</del>
            </template>
            <span v-if="goods.discountText" class="purchase-tag">{{ goods.discountText }}</span>
          </p>
        </div>
        <button type="button" class="purchase-close" title="关闭" aria-label="关闭" :disabled="pending" @click="emit('close')">
          <span class="i-carbon-close" />
        </button>
      </header>

      <div class="purchase-body">
        <div class="purchase-section-label">
          每份包含<span v-if="goods.rewards.length > 1"> · {{ goods.rewards.length }} 件</span>
        </div>
        <ul class="purchase-rewards">
          <li v-for="reward in goods.rewards" :key="reward.id">
            <CommerceItemImage :src="reward.image" :alt="reward.name" size="sm" />
            <span class="purchase-rewards__name">{{ reward.name }}</span>
            <b>×{{ reward.count.toLocaleString() }}</b>
          </li>
        </ul>

        <div class="purchase-row">
          <div>
            <span class="purchase-row__label">购买数量</span>
            <small v-if="goods.limit">{{ limitLabel || '限购' }} · 还可购买 {{ maxCount }} 份</small>
          </div>
          <div class="stepper">
            <button type="button" title="减少" aria-label="减少" :disabled="pending || count <= 1" @click="setCount(count - 1)">
              <span class="i-carbon-subtract" />
            </button>
            <input :value="count" inputmode="numeric" aria-label="购买数量" :disabled="pending" @input="setCount(Number(($event.target as HTMLInputElement).value))">
            <button type="button" title="增加" aria-label="增加" :disabled="pending || count >= maxCount" @click="setCount(count + 1)">
              <span class="i-carbon-add" />
            </button>
          </div>
        </div>

        <div class="purchase-row purchase-row--total">
          <div>
            <span class="purchase-row__label">合计</span>
            <small v-if="!goods.isFree && goods.price.balance != null">余额 {{ goods.price.balance.toLocaleString() }}</small>
          </div>
          <strong v-if="goods.isFree" class="purchase-total is-free">免费</strong>
          <strong v-else class="purchase-total" :class="{ 'is-short': insufficient }">
            <CommerceItemImage :src="goods.price.image" :alt="goods.price.name" size="sm" />
            {{ totalCost.toLocaleString() }}
          </strong>
        </div>

        <p v-if="balanceUnknown" class="purchase-error" role="alert">
          余额暂不可用，请刷新商城
        </p>
        <p v-else-if="insufficient" class="purchase-error" role="alert">
          {{ goods.price.name }}余额不足
        </p>
      </div>

      <footer class="purchase-foot">
        <NButton :disabled="pending" @click="emit('close')">
          取消
        </NButton>
        <NButton type="primary" :loading="pending" :disabled="pending || insufficient || balanceUnknown || !goods.purchasable" @click="emit('confirm', count)">
          {{ pending ? '购买中' : goods.isFree ? '确认领取' : '确认购买' }}
        </NButton>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.purchase-mask {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(35, 47, 38, 0.32);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}

.purchase-dialog {
  width: min(440px, 100%);
  max-height: min(680px, calc(100dvh - 32px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  color: var(--ui-ink);
  background: var(--ui-surface-strong);
  box-shadow: var(--ui-shadow-lg);
}

.purchase-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 18px 16px 20px;
  border-bottom: 1px solid var(--ui-border);
}

.purchase-head :deep(.item-image--md) {
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 14px;
  background: var(--ui-surface-soft);
}

.purchase-head__text {
  min-width: 0;
  flex: 1;
}

.purchase-head h2 {
  margin: 0;
  overflow: hidden;
  font-size: 17px;
  font-weight: var(--fw-700);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.purchase-head p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 4px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.purchase-head p b {
  color: var(--ui-warning);
  font-size: 13px;
}

.purchase-head p del {
  color: var(--ui-subtle);
}

.purchase-head p :deep(.item-image--sm),
.purchase-total :deep(.item-image--sm) {
  width: 18px;
  height: 18px;
  border: 0;
  background: transparent;
}

.purchase-tag {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-weight: var(--fw-600);
  line-height: 18px;
}

.purchase-close {
  width: 34px;
  height: 34px;
  display: grid;
  flex: none;
  align-self: flex-start;
  place-items: center;
  border-radius: 9px;
  color: var(--ui-muted);
  font-size: 18px;
}

.purchase-close:hover:not(:disabled) {
  background: var(--ui-surface-soft);
}

.purchase-body {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px 4px;
  overflow-y: auto;
}

.purchase-section-label {
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.purchase-rewards {
  display: grid;
  max-height: 232px;
  gap: 2px;
  margin: -6px 0 0;
  padding: 6px;
  overflow-y: auto;
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
  list-style: none;
}

.purchase-rewards li {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 4px 4px;
  border-radius: 8px;
}

.purchase-rewards li :deep(.item-image--sm) {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: var(--ui-surface-strong);
}

.purchase-rewards__name {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.purchase-rewards b {
  color: var(--ui-ink);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.purchase-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.purchase-row > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.purchase-row__label {
  font-size: 13px;
  font-weight: var(--fw-600);
}

.purchase-row small {
  color: var(--ui-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.purchase-row--total {
  padding-top: 14px;
  border-top: 1px dashed var(--ui-border-strong);
}

.purchase-total {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-warning);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}

.purchase-total.is-free {
  color: var(--ui-primary);
}

.purchase-total.is-short {
  color: var(--ui-danger);
}

.stepper {
  height: 34px;
  display: grid;
  grid-template-columns: 34px 56px 34px;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--glass-input);
}

.stepper button {
  display: grid;
  place-items: center;
  color: var(--ui-muted);
}

.stepper button:hover:not(:disabled) {
  color: var(--ui-primary);
  background: var(--ui-surface-soft);
}

.stepper button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.stepper input {
  min-width: 0;
  border: 0;
  border-inline: 1px solid var(--ui-border);
  outline: 0;
  color: var(--ui-ink);
  background: transparent;
  font-size: 14px;
  font-weight: var(--fw-600);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.purchase-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 12px;
}

.purchase-foot {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: 10px;
  padding: 16px 20px 18px;
}

.purchase-foot :deep(.n-button) {
  height: 38px;
}
</style>
