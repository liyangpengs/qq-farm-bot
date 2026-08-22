<script setup lang="ts">
import type { DogFoodInfo, PetInfo } from '@/stores/pet'
import { useStorage } from '@vueuse/core'
import { NButton, NInputNumber, NModal, NTag } from 'naive-ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, ref, watch } from 'vue'
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
const { snapshot, dogs, foods, activeDog, loading, usingFood, operatingDogId, protectLogs, protectLogsTotal, protectLogsLoading, error } = storeToRefs(petStore)

const useCounts = reactive<Record<number, number>>({})
const tokenRef = useStorage('admin_token', '')
const showProtectLogs = ref(false)

const isConnected = computed(() => !!status.value?.connection?.connected)
const maxDuration = computed(() => Number(snapshot.value?.maxProtectDuration || 30 * 86400))
const protectDuration = computed(() => Math.max(0, Number(snapshot.value?.protectDuration || 0)))
const durationPercent = computed(() => Math.min(100, Math.round((protectDuration.value / maxDuration.value) * 100)))

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
  if (!pet.owned)
    return '未获得宠物，无法操作'
  return pet.active ? '收回当前宠物' : '将该宠物上场'
}

function dogActionLabel(pet: PetInfo) {
  if (!pet.owned)
    return '未获得'
  return pet.active ? '收回' : '上场'
}

function dogActionType(pet: PetInfo): 'default' | 'success' | 'warning' {
  if (!pet.owned)
    return 'default'
  return pet.active ? 'warning' : 'success'
}

async function handlePetOperation(pet: PetInfo) {
  if (!pet.owned || operatingDogId.value)
    return
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
  <div class="pet-page space-y-4">
    <div class="pet-heading flex items-center justify-between gap-3">
      <div>
        <div class="pet-eyebrow">
          PERSONAL / PET
        </div>
        <h2 class="flex items-center gap-2 text-2xl font-bold font-display">
          <span class="i-carbon-dog-walker" /> 宠物
        </h2>
      </div>
      <div class="flex items-center gap-2">
        <NButton
          size="small" secondary :loading="protectLogsLoading"
          :disabled="!currentAccountId || !isConnected || !snapshot?.guardianRecordsSupported" @click="openProtectLogs"
        >
          <span class="i-carbon-document" /> 守护记录
        </NButton>
        <NButton
          circle quaternary size="small" title="刷新宠物信息" :loading="loading || statusLoading"
          :disabled="!currentAccountId || !isConnected || !tokenRef" @click="refreshPetInfo"
        >
          <span class="i-carbon-renew" />
        </NButton>
      </div>
    </div>

    <div v-if="loading || statusLoading" class="pet-state pet-card flex justify-center py-12">
      <span class="i-carbon-circle-dash animate-spin text-4xl" />
    </div>
    <div v-else-if="!currentAccountId" class="pet-state pet-card">
      请选择账号后查看宠物
    </div>
    <div v-else-if="!isConnected" class="pet-state pet-card">
      <span class="i-carbon-network-4 text-3xl" />
      <span>账号未连接，请先运行账号</span>
    </div>
    <div v-else-if="error && !snapshot" class="pet-state pet-card pet-state--error">
      <strong>获取宠物数据失败</strong>
      <span>{{ error }}</span>
    </div>

    <template v-else-if="snapshot">
      <section class="pet-overview pet-card">
        <div class="pet-overview__copy">
          <div class="pet-eyebrow">
            GUARD STATUS
          </div>
          <h3>{{ activeDog ? `${activeDog.name} 正在看家` : '暂未上场宠物' }}</h3>
          <p v-if="activeDog">
            护主剩余时间 {{ formatDuration(protectDuration) }}
          </p>
          <p v-else>
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

      <section class="pet-section">
        <div class="pet-section__heading">
          <div>
            <div class="pet-eyebrow">
              COLLECTION
            </div>
            <h3>我的宠物</h3>
          </div>
          <span class="pet-count">{{ dogs.filter(dog => dog.owned).length }}/{{ dogs.length }} 已获得</span>
        </div>

        <div class="pet-grid">
          <article
            v-for="pet in dogs" :key="pet.id" class="pet-tile"
            :class="{ 'pet-tile--locked': !pet.owned, 'pet-tile--active': pet.active }"
          >
            <div class="pet-tile__top">
              <div class="pet-avatar" :class="{ 'pet-avatar--locked': !pet.owned }">
                <img :src="pet.image" :alt="pet.name" loading="lazy">
                <span v-if="!pet.owned" class="pet-avatar__lock i-carbon-locked" />
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
                  :class="{ 'pet-tile__status--active': pet.active, 'pet-tile__status--owned': pet.owned && !pet.active }"
                >
                  <span
                    class="status-dot"
                    :class="{ 'status-dot--owned': pet.owned, 'status-dot--active': pet.active }"
                  />
                  {{ pet.active ? '上场中' : (pet.owned ? '已获得' : '未获得') }}
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
                <p>{{ skill.description }}</p>
              </div>
            </div>
            <div class="pet-tile__detail">
              <span class="pet-detail-label">获得条件</span>
              <p>{{ pet.obtainCondition }}</p>
            </div>
            <NButton
              size="small" ghost block :type="dogActionType(pet)" class="pet-action"
              :class="pet.active ? 'pet-action--withdraw' : (pet.owned ? 'pet-action--deploy' : 'pet-action--locked')"
              :loading="operatingDogId === pet.id" :disabled="!pet.owned || !!operatingDogId"
              :title="operationTitle(pet)" @click="handlePetOperation(pet)"
            >
              {{ dogActionLabel(pet) }}
            </NButton>
          </article>
        </div>
      </section>

      <section class="pet-section">
        <div class="pet-section__heading">
          <div>
            <div class="pet-eyebrow">
              FOOD SUPPLY
            </div>
            <h3>狗盆喂食</h3>
          </div>
          <span class="pet-count">最多 30 天</span>
        </div>
        <div class="food-list">
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
              <span class="i-carbon-add-alt" aria-hidden="true" />
              <span>喂食</span>
            </NButton>
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

.pet-eyebrow {
  color: var(--ui-muted, #718477);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1.4;
  text-transform: uppercase;
}

.pet-card,
.pet-section {
  border: 1px solid var(--ui-border, rgba(58, 86, 68, 0.12));
  border-radius: 12px;
  background: rgba(250, 251, 247, 0.72);
  box-shadow: var(--ui-shadow-sm, 0 8px 24px rgba(55, 75, 61, 0.08));
}

.pet-card {
  padding: 18px;
}

.pet-state {
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

.pet-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.8fr);
  gap: 24px;
  align-items: center;
  background: linear-gradient(115deg, rgba(238, 247, 232, 0.92), rgba(250, 251, 247, 0.68)), var(--ui-surface, #f8faf6);
}

.pet-overview__copy h3,
.pet-section h3 {
  margin: 3px 0 0;
  color: var(--ui-ink, #24352a);
  font-size: 18px;
  font-weight: 750;
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
  padding: 18px;
}

.pet-section__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.pet-count {
  color: var(--ui-muted, #718477);
  font-size: 12px;
}

.pet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(235px, 1fr));
  gap: 12px;
}

.pet-tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(78, 112, 85, 0.16);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.58);
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
  background: rgba(232, 244, 226, 0.82);
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
  font-weight: 700;
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
  font-weight: 700;
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

.pet-tile__detail {
  min-height: 43px;
}

.pet-detail-label {
  color: var(--ui-muted, #718477);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.pet-tile__detail p {
  display: -webkit-box;
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--ui-ink, #33483a);
  font-size: 12px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
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
  font-weight: 700;
  line-height: 1.45;
}

.pet-skill p {
  -webkit-line-clamp: 3;
}

.pet-action {
  margin-top: auto;
  font-weight: 700;
}

:deep(.pet-action--deploy .n-button__border) {
  border-color: rgba(57, 145, 83, 0.62);
}

:deep(.pet-action--withdraw .n-button__border) {
  border-color: rgba(204, 126, 31, 0.68);
}

:deep(.pet-action--locked .n-button__border) {
  border-color: rgba(113, 132, 119, 0.3);
}

.food-list {
  display: grid;
  gap: 8px;
}

.food-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid rgba(78, 112, 85, 0.12);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.5);
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
  background: rgba(255, 255, 255, 0.55);
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
  .pet-overview {
    grid-template-columns: 1fr;
    gap: 14px;
  }

  .pet-duration {
    padding: 12px 0 0;
    border-top: 1px solid rgba(78, 112, 85, 0.14);
    border-left: 0;
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
</style>
