<script setup lang="ts">
import type { DogFoodInfo, PetInfo } from '@/stores/pet'
import { useStorage } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { NTag } from 'naive-ui/es/tag'
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import OverflowTooltip from '@/components/ui/OverflowTooltip.vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { usePetStore } from '@/stores/pet'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const bagStore = useBagStore()
const petStore = usePetStore()
const statusStore = useStatusStore()
const toastStore = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)
const {
  snapshot,
  dogs,
  foods,
  activeDog,
  loading,
  usingFood,
  operatingDogId,
  protectLogs,
  protectLogsTotal,
  protectLogsLoading,
  claimingGifts,
  giftError,
  error,
} = storeToRefs(petStore)

const useCounts = reactive<Record<number, number>>({})
const tokenRef = useStorage('admin_token', '')
const showProtectLogs = ref(false)
const currentPetTab = ref('pets')

const isConnected = computed(() => !!status.value?.connection?.connected)
const maxDuration = computed(() => Number(snapshot.value?.maxProtectDuration || 30 * 86400))
const protectDuration = computed(() => Math.max(0, Number(snapshot.value?.protectDuration || 0)))
const durationPercent = computed(() => Math.min(100, Math.round((protectDuration.value / maxDuration.value) * 100)))
const pendingGiftCount = computed(() => Math.max(0, Number(snapshot.value?.pendingGiftCount || 0)))

function formatDuration(secondsInput: unknown) {
  let seconds = Math.max(0, Math.floor(Number(secondsInput) || 0))
  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  if (days > 0)
    return `${days}天${hours}小时${minutes}分`
  if (hours > 0)
    return `${hours}小时${minutes}分`
  return `${minutes}分`
}

function formatFoodDuration(seconds: number) {
  const days = Math.round(Number(seconds || 0) / 86400)
  return days > 0 ? `${days}天` : `${Math.max(1, Math.round(Number(seconds || 0) / 3600))}小时`
}

function formatProtectTime(timestamp: number) {
  if (!timestamp)
    return '时间未知'
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false })
}

function petRarityType(pet: PetInfo): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (pet.rarity >= 4)
    return 'warning'
  if (pet.rarity === 3)
    return 'info'
  if (pet.rarity === 2)
    return 'success'
  return 'default'
}

function maxUsableCount(food: DogFoodInfo) {
  if (!activeDog.value || food.duration <= 0)
    return 0
  const remaining = Math.max(0, maxDuration.value - protectDuration.value)
  return Math.max(0, Math.min(food.count, Math.floor(remaining / food.duration)))
}

function selectedCount(food: DogFoodInfo) {
  const max = maxUsableCount(food)
  const current = Math.trunc(Number(useCounts[food.id] || 1))
  return Math.max(1, Math.min(max || 1, current))
}

function canUseFood(food: DogFoodInfo) {
  return !!currentAccountId.value && !!activeDog.value && food.count > 0 && maxUsableCount(food) > 0 && !usingFood.value
}

function operationTitle(pet: PetInfo) {
  if (pet.owned)
    return pet.active ? '收回当前宠物' : '将该宠物上场'
  return pet.activatable ? '消耗背包中的宠物卡激活该宠物' : '没有宠物卡，无法激活'
}

function dogActionLabel(pet: PetInfo) {
  if (pet.owned)
    return pet.active ? '收回' : '上场'
  return pet.activatable ? '激活' : '未获得'
}

function dogActionType(pet: PetInfo): 'default' | 'info' | 'success' | 'warning' {
  if (!pet.owned)
    return pet.activatable ? 'info' : 'default'
  return pet.active ? 'warning' : 'success'
}

function dogStatusLabel(pet: PetInfo) {
  if (pet.active)
    return '上场中'
  if (pet.owned)
    return '已获得'
  return pet.activatable ? '待激活' : '未获得'
}

function isPetLocked(pet: PetInfo) {
  return !pet.owned && !pet.activatable
}

async function handlePetOperation(pet: PetInfo) {
  if (operatingDogId.value || isPetLocked(pet))
    return
  if (!pet.owned) {
    const activated = await petStore.activateDog(currentAccountId.value, pet.id)
    if (activated)
      toastStore.success(`已激活 ${pet.name}`)
    else
      toastStore.error(error.value || '激活宠物失败')
    return
  }
  const result = pet.active
    ? await petStore.withdrawDog(currentAccountId.value, pet.id)
    : await petStore.deployDog(currentAccountId.value, pet.id)
  if (result)
    toastStore.success(pet.active ? `已收回 ${pet.name}` : `已上场 ${pet.name}`)
  else
    toastStore.error(error.value || (pet.active ? '收回宠物失败' : '上场宠物失败'))
}

async function loadPetInfo() {
  const id = String(currentAccountId.value || '')
  const account = currentAccount.value
  if (!id || !account)
    return
  if (!realtimeConnected.value)
    await statusStore.fetchStatus(id)
  if (account.running && isConnected.value)
    await petStore.fetchPetInfo(id)
}

async function refreshPetInfo() {
  const id = String(currentAccountId.value || '')
  if (id)
    await petStore.fetchPetInfo(id)
}

async function handleClaimGifts() {
  const id = String(currentAccountId.value || '')
  if (!id || claimingGifts.value)
    return

  const result = await petStore.claimDogSkillGifts(id)
  if (!result) {
    toastStore.error(giftError.value || '拾取同气连枝礼包失败')
    return
  }

  const claimed = Math.max(0, Number(result.claimed || 0))
  if (claimed > 0)
    toastStore.success(`已拾取同气连枝礼包 x${claimed}`)
  else
    toastStore.warning('当前没有待拾取的同气连枝礼包')
}

async function handleUseFood(food: DogFoodInfo) {
  if (!canUseFood(food))
    return
  const count = selectedCount(food)
  const result = await petStore.useDogFood(currentAccountId.value, food.id, count)
  if (result) {
    toastStore.success(`已从狗盆喂食 ${food.name} x${count}`)
    if (isConnected.value)
      await bagStore.fetchBag(currentAccountId.value)
  }
  else {
    toastStore.error(error.value || '使用狗粮失败')
  }
}

async function openProtectLogs() {
  if (!snapshot.value?.guardianRecordsSupported)
    return
  const ok = await petStore.fetchProtectLogs(currentAccountId.value)
  if (ok)
    showProtectLogs.value = true
  else
    toastStore.error(error.value || '获取守护记录失败')
}

function setUseCount(food: DogFoodInfo, value: number | null) {
  useCounts[food.id] = Math.max(1, Math.trunc(Number(value) || 1))
}

onMounted(loadPetInfo)
watch(currentAccountId, () => {
  showProtectLogs.value = false
  petStore.clear()
  void loadPetInfo()
})
</script>

<template>
  <div class="personal-panel pet-page">
    <div class="pet-heading flex shrink-0 items-center justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-lg font-bold">
          <span class="i-carbon-dog-walker" /> 宠物
        </h2>
      </div>
      <div class="flex items-center gap-2">
        <NButton v-if="pendingGiftCount > 0" size="small" type="warning" class="pet-gift-compact" title="拾取同气连枝礼包" aria-label="拾取同气连枝礼包" :loading="claimingGifts" :disabled="!isConnected" @click="handleClaimGifts">
          <template #icon>
            <span class="i-carbon-gift" />
          </template>
          礼包 ×{{ pendingGiftCount }}
        </NButton>
        <NButton
          size="small" secondary :loading="protectLogsLoading"
          title="守护记录" aria-label="守护记录"
          :disabled="!currentAccountId || !isConnected || !snapshot?.guardianRecordsSupported" @click="openProtectLogs"
        >
          <template #icon>
            <span class="i-carbon-document" />
          </template>
          <span class="pet-record-label">守护记录</span>
        </NButton>
        <NButton
          circle quaternary size="small" title="刷新宠物信息" :loading="loading || statusLoading"
          :disabled="!currentAccountId || !isConnected || !tokenRef" @click="refreshPetInfo"
        >
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </div>

    <div v-if="loading || statusLoading" class="pet-state pet-card flex justify-center py-12">
      <span class="i-carbon-circle-dash animate-spin text-4xl" />
    </div>
    <div v-else-if="!currentAccountId" class="pet-state pet-card">
      请选择账号后查看宠物
    </div>
    <EmptyState v-else-if="!isConnected" title="账号未运行" description="请先启动账号；启动后会读取宠物信息" icon="i-carbon-connection-signal-off" />
    <div v-else-if="error && !snapshot" class="pet-state pet-card pet-state--error">
      <strong>获取宠物数据失败</strong>
      <span>{{ error }}</span>
    </div>

    <template v-else-if="snapshot">
      <section v-if="pendingGiftCount > 0" class="pet-gift shrink-0">
        <div class="pet-gift__icon" aria-hidden="true">
          <span class="i-carbon-gift" />
        </div>
        <div class="pet-gift__copy">
          <div class="pet-gift__title">
            <h3>同气连枝礼包</h3>
            <span class="pet-gift__count">x{{ pendingGiftCount }}</span>
          </div>
          <p>拾取奖励存入背包</p>
          <span v-if="giftError" class="pet-gift__error">{{ giftError }}</span>
        </div>
        <NButton
          type="warning"
          size="small"
          class="pet-gift__action"
          :loading="claimingGifts"
          :disabled="!isConnected"
          @click="handleClaimGifts"
        >
          <template #icon>
            <span class="i-carbon-download" />
          </template>
          拾取全部
        </NButton>
      </section>

      <p v-if="giftError" class="pet-mobile-error shrink-0 text-xs text-red-500" role="alert">
        {{ giftError }}
      </p>

      <section class="pet-overview pet-card shrink-0">
        <div class="pet-overview__copy">
          <h3>{{ activeDog ? `${activeDog.name} 正在看家` : '暂未上场宠物' }}</h3>
          <p v-if="!activeDog">
            选择一只已获得的宠物上场即可开始看护。
          </p>
        </div>
        <div class="pet-duration">
          <div class="pet-duration__label">
            <span>狗粮剩余时间</span>
            <strong>{{ formatDuration(protectDuration) }}</strong>
          </div>
          <div class="pet-duration__track" aria-hidden="true">
            <div class="pet-duration__fill" :style="{ width: `${durationPercent}%` }" />
          </div>
          <small>上限 30 天 · 已使用 {{ durationPercent }}%</small>
        </div>
      </section>

      <section class="personal-panel__card pet-section">
        <div class="pet-section__heading panel-sticky panel-sticky--inset shrink-0" style="--panel-pad: 18px">
          <NTabs v-model:value="currentPetTab" class="min-w-0 flex-1" type="line" animated>
            <NTab name="pets">
              我的宠物 <span class="ml-1 text-xs text-gray-400">{{ dogs.filter(dog => dog.owned).length }}/{{ dogs.length }}</span>
            </NTab>
            <NTab name="food">
              狗盆喂食
            </NTab>
          </NTabs>
        </div>

        <div v-show="currentPetTab === 'pets'" class="personal-panel__scroll custom-scrollbar" role="region" aria-label="我的宠物列表" tabindex="0">
          <EmptyState v-if="!dogs.length" bare title="暂无宠物" icon="i-carbon-dog-walker" />
          <div v-else class="pet-grid">
            <article
              v-for="pet in dogs" :key="pet.id" class="pet-tile"
              :class="{ 'pet-tile--locked': !pet.owned && !pet.activatable, 'pet-tile--active': pet.active }"
            >
              <div class="pet-tile__top">
                <div class="pet-avatar" :class="{ 'pet-avatar--locked': !pet.owned && !pet.activatable }">
                  <img :src="pet.image" :alt="pet.name" loading="lazy">
                  <span v-if="!pet.owned && !pet.activatable" class="pet-avatar__lock i-carbon-locked" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <h4>{{ pet.name }}</h4>
                    <NTag size="small" :type="petRarityType(pet)" :bordered="false">
                      {{ pet.rarityLabel }}
                    </NTag>
                  </div>
                  <div
                    class="pet-tile__status"
                    :class="{ 'pet-tile__status--active': pet.active, 'pet-tile__status--owned': (pet.owned || pet.activatable) && !pet.active }"
                  >
                    <span
                      class="status-dot"
                      :class="{ 'status-dot--owned': pet.owned || pet.activatable, 'status-dot--active': pet.active }"
                    />
                    {{ dogStatusLabel(pet) }}
                  </div>
                </div>
              </div>
              <div class="pet-tile__detail pet-tile__detail--skills">
                <span class="pet-detail-label">技能</span>
                <div v-for="skill in pet.skills" :key="skill.name" class="pet-skill">
                  <strong>{{ skill.name }}</strong>
                  <span v-if="skill.remainingCount !== undefined && skill.dailyLimit" class="pet-skill__usage">
                    今日剩余：{{ skill.remainingCount }}/{{ skill.dailyLimit }}
                  </span>
                  <OverflowTooltip class="pet-description" :text="skill.description" :lines="3" />
                </div>
              </div>
              <div class="pet-tile__detail">
                <span class="pet-detail-label">获得条件</span>
                <OverflowTooltip class="pet-description" :text="pet.obtainCondition" :lines="2" />
              </div>
              <NButton
                size="small" ghost block :type="dogActionType(pet)" class="pet-action"
                :class="pet.active ? 'pet-action--withdraw' : (pet.owned ? 'pet-action--deploy' : (pet.activatable ? 'pet-action--activate' : 'pet-action--locked'))"
                :loading="operatingDogId === pet.id" :disabled="isPetLocked(pet) || !!operatingDogId"
                :title="operationTitle(pet)" @click="handlePetOperation(pet)"
              >
                {{ dogActionLabel(pet) }}
              </NButton>
            </article>
          </div>
        </div>

        <div v-show="currentPetTab === 'food'" class="personal-panel__scroll custom-scrollbar" role="region" aria-label="狗盆喂食列表" tabindex="0">
          <EmptyState v-if="!foods.length" bare title="狗盆里暂无狗粮" icon="i-carbon-box" />
          <div v-else class="food-list">
            <div v-for="food in foods" :key="food.id" class="food-row">
              <img class="food-row__image" :src="food.image" :alt="food.name" loading="lazy">
              <div class="food-row__copy">
                <strong>{{ food.name }}</strong>
                <span>每份增加 {{ formatFoodDuration(food.duration) }} · 库存 {{ food.count }}</span>
              </div>
              <NInputNumber
                :value="selectedCount(food)" :min="1" :max="Math.max(1, maxUsableCount(food))" size="small"
                :disabled="!canUseFood(food)" class="food-row__count" @update:value="value => setUseCount(food, value)"
              />
              <NButton
                size="small" type="primary" :loading="usingFood" :disabled="!canUseFood(food)"
                :title="!activeDog ? '请先上场宠物' : (food.count <= 0 ? '狗盆中没有该狗粮' : '从狗盆喂食')" class="food-feed-button"
                @click="handleUseFood(food)"
              >
                <template #icon>
                  <span class="i-carbon-add-alt" aria-hidden="true" />
                </template>
                <span>喂食</span>
              </NButton>
            </div>
          </div>
        </div>
      </section>
    </template>

    <NModal
      v-model:show="showProtectLogs"
      preset="card"
      title="守护记录"
      class="protect-log-modal"
      :bordered="false"
      :style="{ width: 'min(680px, calc(100vw - 32px))', maxHeight: 'min(760px, calc(100vh - 32px))' }"
    >
      <div class="protect-log-summary">
        共 {{ protectLogsTotal }} 条记录
      </div>
      <div v-if="!protectLogs.length" class="protect-log-empty">
        暂无守护记录
      </div>
      <div v-else class="protect-log-list">
        <article v-for="logItem in protectLogs" :key="logItem.id" class="protect-log-row">
          <img
            v-if="logItem.friendAvatar" :src="logItem.friendAvatar" :alt="logItem.friendName"
            class="protect-log-avatar"
          >
          <div v-else class="protect-log-avatar protect-log-avatar--empty">
            <span class="i-carbon-user" />
          </div>
          <div class="protect-log-copy">
            <div><strong>{{ logItem.dogName || '宠物' }}</strong> 拦截了 <strong>{{ logItem.friendName }}</strong> 的摘取</div>
            <span>拦截果实 {{ logItem.stolenCount }} · 守护金币 {{ logItem.protectedGold }}</span>
            <time>{{ formatProtectTime(logItem.timestamp) }}</time>
          </div>
        </article>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.pet-page {
  color: var(--ui-ink, #24352a);
}

.pet-heading {
  padding-inline: 2px;
}

.pet-gift-compact,
.pet-mobile-error {
  display: none;
}

.pet-card,
.pet-section {
  border: 1px solid var(--ui-border, rgba(58, 86, 68, 0.12));
  border-radius: 12px;
  background: color-mix(in srgb, var(--ui-bg) 72%, transparent);
  box-shadow: var(--ui-shadow-sm, 0 8px 24px rgba(55, 75, 61, 0.08));
}

.pet-card {
  padding: 18px;
}

.pet-state {
  display: flex;
  min-height: 170px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ui-muted, #718477);
  text-align: center;
}

.pet-state--error {
  flex-direction: column;
  color: #a44848;
}

.pet-gift {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid rgba(205, 145, 54, 0.34);
  border-left: 4px solid #d79a3e;
  border-radius: 12px;
  background: var(--ui-warning-soft);
  box-shadow: 0 8px 22px rgba(119, 84, 31, 0.08);
}

.pet-gift__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid rgba(201, 137, 39, 0.24);
  border-radius: 10px;
  background: rgba(244, 184, 86, 0.16);
  color: #b87518;
  font-size: 20px;
}

.pet-gift__copy {
  min-width: 0;
}

.pet-gift__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.pet-gift__title h3 {
  margin: 0;
  color: #543b1b;
  font-size: 14px;
  font-weight: var(--fw-750);
}

.pet-gift__count {
  display: inline-flex;
  min-width: 30px;
  height: 22px;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  border: 1px solid rgba(188, 119, 23, 0.25);
  border-radius: 999px;
  background: rgba(230, 154, 45, 0.12);
  color: #a8650d;
  font-size: 11px;
  font-weight: var(--fw-800);
}

.pet-gift__copy p {
  margin: 5px 0 0;
  color: #7b6648;
  font-size: 12px;
  line-height: 1.5;
}

.pet-gift__error {
  display: block;
  margin-top: 5px;
  color: #a44848;
  font-size: 11px;
}

.pet-gift__action {
  min-width: 84px;
  font-weight: var(--fw-700);
}

:deep(.pet-gift__action .n-button__content) {
  gap: 6px;
}

.pet-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.8fr);
  gap: 24px;
  align-items: center;
  background:
    linear-gradient(115deg, var(--ui-primary-soft), color-mix(in srgb, var(--ui-bg) 68%, transparent)),
    var(--ui-surface, #f8faf6);
}

.pet-overview__copy h3,
.pet-section h3 {
  margin: 3px 0 0;
  color: var(--ui-ink, #24352a);
  font-size: 18px;
  font-weight: var(--fw-750);
}

.pet-overview__copy p {
  margin: 7px 0 0;
  color: var(--ui-muted, #718477);
  font-size: 13px;
}

.pet-duration {
  padding: 14px;
  border-left: 1px solid rgba(78, 112, 85, 0.14);
}

.pet-duration__label {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-muted, #718477);
  font-size: 12px;
}

.pet-duration__label strong {
  color: var(--ui-primary, #47795a);
  font-size: 15px;
}

.pet-duration__track {
  height: 9px;
  margin-top: 11px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(80, 111, 84, 0.14);
}

.pet-duration__fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #8fc76f, #4e9a68);
  transition: width 0.25s ease;
}

.pet-duration small {
  display: block;
  margin-top: 7px;
  color: var(--ui-muted, #718477);
  font-size: 11px;
}

.pet-section {
  --panel-sticky-bg: var(--ui-bg);
  padding: 18px;
}

.pet-section__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.pet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(235px, 1fr));
  gap: 12px;
  align-content: start;
}

.pet-tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(78, 112, 85, 0.16);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.pet-tile:hover {
  border-color: rgba(78, 145, 91, 0.38);
  box-shadow: 0 10px 24px rgba(55, 95, 62, 0.1);
  transform: translateY(-1px);
}

.pet-tile--locked {
  opacity: 0.68;
  filter: saturate(0.68);
}

.pet-tile--active {
  border-color: rgba(73, 139, 83, 0.58);
  box-shadow: 0 0 0 2px rgba(115, 180, 99, 0.14);
}

.pet-tile__top {
  display: flex;
  align-items: center;
  gap: 11px;
}

.pet-avatar {
  position: relative;
  display: grid;
  width: 66px;
  height: 66px;
  flex: none;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(78, 112, 85, 0.18);
  border-radius: 50%;
  background: var(--ui-primary-soft);
}

.pet-avatar img {
  width: 82%;
  height: 82%;
  object-fit: contain;
}

.pet-avatar--locked img {
  filter: grayscale(1);
}

.pet-avatar__lock {
  position: absolute;
  right: 3px;
  bottom: 3px;
  display: grid;
  width: 19px;
  height: 19px;
  place-items: center;
  border-radius: 50%;
  background: rgba(55, 73, 62, 0.78);
  color: #fff;
  font-size: 11px;
}

.pet-tile h4 {
  overflow: hidden;
  color: var(--ui-ink, #24352a);
  font-size: 16px;
  font-weight: var(--fw-700);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pet-tile__status {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  color: var(--ui-muted, #718477);
  font-size: 11px;
}

.pet-tile__status--owned {
  color: #52765e;
}

.pet-tile__status--active {
  color: #2f8950;
  font-weight: var(--fw-700);
}

.pet-tile__status--activatable {
  color: #3d6f9e;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a6b0a7;
}

.status-dot--owned {
  background: #63a56d;
}

.status-dot--active {
  background: #2f9a55;
  box-shadow: 0 0 0 3px rgba(47, 154, 85, 0.13);
}

.status-dot--activatable {
  background: #5b8fc0;
}

.pet-tile__detail {
  min-height: 43px;
}

.pet-detail-label {
  color: var(--ui-muted, #718477);
  font-size: 10px;
  font-weight: var(--fw-700);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.pet-tile__detail .pet-description {
  margin: 3px 0 0;
  color: var(--ui-ink, #33483a);
  font-size: 12px;
  line-height: 1.45;
}

.pet-tile__detail--skills {
  min-height: 68px;
}

.pet-skill + .pet-skill {
  margin-top: 7px;
}

.pet-skill strong {
  color: var(--ui-primary, #47795a);
  font-size: 11px;
}

.pet-skill__usage {
  display: inline-flex;
  margin-left: 7px;
  padding: 1px 6px;
  border: 1px solid rgba(203, 132, 43, 0.25);
  border-radius: 999px;
  background: rgba(241, 169, 67, 0.1);
  color: #a96920;
  font-size: 10px;
  font-weight: var(--fw-700);
  line-height: 1.45;
}

.pet-action {
  margin-top: auto;
  font-weight: var(--fw-700);
}

:deep(.pet-action--deploy .n-button__border) {
  border-color: rgba(57, 145, 83, 0.62);
}

:deep(.pet-action--withdraw .n-button__border) {
  border-color: rgba(204, 126, 31, 0.68);
}

:deep(.pet-action--activate .n-button__border) {
  border-color: rgba(64, 124, 178, 0.62);
}

:deep(.pet-action--locked .n-button__border) {
  border-color: rgba(113, 132, 119, 0.3);
}

.food-list {
  display: grid;
  gap: 8px;
  align-content: start;
}

.food-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid rgba(78, 112, 85, 0.12);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ui-surface-strong) 50%, transparent);
}

.food-row__image {
  width: 42px;
  height: 42px;
  flex: none;
  object-fit: contain;
}

.food-row__copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.food-row__copy strong {
  overflow: hidden;
  color: var(--ui-ink, #24352a);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.food-row__copy span {
  color: var(--ui-muted, #718477);
  font-size: 11px;
}

.food-row__count {
  width: 76px;
  flex: none;
}

:deep(.food-feed-button .n-button__content) {
  gap: 6px;
}

:deep(.protect-log-modal) {
  max-height: min(760px, calc(100vh - 28px));
  border-radius: 14px;
}

.protect-log-summary,
.protect-log-empty {
  color: var(--ui-muted, #718477);
  font-size: 12px;
}

.protect-log-empty {
  padding: 48px 0;
  text-align: center;
}

.protect-log-list {
  display: grid;
  max-height: min(620px, calc(100vh - 160px));
  gap: 8px;
  margin-top: 12px;
  overflow-y: auto;
}

.protect-log-row {
  display: flex;
  gap: 10px;
  padding: 11px;
  border: 1px solid rgba(78, 112, 85, 0.12);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-surface-strong) 55%, transparent);
}

.protect-log-avatar {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 50%;
  object-fit: cover;
}

.protect-log-avatar--empty {
  display: grid;
  place-items: center;
  background: rgba(80, 111, 84, 0.12);
}

.protect-log-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  color: var(--ui-ink, #33483a);
  font-size: 12px;
}

.protect-log-copy span,
.protect-log-copy time {
  color: var(--ui-muted, #718477);
  font-size: 11px;
}

@media (max-width: 700px) {
  .pet-gift {
    padding: 10px;
  }

  .pet-overview {
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 12px 14px;
  }

  .pet-duration {
    padding: 0;
    border-left: 0;
  }

  .pet-overview__copy h3 {
    margin: 0;
    font-size: 16px;
  }

  .pet-section {
    padding: 12px;
  }

  .pet-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .food-row {
    flex-wrap: wrap;
  }

  .food-row__copy {
    min-width: calc(100% - 62px);
  }

  .food-row__count {
    margin-left: 52px;
  }
}

@media (max-width: 520px) {
  .pet-gift,
  .pet-record-label {
    display: none;
  }

  .pet-gift-compact {
    display: inline-flex;
  }

  .pet-mobile-error {
    display: block;
  }

  .pet-gift__title {
    gap: 4px;
  }

  .pet-gift__title h3 {
    font-size: 13px;
  }

  .pet-gift__copy p {
    font-size: 11px;
  }

  .pet-duration__track {
    margin-top: 7px;
  }

  .pet-duration small {
    display: none;
  }
}
</style>
