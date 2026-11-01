<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import CommerceShopBar from '@/components/commerce/CommerceShopBar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useCommerceStore } from '@/stores/commerce'

const accountStore = useAccountStore()
const commerceStore = useCommerceStore()
const { currentAccountId } = storeToRefs(accountStore)
const { mystery, mysteryLoading, mysteryPurchasing, error, notice } = storeToRefs(commerceStore)
const clock = ref(Date.now())
const purchaseDialogOpen = ref(false)
let timer: number | undefined

const remaining = computed(() => {
  const end = mystery.value?.expireTime || 0
  const diff = Math.max(0, end - clock.value)
  if (!end || diff === 0)
    return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
})

const shopStatus = computed(() => {
  if (!mystery.value?.active || !mystery.value.npc)
    return mystery.value ? '神秘商人暂未来访' : ''
  return remaining.value ? `神秘商人来访中 · ${remaining.value} 后离开` : '神秘商人已离开'
})

const currencies = computed(() => {
  const price = mystery.value?.active ? mystery.value.npc?.price : null
  return price ? [{ id: price.id, name: price.name, image: price.image, amount: price.balance }] : []
})

const openedAt = computed(() => {
  const time = mystery.value?.activeTime
  return time ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
})

const discountLabel = computed(() => {
  const percent = mystery.value?.npc?.discountPercent || 0
  return percent > 0 ? `${(percent / 10).toFixed(percent % 10 ? 1 : 0)}折` : ''
})

const canPurchase = computed(() => {
  const npc = mystery.value?.npc
  return !!npc && npc.reward.count > 0 && (npc.price.balance === null || npc.price.balance >= npc.price.count)
})

const purchaseHint = computed(() => {
  const npc = mystery.value?.npc
  return npc && npc.price.balance !== null && npc.price.balance < npc.price.count ? '当前货币余额不足。' : ''
})

const buttonLabel = computed(() => mysteryPurchasing.value ? '购买中' : canPurchase.value ? '购买' : '暂不可购买')

function load() {
  commerceStore.fetchMystery(String(currentAccountId.value || ''))
}

function purchase() {
  const npc = mystery.value?.npc
  if (!npc || !canPurchase.value || mysteryPurchasing.value)
    return
  purchaseDialogOpen.value = true
}

async function confirmPurchase() {
  const npc = mystery.value?.npc
  if (!npc || !canPurchase.value || mysteryPurchasing.value)
    return
  const succeeded = await commerceStore.purchaseMystery(String(currentAccountId.value || ''), npc.id)
  if (succeeded)
    purchaseDialogOpen.value = false
}

watch(currentAccountId, () => {
  purchaseDialogOpen.value = false
  load()
})
onMounted(() => {
  load()
  timer = window.setInterval(() => clock.value = Date.now(), 1000)
})
onUnmounted(() => {
  if (timer)
    window.clearInterval(timer)
})
</script>

<template>
  <div class="mystery-panel">
    <CommerceShopBar
      :status="shopStatus"
      :status-tone="mystery?.active && mystery.npc && remaining ? 'violet' : 'muted'"
      status-icon="i-carbon-hourglass"
      :currencies="currencies"
      :loading="mysteryLoading"
      :disabled="!currentAccountId || mysteryPurchasing"
      refresh-label="刷新神秘商人"
      @refresh="load"
    />

    <div v-if="(error && mystery) || notice" class="shop-message" :class="{ 'is-success': !!notice && !error }" role="status">
      {{ error || notice }}
    </div>

    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="神秘商人按当前账号读取" icon="i-carbon-user-avatar" />
    <div v-else-if="mysteryLoading && !mystery" class="shop-loading">
      <span class="i-svg-spinners-90-ring-with-bg" />
    </div>
    <EmptyState v-else-if="error && !mystery" tone="error" title="神秘商人读取失败" :description="error" icon="i-carbon-warning-alt">
      <NButton secondary @click="load">
        重新读取
      </NButton>
    </EmptyState>
    <EmptyState v-else-if="!mystery?.active || !mystery.npc" title="神秘商人暂未来访" description="商人出现后会在这里显示本轮货品" icon="i-carbon-store" />

    <article v-else class="merchant-card" aria-label="神秘商人商品">
      <header class="merchant-card__head">
        <span class="merchant-avatar" aria-hidden="true"><span class="i-carbon-store" /></span>
        <div class="min-w-0">
          <strong>本轮神秘货品</strong>
          <small>{{ openedAt ? `${openedAt} 开始营业` : '限时营业' }} · 商人 #{{ mystery.npc.id }}</small>
        </div>
        <span v-if="discountLabel" class="merchant-discount">{{ discountLabel }}</span>
      </header>

      <div class="merchant-offer">
        <div class="merchant-offer__visual">
          <CommerceItemImage :src="mystery.npc.reward.image" :alt="mystery.npc.reward.name" size="md" />
        </div>
        <div class="merchant-offer__info">
          <h3 :title="`${mystery.npc.reward.name} #${mystery.npc.reward.id}`">
            <span class="merchant-offer__name">{{ mystery.npc.reward.name }}</span>
            <span class="merchant-offer__qty">×{{ mystery.npc.reward.count.toLocaleString() }}</span>
          </h3>
          <p v-if="mystery.npc.unitPrice">
            单价 {{ mystery.npc.unitPrice.toLocaleString() }}<del v-if="mystery.npc.unitOriginalPrice > mystery.npc.unitPrice">{{ mystery.npc.unitOriginalPrice.toLocaleString() }}</del>
          </p>
          <div class="merchant-price">
            <CommerceItemImage :src="mystery.npc.price.image" :alt="mystery.npc.price.name" size="sm" />
            <strong :title="mystery.npc.price.name">{{ mystery.npc.price.count.toLocaleString() }}</strong>
            <del v-if="mystery.npc.originalPrice > mystery.npc.price.count">{{ mystery.npc.originalPrice.toLocaleString() }}</del>
          </div>
        </div>
        <div class="merchant-offer__buy">
          <NButton type="primary" :loading="mysteryPurchasing" :disabled="!canPurchase || mysteryPurchasing" @click="purchase">
            {{ buttonLabel }}
          </NButton>
        </div>
      </div>

      <p v-if="purchaseHint" class="merchant-hint" role="status">
        <span class="i-carbon-information" aria-hidden="true" />{{ purchaseHint }}
      </p>
    </article>

    <Teleport to="body">
      <Transition name="merchant-dialog">
        <div v-if="purchaseDialogOpen && mystery?.npc" class="purchase-overlay" role="presentation" @click.self="!mysteryPurchasing && (purchaseDialogOpen = false)">
          <section class="purchase-dialog" role="dialog" aria-modal="true" aria-labelledby="mystery-purchase-title">
            <button class="dialog-close" type="button" aria-label="关闭" :disabled="mysteryPurchasing" @click="purchaseDialogOpen = false">
              <div class="i-carbon-close" />
            </button>
            <span class="dialog-kicker">神秘商人交易确认</span>
            <h2 id="mystery-purchase-title">
              确认购买这批商品？
            </h2>
            <div class="dialog-goods">
              <CommerceItemImage :src="mystery.npc.reward.image" :alt="mystery.npc.reward.name" size="lg" />
              <div><strong>{{ mystery.npc.reward.name }}</strong><span>获得 x{{ mystery.npc.reward.count }}</span></div>
            </div>
            <dl class="dialog-summary">
              <div><dt>需支付</dt><dd>{{ mystery.npc.price.count.toLocaleString() }} {{ mystery.npc.price.name }}</dd></div>
              <div><dt>支付后余额</dt><dd>{{ mystery.npc.price.balance === null ? '--' : Math.max(0, mystery.npc.price.balance - mystery.npc.price.count).toLocaleString() }}</dd></div>
            </dl>
            <div class="dialog-actions">
              <button type="button" :disabled="mysteryPurchasing" @click="purchaseDialogOpen = false">
                取消
              </button>
              <button type="button" class="dialog-confirm" :disabled="mysteryPurchasing || !canPurchase" @click="confirmPurchase">
                <div v-if="mysteryPurchasing" class="i-carbon-circle-dash animate-spin" />
                <div v-else class="i-carbon-shopping-cart-plus" />
                {{ mysteryPurchasing ? '购买中' : '确认购买' }}
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.mystery-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 24px;
}

.shop-loading {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--ui-primary);
  font-size: 28px;
}

.shop-message {
  padding: 10px 12px;
  border-radius: var(--ui-radius-control);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 13px;
}

.shop-message.is-success {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

/* 来访商人卡：顶部身份条带紫色点缀，下方是唯一一件货品。 */
.merchant-card {
  width: 100%;
  max-width: 760px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-violet) 22%, var(--ui-border));
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.merchant-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--ui-border);
  background: linear-gradient(90deg, var(--ui-violet-soft), transparent 75%);
}

.merchant-card__head strong {
  display: block;
  color: var(--ui-ink);
  font-size: 15px;
}

.merchant-card__head small {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merchant-avatar {
  width: 38px;
  height: 38px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 12px;
  color: var(--ui-violet);
  background: var(--ui-surface-strong);
  font-size: 20px;
}

.merchant-discount {
  margin-left: auto;
  flex: none;
  padding: 2px 10px;
  border-radius: 999px;
  color: #fff;
  background: var(--ui-danger-fill);
  font-size: 12px;
  font-weight: var(--fw-700);
  line-height: 20px;
}

.merchant-offer {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 18px;
}

.merchant-offer__visual {
  position: relative;
}

.merchant-offer__visual :deep(.item-image) {
  width: 84px;
  height: 84px;
  border: 0;
  border-radius: 20px;
  background: var(--ui-surface-soft);
}

.merchant-offer__qty {
  flex: none;
  color: var(--ui-muted);
  font-size: 15px;
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
}

.merchant-offer__info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.merchant-offer__info h3 {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 17px;
  font-weight: var(--fw-700);
}

.merchant-offer__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merchant-offer__info p {
  margin: 0;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.merchant-offer__info del,
.merchant-price del {
  margin-left: 6px;
  color: var(--ui-subtle);
  font-size: 12px;
}

.merchant-price {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  color: var(--ui-warning);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.merchant-price :deep(.item-image) {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
}

.merchant-offer__buy :deep(.n-button) {
  min-width: 96px;
}

.merchant-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 10px 18px 14px;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.merchant-hint span {
  flex: none;
  margin-top: 3px;
}

@media (max-width: 560px) {
  .merchant-card__head {
    padding: 12px 14px;
  }

  .merchant-offer {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 14px;
    padding: 14px;
  }

  .merchant-offer__visual :deep(.item-image) {
    width: 64px;
    height: 64px;
    border-radius: 16px;
  }

  .merchant-offer__buy {
    grid-column: 1 / -1;
  }

  .merchant-offer__buy :deep(.n-button) {
    width: 100%;
    height: 38px;
  }

  .merchant-hint {
    padding: 0 14px 12px;
  }
}

.purchase-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(35, 47, 38, 0.32);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
.purchase-dialog {
  position: relative;
  width: min(420px, 100%);
  padding: 24px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  color: var(--ui-ink);
  background: var(--ui-surface-strong);
  box-shadow: var(--ui-shadow-lg);
}
.dialog-close {
  position: absolute;
  top: 14px;
  right: 14px;
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  color: var(--ui-muted);
  background: var(--ui-surface);
  cursor: pointer;
}
.dialog-kicker {
  color: var(--ui-violet);
  font-size: 11px;
  font-weight: var(--fw-700);
}
.purchase-dialog h2 {
  margin: 4px 42px 18px 0;
  font-size: 21px;
}
.dialog-goods {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface-soft);
}
.dialog-goods :deep(.item-image) {
  width: 64px;
  height: 64px;
}
.dialog-goods > div:last-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.dialog-goods strong {
  overflow: hidden;
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dialog-goods span {
  margin-top: 3px;
  color: var(--ui-muted);
  font-size: 12px;
}
.dialog-summary {
  margin: 14px 0 18px;
}
.dialog-summary > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 2px;
  border-bottom: 1px solid var(--ui-border);
}
.dialog-summary dt {
  color: var(--ui-muted);
  font-size: 12px;
}
.dialog-summary dd {
  margin: 0;
  color: var(--ui-warning);
  font-weight: var(--fw-700);
}
.dialog-actions {
  display: grid;
  grid-template-columns: 1fr 1.45fr;
  gap: 9px;
}
.dialog-actions button {
  height: 42px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 10px;
  color: var(--ui-ink);
  background: var(--ui-surface);
  font-weight: var(--fw-700);
  cursor: pointer;
}
.dialog-actions .dialog-confirm {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-color: var(--ui-primary);
  color: white;
  background: var(--ui-primary-fill);
}
.dialog-actions button:disabled,
.dialog-close:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.merchant-dialog-enter-active,
.merchant-dialog-leave-active {
  transition: opacity 0.16s ease;
}
.merchant-dialog-enter-active .purchase-dialog,
.merchant-dialog-leave-active .purchase-dialog {
  transition: transform 0.16s ease;
}
.merchant-dialog-enter-from,
.merchant-dialog-leave-to {
  opacity: 0;
}
.merchant-dialog-enter-from .purchase-dialog,
.merchant-dialog-leave-to .purchase-dialog {
  transform: translateY(8px) scale(0.98);
}
</style>
