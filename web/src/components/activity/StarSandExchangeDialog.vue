<script setup lang="ts">
import type { ShopDto, ShopGoodsDto } from '@/stores/activity-center'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = defineProps<{
  open: boolean
  goods: ShopGoodsDto | null
  shop: ShopDto | null
  pending: boolean
}>()
const emit = defineEmits<{
  close: []
  confirm: [goodsId: string, count: number]
}>()

const dialog = ref<HTMLElement | null>(null)
const quantityInput = ref<HTMLInputElement | null>(null)
const quantityText = ref('1')
const submitted = ref(false)
const titleId = `star-sand-exchange-title-${useId()}`
const descriptionId = `star-sand-exchange-description-${useId()}`
let returnFocus: HTMLElement | null = null
let previousOverflow = ''
let pageLocked = false

const matchingCurrency = computed(() => props.shop?.currencies.find(currency => currency.id && currency.id === props.goods?.cost.id) ?? props.shop?.currencies[0])
const balanceKnown = computed(() => props.goods?.balanceKnown === true && (matchingCurrency.value?.balanceKnown ?? props.shop?.balanceKnown) === true)
const balance = computed(() => matchingCurrency.value?.balance ?? props.shop?.balance ?? null)
const maxCount = computed(() => {
  if (!props.goods?.maxExchangeCountKnown || !/^\d+$/.test(props.goods.maxExchangeCount))
    return null
  const value = BigInt(props.goods.maxExchangeCount)
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
})
const quantity = computed(() => /^\d+$/.test(quantityText.value) ? Number(quantityText.value) : Number.NaN)
const validQuantity = computed(() => Number.isSafeInteger(quantity.value)
  && quantity.value > 0
  && (maxCount.value === null || quantity.value <= maxCount.value))
const busy = computed(() => props.pending || submitted.value)
const totalItemCount = computed(() => multiplyCount(props.goods?.item.count, validQuantity.value ? quantity.value : 0))
const totalCost = computed(() => multiplyCount(props.goods?.cost.count, validQuantity.value ? quantity.value : 0))
const validationMessage = computed(() => {
  if (!/^\d+$/.test(quantityText.value) || !Number.isSafeInteger(quantity.value) || quantity.value <= 0)
    return '请输入正整数兑换数量'
  if (maxCount.value !== null && quantity.value > maxCount.value)
    return `最多可兑换 ${maxCount.value} 份`
  return ''
})

function multiplyCount(value: string | undefined, multiplier: number) {
  if (!/^\d+$/.test(value || '') || multiplier < 1)
    return '0'
  return (BigInt(value!) * BigInt(multiplier)).toString()
}

function setQuantity(value: number) {
  if (busy.value)
    return
  const safeValue = Number.isFinite(value) ? Math.trunc(value) : 1
  const maximum = maxCount.value ?? Number.MAX_SAFE_INTEGER
  quantityText.value = String(Math.min(maximum, Math.max(1, safeValue)))
}

function normalizeQuantity() {
  if (busy.value)
    return
  if (!validQuantity.value)
    setQuantity(Number.isFinite(quantity.value) ? quantity.value : 1)
}

function close() {
  if (!busy.value)
    emit('close')
}

function confirm() {
  if (busy.value || !validQuantity.value || !props.goods)
    return
  submitted.value = true
  emit('confirm', props.goods.id, quantity.value)
}

function focusableElements() {
  return Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab')
    return
  const focusable = focusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function unlockPage(restoreFocus = true) {
  if (!pageLocked)
    return
  document.body.style.overflow = previousOverflow
  window.removeEventListener('keydown', onKeydown)
  if (restoreFocus)
    returnFocus?.focus()
  returnFocus = null
  pageLocked = false
}

watch(() => props.open, async (open) => {
  if (open) {
    quantityText.value = '1'
    submitted.value = false
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    pageLocked = true
    window.addEventListener('keydown', onKeydown)
    await nextTick()
    quantityInput.value?.focus()
    quantityInput.value?.select()
  }
  else {
    submitted.value = false
    unlockPage()
  }
})

watch(() => props.pending, (pending, wasPending) => {
  if (wasPending && !pending)
    submitted.value = false
})

onBeforeUnmount(() => unlockPage(false))
</script>

<template>
  <Teleport to="body">
    <Transition name="exchange-fade">
      <div v-if="open && goods" class="exchange-overlay" role="presentation" @mousedown.self="close">
        <section
          ref="dialog"
          class="exchange-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="descriptionId"
          tabindex="-1"
        >
          <header>
            <h2 :id="titleId">
              确认兑换
            </h2>
            <button type="button" class="close-button" aria-label="关闭兑换确认" :disabled="busy" @click="close">
              ×
            </button>
          </header>

          <div class="goods-summary">
            <div class="goods-picture">
              <img v-if="goods.item.image" :src="goods.item.image" :alt="goods.item.name || goods.name">
              <span v-else aria-hidden="true">◇</span>
            </div>
            <div class="goods-copy">
              <strong>{{ goods.name || goods.item.name || '兑换商品' }}</strong>
              <span>每份获得 {{ goods.item.count || '0' }} {{ goods.item.name }}</span>
              <span>单价 {{ goods.cost.count || '0' }} {{ goods.cost.name || shop?.currency.name || '星砂' }}</span>
              <span>当前拥有：{{ goods.owned ? '已拥有' : '未拥有' }}</span>
            </div>
          </div>

          <div class="balance-row">
            <span>可用余额</span>
            <b>{{ balanceKnown ? (balance ?? '0') : '未知' }}</b>
          </div>

          <div class="quantity-section">
            <label for="star-sand-exchange-quantity">兑换数量</label>
            <div class="quantity-control">
              <button type="button" aria-label="减少兑换数量" :disabled="busy || quantity <= 1" @click="setQuantity(quantity - 1)">
                −
              </button>
              <input
                id="star-sand-exchange-quantity"
                ref="quantityInput"
                v-model="quantityText"
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                autocomplete="off"
                :disabled="busy"
                :aria-invalid="!!validationMessage"
                :aria-describedby="validationMessage ? 'star-sand-exchange-error' : undefined"
                @blur="normalizeQuantity"
                @keydown.enter.prevent="confirm"
              >
              <button type="button" aria-label="增加兑换数量" :disabled="busy || !validQuantity || (maxCount !== null && quantity >= maxCount)" @click="setQuantity(quantity + 1)">
                ＋
              </button>
              <button type="button" class="maximum-button" :disabled="busy || maxCount === null || maxCount < 1" @click="setQuantity(maxCount || 1)">
                最大
              </button>
            </div>
            <p v-if="validationMessage" id="star-sand-exchange-error" class="validation-message" role="alert">
              {{ validationMessage }}
            </p>
            <p v-else class="limit-message">
              最多可兑换 {{ maxCount ?? '—' }} 份
            </p>
          </div>

          <div class="totals" aria-live="polite">
            <span>总获得 <b>{{ totalItemCount }}</b> {{ goods.item.name }}</span>
            <span>总消耗 <b>{{ totalCost }}</b> {{ goods.cost.name || shop?.currency.name || '星砂' }}</span>
          </div>

          <p :id="descriptionId" class="confirmation-copy">
            请再次确认商品和数量。确认后将立即扣除星砂并发放奖励。
          </p>
          <div class="dialog-actions">
            <button type="button" class="cancel-button" :disabled="busy" @click="close">
              取消
            </button>
            <button type="button" class="confirm-button" :disabled="busy || !validQuantity" @click="confirm">
              {{ busy ? '兑换中…' : `确认兑换 ${validQuantity ? quantity : ''} 份` }}
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.exchange-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 18px;
  background: rgba(0, 12, 38, 0.78);
  backdrop-filter: blur(2px);
}
.exchange-dialog {
  position: relative;
  width: min(390px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 20px;
  border: 3px solid #83cdec;
  border-radius: 22px;
  color: #eefaff;
  background:
    radial-gradient(circle at 50% 0, rgba(67, 163, 218, 0.52), transparent 42%),
    linear-gradient(155deg, #164c92, #252f77 70%, #18235e);
  box-shadow:
    0 16px 45px rgba(0, 0, 0, 0.58),
    inset 0 0 0 2px rgba(208, 243, 255, 0.18);
  scrollbar-width: thin;
}
.exchange-dialog header {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 15px;
}
.exchange-dialog h2 {
  margin: 0;
  color: #fff4bd;
  font-size: 22px;
  letter-spacing: 0.08em;
  text-shadow: 0 2px 3px #664a18;
}
.close-button {
  position: absolute;
  top: -10px;
  right: -9px;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 2px solid #b6e8fa;
  border-radius: 50%;
  color: white;
  background: #326ca7;
  font: 700 27px/30px Arial;
  cursor: pointer;
}
.close-button:disabled {
  opacity: 0.55;
  cursor: wait;
}
.goods-summary {
  display: flex;
  gap: 13px;
  padding: 12px;
  border: 1px solid rgba(167, 225, 250, 0.45);
  border-radius: 15px;
  background: rgba(9, 53, 110, 0.46);
}
.goods-picture {
  width: 96px;
  height: 96px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 12px;
  background: linear-gradient(160deg, rgba(161, 226, 247, 0.5), rgba(55, 103, 170, 0.4));
}
.goods-picture img {
  width: 90%;
  height: 90%;
  object-fit: contain;
}
.goods-picture span {
  font-size: 45px;
  color: #bce9f8;
}
.goods-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}
.goods-copy strong {
  overflow: hidden;
  color: white;
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.goods-copy span {
  color: #cce9f6;
  font-size: 11px;
}
.balance-row {
  display: flex;
  justify-content: space-between;
  margin: 12px 2px 8px;
  padding: 9px 12px;
  border-radius: 10px;
  color: #cdeafb;
  background: rgba(5, 33, 83, 0.42);
}
.balance-row b {
  color: #fff0a6;
}
.quantity-section {
  padding: 4px 2px;
}
.quantity-section label {
  display: block;
  margin-bottom: 7px;
  font-size: 13px;
  font-weight: var(--fw-700);
}
.quantity-control {
  display: grid;
  grid-template-columns: 40px minmax(62px, 1fr) 40px 54px;
  gap: 6px;
}
.quantity-control button,
.quantity-control input {
  height: 40px;
  border: 1px solid #81c8e8;
  border-radius: 9px;
}
.quantity-control button {
  color: white;
  background: #286ea9;
  font-size: 20px;
  font-weight: var(--fw-700);
  cursor: pointer;
}
.quantity-control button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.quantity-control input {
  min-width: 0;
  padding: 0 7px;
  color: #42310e;
  background: #fff9d8;
  font-size: 17px;
  font-weight: var(--fw-700);
  text-align: center;
  outline: none;
}
.quantity-control input:focus {
  border-color: #fff0a0;
  box-shadow: 0 0 0 3px rgba(255, 239, 145, 0.25);
}
.quantity-control .maximum-button {
  font-size: 12px;
}
.validation-message,
.limit-message {
  min-height: 17px;
  margin: 5px 2px 0;
  font-size: 10px;
}
.validation-message {
  color: #ffd1c9;
}
.limit-message {
  color: #a9d1e6;
}
.totals {
  display: grid;
  gap: 4px;
  margin-top: 5px;
  padding: 11px 12px;
  border: 1px solid rgba(255, 230, 133, 0.36);
  border-radius: 11px;
  color: #d9edf8;
  background: rgba(7, 30, 78, 0.42);
  font-size: 12px;
}
.totals span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.totals b {
  color: #fff0a4;
}
.confirmation-copy {
  margin: 12px 5px;
  color: #bcd9e8;
  font-size: 11px;
  line-height: 1.55;
  text-align: center;
}
.dialog-actions {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: 9px;
}
.dialog-actions button {
  min-height: 44px;
  border-radius: 12px;
  font-weight: var(--fw-700);
  cursor: pointer;
}
.dialog-actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.cancel-button {
  border: 1px solid #80b8d6;
  color: #d9eff9;
  background: rgba(20, 70, 122, 0.68);
}
.confirm-button {
  border: 2px solid #fff0a2;
  color: #66440c;
  background: linear-gradient(#fff6b8, #e7b94f);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.24);
}
button:focus-visible,
input:focus-visible {
  outline: 3px solid #fff5a8;
  outline-offset: 2px;
}
.exchange-fade-enter-active,
.exchange-fade-leave-active {
  transition: opacity 0.16s ease;
}
.exchange-fade-enter-active .exchange-dialog,
.exchange-fade-leave-active .exchange-dialog {
  transition: transform 0.16s ease;
}
.exchange-fade-enter-from,
.exchange-fade-leave-to {
  opacity: 0;
}
.exchange-fade-enter-from .exchange-dialog,
.exchange-fade-leave-to .exchange-dialog {
  transform: scale(0.96);
}
@media (max-height: 650px) {
  .exchange-overlay {
    align-items: flex-start;
    padding-top: 12px;
    padding-bottom: 12px;
  }
  .exchange-dialog {
    padding: 15px;
  }
  .goods-picture {
    width: 78px;
    height: 78px;
  }
}
</style>
