<script setup lang="ts">
import type { DogFoodInfo, PetInfo } from '@/stores/pet'
import { useStorage } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import EmptyState from '@/components/ui/EmptyState.vue'
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

const isConnected = computed(() => !!status.value?.connection?.connected)
const maxDuration = computed(() => Number(snapshot.value?.maxProtectDuration || 30 * 86400))
const protectDuration = computed(() => Math.max(0, Number(snapshot.value?.protectDuration || 0)))
const durationPercent = computed(() => Math.min(100, Math.round((protectDuration.value / maxDuration.value) * 100)))
const pendingGiftCount = computed(() => Math.max(0, Number(snapshot.value?.pendingGiftCount || 0)))
const ownedCount = computed(() => dogs.value.filter(dog => dog.owned).length)
const durationLow = computed(() => !!activeDog.value && protectDuration.value < 86400)

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

/** 稀有度配色：4+ 金、3 蓝、2 绿，其余灰。 */
function rarityTone(pet: PetInfo) {
  if (pet.rarity >= 4)
    return 'is-gold'
  if (pet.rarity === 3)
    return 'is-blue'
  if (pet.rarity === 2)
    return 'is-green'
  return 'is-plain'
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

function feedTitle(food: DogFoodInfo) {
  if (!activeDog.value)
    return '请先上场宠物'
  if (food.count <= 0)
    return '狗盆中没有该狗粮'
  if (maxUsableCount(food) <= 0)
    return '狗粮时长已接近上限'
  return '从狗盆喂食'
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
    <!-- 工具栏：外层页签已经写着“宠物”，这里只放统计与操作 -->
    <div class="pet-toolbar">
      <span class="pet-toolbar__count">
        <template v-if="snapshot">已获得 <b>{{ ownedCount }}</b> / {{ dogs.length }} 只宠物</template>
      </span>
      <NButton
        class="pet-toolbar__logs" size="small" secondary :loading="protectLogsLoading"
        title="守护记录" aria-label="守护记录"
        :disabled="!currentAccountId || !isConnected || !snapshot?.guardianRecordsSupported" @click="openProtectLogs"
      >
        <template #icon>
          <span class="i-carbon-security" />
        </template>
        <span class="pet-toolbar__label">守护记录</span>
      </NButton>
      <NButton
        circle quaternary size="small" title="刷新宠物信息" aria-label="刷新宠物信息" :loading="loading || statusLoading"
        :disabled="!currentAccountId || !isConnected || !tokenRef" @click="refreshPetInfo"
      >
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </div>

    <EmptyState v-if="loading || statusLoading" title="正在读取宠物信息" icon="i-svg-spinners-90-ring-with-bg" />
    <EmptyState v-else-if="!currentAccountId" title="请先选择账号" description="选择账号后查看宠物与狗粮" icon="i-carbon-dog-walker" />
    <EmptyState v-else-if="!isConnected" title="账号未运行" description="请先启动账号；启动后会读取宠物信息" icon="i-carbon-connection-signal-off" />
    <EmptyState v-else-if="error && !snapshot" title="获取宠物数据失败" :description="error" icon="i-carbon-warning-alt">
      <NButton secondary @click="refreshPetInfo">
        重新加载
      </NButton>
    </EmptyState>

    <template v-else-if="snapshot">
      <!-- 看家状态：谁在看家 + 狗粮与喂食 -->
      <section class="pet-home" :class="{ 'is-idle': !activeDog }" aria-label="看家状态">
        <template v-if="activeDog">
          <div class="pet-home__dog">
            <div class="pet-home__avatar">
              <img :src="activeDog.image" :alt="activeDog.name">
            </div>
            <div class="pet-home__info">
              <p class="pet-home__eyebrow">
                <span class="pet-dot is-active" aria-hidden="true" />看家中
              </p>
              <h3>
                {{ activeDog.name }}<span class="pet-rarity" :class="rarityTone(activeDog)">{{ activeDog.rarityLabel }}</span>
              </h3>
              <ul class="pet-skills">
                <li v-for="skill in activeDog.skills" :key="skill.name">
                  <strong>{{ skill.name }}</strong>
                  <span v-if="skill.remainingCount !== undefined && skill.dailyLimit" class="pet-usage">今日剩余 {{ skill.remainingCount }}/{{ skill.dailyLimit }}</span>
                  <p>{{ skill.description }}</p>
                </li>
              </ul>
            </div>
          </div>

          <div class="pet-bowl">
            <div class="pet-bowl__meter">
              <div class="pet-bowl__label">
                <span>狗粮剩余</span>
                <strong :class="{ 'is-low': durationLow }">{{ formatDuration(protectDuration) }}</strong>
              </div>
              <div
                class="pet-bowl__track" :class="{ 'is-low': durationLow }" role="progressbar" aria-label="狗粮剩余时间"
                aria-valuemin="0" aria-valuemax="100" :aria-valuenow="durationPercent"
              >
                <span :style="{ width: `${durationPercent}%` }" />
              </div>
              <small>上限 {{ formatFoodDuration(maxDuration) }} · 已存 {{ durationPercent }}%</small>
            </div>

            <ul v-if="foods.length" class="pet-foods" aria-label="狗盆里的狗粮">
              <li v-for="food in foods" :key="food.id" class="pet-food">
                <img :src="food.image" :alt="food.name" loading="lazy">
                <div class="pet-food__copy">
                  <strong>{{ food.name }}</strong>
                  <span>每份 +{{ formatFoodDuration(food.duration) }} · 库存 {{ food.count }}</span>
                </div>
                <NInputNumber
                  :value="selectedCount(food)" :min="1" :max="Math.max(1, maxUsableCount(food))" size="small"
                  :disabled="!canUseFood(food)" class="pet-food__count" :aria-label="`${food.name}喂食份数`"
                  @update:value="value => setUseCount(food, value)"
                />
                <NButton size="small" type="primary" :loading="usingFood" :disabled="!canUseFood(food)" :title="feedTitle(food)" @click="handleUseFood(food)">
                  喂食
                </NButton>
              </li>
            </ul>
            <p v-else class="pet-bowl__empty">
              狗盆里暂无狗粮
            </p>
          </div>
        </template>

        <!-- 没有宠物看家：收成一行，狗粮此时不能喂，只展示狗盆库存 -->
        <div v-else class="pet-idle">
          <span class="pet-idle__avatar" aria-hidden="true"><span class="i-carbon-dog-walker" /></span>
          <div class="pet-idle__copy">
            <h3>还没有宠物看家</h3>
            <p>{{ ownedCount ? '在下方「全部宠物」中选一只上场，好友来偷菜时它会帮你看护。' : '还没有可上场的宠物，可在下方查看各宠物的获得条件。' }}</p>
          </div>
          <div class="pet-idle__stock">
            <small>狗盆库存</small>
            <ul v-if="foods.length" aria-label="狗盆库存">
              <li v-for="food in foods" :key="food.id" :class="{ 'is-empty': food.count <= 0 }" :title="`${food.name}，每份 +${formatFoodDuration(food.duration)}`">
                <img :src="food.image" alt="" loading="lazy">{{ food.name }}<b>×{{ food.count }}</b>
              </li>
            </ul>
            <span v-else>暂无狗粮</span>
          </div>
        </div>

        <!-- 同气连枝礼包：有待拾取时出现在看家卡底部 -->
        <div v-if="pendingGiftCount > 0 || giftError" class="pet-gift" :role="giftError ? 'alert' : undefined">
          <span class="pet-gift__icon i-carbon-gift" aria-hidden="true" />
          <p>
            <strong>同气连枝礼包 ×{{ pendingGiftCount }}</strong>
            <span>{{ giftError || '拾取后奖励存入背包' }}</span>
          </p>
          <NButton v-if="pendingGiftCount > 0" size="small" type="warning" :loading="claimingGifts" :disabled="!isConnected" @click="handleClaimGifts">
            全部拾取
          </NButton>
        </div>
      </section>

      <!-- 全部宠物：一行一只，列对齐，行高随内容 -->
      <section class="pet-roster" aria-labelledby="pet-roster-title">
        <h3 id="pet-roster-title" class="pet-roster__title">
          全部宠物<small>{{ dogs.length }}</small>
        </h3>
        <EmptyState v-if="!dogs.length" bare title="暂无宠物" icon="i-carbon-dog-walker" />
        <ul v-else class="pet-list">
          <li
            v-for="pet in dogs" :key="pet.id" class="pet-row"
            :class="{ 'is-active': pet.active, 'is-locked': !pet.owned && !pet.activatable }"
          >
            <div class="pet-row__avatar">
              <img :src="pet.image" :alt="pet.name" loading="lazy">
              <span v-if="!pet.owned && !pet.activatable" class="pet-row__lock i-carbon-locked" aria-hidden="true" />
            </div>
            <div class="pet-row__name">
              <strong>{{ pet.name }}</strong>
              <span class="pet-rarity" :class="rarityTone(pet)">{{ pet.rarityLabel }}</span>
              <span class="pet-row__status" :class="{ 'is-active': pet.active, 'is-owned': pet.owned || pet.activatable }">
                <span class="pet-dot" :class="{ 'is-active': pet.active, 'is-owned': pet.owned || pet.activatable }" aria-hidden="true" />{{ dogStatusLabel(pet) }}
              </span>
            </div>
            <ul class="pet-skills pet-row__skills">
              <li v-for="skill in pet.skills" :key="skill.name">
                <strong>{{ skill.name }}</strong>
                <span v-if="skill.remainingCount !== undefined && skill.dailyLimit" class="pet-usage">今日剩余 {{ skill.remainingCount }}/{{ skill.dailyLimit }}</span>
                <p>{{ skill.description }}</p>
              </li>
            </ul>
            <div class="pet-row__obtain">
              <small>获得条件</small>
              <p>{{ pet.obtainCondition || '—' }}</p>
            </div>
            <NButton
              class="pet-row__action" size="small"
              :type="dogActionType(pet)"
              secondary
              :loading="operatingDogId === pet.id" :disabled="(!pet.owned && !pet.activatable) || !!operatingDogId"
              :title="operationTitle(pet)" @click="handlePetOperation(pet)"
            >
              {{ dogActionLabel(pet) }}
            </NButton>
          </li>
        </ul>
      </section>
    </template>

    <NModal
      v-model:show="showProtectLogs"
      preset="card"
      title="守护记录"
      class="protect-log-modal"
      :bordered="false"
      :style="{ width: 'min(640px, calc(100vw - 32px))', maxHeight: 'min(760px, calc(100vh - 32px))' }"
    >
      <p class="protect-log-summary">
        共 {{ protectLogsTotal }} 条记录
      </p>
      <EmptyState v-if="!protectLogs.length" bare title="暂无守护记录" icon="i-carbon-security" />
      <ul v-else class="protect-log-list custom-scrollbar">
        <li v-for="logItem in protectLogs" :key="logItem.id" class="protect-log-row">
          <img v-if="logItem.friendAvatar" :src="logItem.friendAvatar" :alt="logItem.friendName" class="protect-log-avatar">
          <span v-else class="protect-log-avatar protect-log-avatar--empty"><span class="i-carbon-user" aria-hidden="true" /></span>
          <div class="protect-log-copy">
            <p><strong>{{ logItem.dogName || '宠物' }}</strong> 拦下了 <strong>{{ logItem.friendName }}</strong> 的摘取</p>
            <span>拦截果实 {{ logItem.stolenCount }} · 守护金币 {{ logItem.protectedGold }}</span>
          </div>
          <time>{{ formatProtectTime(logItem.timestamp) }}</time>
        </li>
      </ul>
    </NModal>
  </div>
</template>

<style scoped>
.pet-page {
  container: pet-page / inline-size;
  color: var(--ui-ink);
}

h3,
p {
  margin: 0;
}

/* —— 工具栏 —— */
.pet-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pet-toolbar__count {
  min-width: 0;
  flex: 1;
  color: var(--ui-muted);
  font-size: 13px;
}

.pet-toolbar__count b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

/* —— 通用小件 —— */
.pet-rarity {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
  white-space: nowrap;
}

.pet-rarity.is-gold {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.pet-rarity.is-blue {
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
}

.pet-rarity.is-green {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.pet-rarity.is-plain {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.pet-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 999px;
  background: var(--ui-subtle);
}

.pet-dot.is-owned {
  background: color-mix(in srgb, var(--ui-primary) 60%, transparent);
}

.pet-dot.is-active {
  background: var(--ui-primary);
  box-shadow: 0 0 0 3px var(--ui-primary-soft);
}

.pet-skills {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pet-skills strong {
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-650);
}

.pet-skills p {
  margin-top: 2px;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.6;
}

.pet-usage {
  display: inline-flex;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  vertical-align: 1px;
}

/* —— 看家状态卡 —— */
.pet-home {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 480px);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.pet-home__dog {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 20px;
  padding: 22px 24px;
}

.pet-home__avatar {
  display: grid;
  width: 104px;
  height: 104px;
  flex: none;
  place-items: center;
  border-radius: 28px;
  background: var(--ui-primary-soft);
}

.pet-home__avatar img {
  width: 84%;
  height: 84%;
  object-fit: contain;
}

.pet-home__info {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.pet-home__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.pet-home__info h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: var(--fw-700);
  line-height: 1.3;
}

.pet-home__hint {
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.6;
}

/* 空闲态：一行排开，卡片随内容变矮 */
.pet-home.is-idle {
  grid-template-columns: minmax(0, 1fr);
}

.pet-idle {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px 20px;
  padding: 18px 24px;
}

.pet-idle__avatar {
  display: grid;
  width: 52px;
  height: 52px;
  flex: none;
  place-items: center;
  font-size: 24px;
  border: 1.5px dashed var(--ui-border-strong);
  border-radius: 16px;
  color: var(--ui-subtle);
}

.pet-idle__copy {
  display: flex;
  min-width: 220px;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}

.pet-idle__copy h3 {
  font-size: 16px;
  font-weight: var(--fw-650);
}

.pet-idle__copy p {
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.6;
}

.pet-idle__stock {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  color: var(--ui-muted);
  font-size: 13px;
}

.pet-idle__stock small {
  color: var(--ui-subtle);
  font-size: 12px;
}

.pet-idle__stock ul {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pet-idle__stock li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px 2px 3px;
  border-radius: 999px;
  color: var(--ui-ink);
  background: var(--ui-surface-soft);
  font-size: 12px;
}

.pet-idle__stock li.is-empty {
  color: var(--ui-subtle);
}

.pet-idle__stock img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.pet-idle__stock b {
  margin-left: 2px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.pet-home .pet-skills {
  margin-top: 2px;
}

.pet-bowl {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding: 20px 22px;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-surface-soft);
}

.pet-bowl__meter {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pet-bowl__label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-muted);
  font-size: 12px;
}

.pet-bowl__label strong {
  color: var(--ui-primary);
  font-size: 18px;
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
}

.pet-bowl__label strong.is-low {
  color: var(--ui-warning);
}

.pet-bowl__track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-ink) 8%, transparent);
}

.pet-bowl__track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ui-primary);
  transition: width var(--spring-drag-duration) var(--spring-drag);
}

.pet-bowl__track.is-low span {
  background: var(--ui-warning);
}

.pet-bowl__meter small {
  color: var(--ui-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.pet-foods {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--ui-border);
  list-style: none;
}

.pet-food {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}

.pet-food + .pet-food {
  border-top: 1px dashed var(--ui-border);
}

.pet-food img {
  width: 36px;
  height: 36px;
  flex: none;
  object-fit: contain;
}

.pet-food__copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.pet-food__copy strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: var(--fw-600);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pet-food__copy span {
  color: var(--ui-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.pet-food__count {
  width: 88px;
  flex: none;
}

.pet-bowl__empty {
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-muted);
  font-size: 13px;
}

.pet-gift {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-warning-soft);
}

.pet-gift__icon {
  flex: none;
  color: var(--ui-warning);
  font-size: 20px;
}

.pet-gift p {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
}

.pet-gift strong {
  font-size: 14px;
  font-weight: var(--fw-650);
}

.pet-gift p span {
  color: var(--ui-muted);
  font-size: 12px;
}

/* —— 全部宠物 —— */
.pet-roster {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  container: pet-roster / inline-size;
}

.pet-roster__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  font-weight: var(--fw-650);
}

.pet-roster__title small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
}

.pet-list {
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  list-style: none;
}

/* 窄屏：头像 + 名称 + 按钮一行，技能与获得条件在下方通栏 */
.pet-row {
  display: grid;
  grid-template-areas:
    'avatar name action'
    'skills skills skills'
    'obtain obtain obtain';
  grid-template-columns: 52px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px 14px;
  padding: 16px 18px;
}

.pet-row + .pet-row {
  border-top: 1px solid var(--ui-border);
}

.pet-row.is-active {
  background: var(--ui-primary-soft);
}

.pet-row__avatar {
  position: relative;
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  grid-area: avatar;
  border-radius: 16px;
  background: var(--ui-surface-soft);
}

.pet-row.is-active .pet-row__avatar {
  background: var(--ui-surface-solid);
}

.pet-row__avatar img {
  width: 84%;
  height: 84%;
  object-fit: contain;
}

.pet-row.is-locked .pet-row__avatar img {
  filter: grayscale(1);
  opacity: 0.5;
}

.pet-row__lock {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 18px;
  height: 18px;
  padding: 3px;
  border-radius: 999px;
  color: #fff;
  background: var(--ui-muted);
  box-shadow: 0 0 0 2px var(--ui-surface-solid);
}

.pet-row__name {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  grid-area: name;
}

.pet-row__name strong {
  font-size: 15px;
  font-weight: var(--fw-650);
}

.pet-row__status {
  display: inline-flex;
  flex-basis: 100%;
  align-items: center;
  gap: 6px;
  color: var(--ui-subtle);
  font-size: 12px;
}

.pet-row__status.is-owned {
  color: var(--ui-muted);
}

.pet-row__status.is-active {
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}

.pet-row__skills {
  grid-area: skills;
}

.pet-row__obtain {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  grid-area: obtain;
}

.pet-row__obtain small {
  color: var(--ui-subtle);
  font-size: 11px;
}

.pet-row__obtain p {
  color: var(--ui-ink);
  font-size: 12px;
  line-height: 1.6;
}

.pet-row__action {
  min-width: 72px;
  grid-area: action;
}

.pet-row.is-locked .pet-row__name strong,
.pet-row.is-locked .pet-skills strong {
  color: var(--ui-muted);
}

/* 宽屏：五列对齐的表格式行 */
@container pet-roster (min-width: 900px) {
  .pet-row {
    grid-template-areas: 'avatar name skills obtain action';
    grid-template-columns: 52px minmax(140px, 180px) minmax(0, 1fr) minmax(180px, 260px) 80px;
    gap: 20px;
    padding: 16px 22px;
  }

  .pet-row__skills,
  .pet-row__obtain {
    align-self: center;
  }
}

/* —— 守护记录 —— */
.protect-log-summary {
  color: var(--ui-muted);
  font-size: 12px;
}

.protect-log-list {
  max-height: min(600px, calc(100vh - 180px));
  margin: 10px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.protect-log-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 2px;
}

.protect-log-row + .protect-log-row {
  border-top: 1px solid var(--ui-border);
}

.protect-log-avatar {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 999px;
  object-fit: cover;
}

.protect-log-avatar--empty {
  display: grid;
  place-items: center;
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
}

.protect-log-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.protect-log-copy strong {
  font-weight: var(--fw-650);
}

.protect-log-copy span,
.protect-log-row time {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.protect-log-row time {
  flex: none;
  color: var(--ui-subtle);
}

/* —— 窄屏 —— */
@container pet-page (max-width: 860px) {
  .pet-home {
    grid-template-columns: minmax(0, 1fr);
  }

  .pet-bowl {
    border-top: 1px solid var(--ui-border);
    border-left: 0;
  }
}

@media (max-width: 520px) {
  .pet-toolbar__label {
    display: none;
  }

  .pet-toolbar__logs.n-button :deep(.n-button__icon) {
    margin-right: 0;
  }

  .pet-home__dog {
    align-items: flex-start;
    gap: 14px;
    padding: 16px;
  }

  .pet-home__avatar {
    width: 72px;
    height: 72px;
    border-radius: 20px;
  }

  .pet-home__info h3 {
    font-size: 17px;
  }

  .pet-bowl {
    padding: 16px;
  }

  .pet-gift {
    padding: 12px 16px;
  }

  .pet-row {
    padding: 14px 16px;
  }

  .protect-log-row {
    flex-wrap: wrap;
  }

  .protect-log-copy {
    flex-basis: calc(100% - 52px);
  }

  .protect-log-row time {
    flex-basis: calc(100% - 52px);
    margin-left: 52px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pet-bowl__track span {
    transition: none;
  }
}
</style>
