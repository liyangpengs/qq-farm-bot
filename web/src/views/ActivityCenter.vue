<script setup lang="ts">
import type { ActivityTab } from '@/components/activity/BottomNav.vue'
import type { ActivityDirectoryItemDto, ActivityGameplayKey, ShopGoodsDto } from '@/stores/activity-center'
import { useNotification } from 'naive-ui/es/notification'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import BottomNav from '@/components/activity/BottomNav.vue'
import { activityHasGameplay, resolveActivityGameplay } from '@/components/activity/gameplays'
import { CharityRedFlowerView } from '@/components/activity/gameplays/charity'
import { QingMeiBrewTab } from '@/components/activity/gameplays/qingmei'
import QixiActivityView from '@/components/activity/gameplays/qixi/QixiActivityView.vue'
import { ConstellationTab, SolarTermsTab, StarSandExchangeDialog, StarSandShopTab, TravelPassTab } from '@/components/activity/gameplays/stellar'
import { WeatherActivityView } from '@/components/activity/gameplays/weather'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'
import { useFriendStore } from '@/stores/friend'

const router = useRouter()
const notification = useNotification()
const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const friendStore = useFriendStore()
const { currentAccountId } = storeToRefs(accountStore)
const { activities, season, shop, solarTerms, constellation, qixi, qingMei, charity, weather, actions, tabBadges, loading, error, actionError, notice, loadedAccountId, serverClockOffset, pendingActions, weatherFriendsLoading, weatherFriendInspectingGid } = storeToRefs(activityStore)
const { friends, loading: friendsLoading } = storeToRefs(friendStore)
const activeTab = ref<ActivityTab>('travel')
const selectedActivity = ref<ActivityGameplayKey | null>(null)
const selectedShopGoods = ref<ShopGoodsDto | null>(null)
const clockNow = ref(Date.now())
let clockTimer: number | undefined

type ActivityStatus = 'active' | 'upcoming' | 'ended'

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const currentData = computed(() => activeTab.value === 'shop' ? shop.value : activeTab.value === 'solar' ? solarTerms.value : activeTab.value === 'constellation' ? constellation.value : season.value)
const serverNow = computed(() => clockNow.value + serverClockOffset.value)
const accountDataLoaded = computed(() => !!currentAccountId.value && loadedAccountId.value === String(currentAccountId.value))
const stellarDetailsAvailable = computed(() => !!(season.value || shop.value || constellation.value || solarTerms.value))
const displayActivities = computed<ActivityDirectoryItemDto[]>(() => {
  const entries: ActivityDirectoryItemDto[] = activities.value.length > 0
    ? [...activities.value]
    : stellarDetailsAvailable.value
      ? [{
        id: season.value?.pass?.activityId || season.value?.id || 'stellar',
        activityIds: [season.value?.pass?.activityId || season.value?.id || 'stellar'],
        name: season.value?.title || '千星游记',
        startTime: season.value?.startTime || null,
        endTime: season.value?.endTime || null,
        gameplayKey: 'stellar',
        gameplayTargets: ['travel', 'constellation', 'shop', 'solar'],
        detailTarget: season.value?.pass ? 'travel' : constellation.value ? 'constellation' : shop.value ? 'shop' : 'solar',
      } satisfies ActivityDirectoryItemDto]
      : []

  const appendDetailEntry = (entry: ActivityDirectoryItemDto) => {
    if (!entries.some(item => item.activityIds.some(id => entry.activityIds.includes(id))))
      entries.push(entry)
  }
  if (qixi.value) {
    appendDetailEntry({
      id: qixi.value.groupId || qixi.value.activityId,
      activityIds: [qixi.value.groupId, qixi.value.bridgeActivityId, qixi.value.giftActivityId].filter(Boolean),
      name: qixi.value.title,
      startTime: qixi.value.startTime,
      endTime: qixi.value.endTime,
      gameplayKey: 'qixi',
      gameplayTargets: ['qixi'],
      detailTarget: 'qixi',
    })
  }
  if (qingMei.value) {
    appendDetailEntry({
      id: qingMei.value.activityId,
      activityIds: [qingMei.value.dailyActivityId, qingMei.value.activityId].filter(Boolean),
      name: qingMei.value.title,
      startTime: qingMei.value.startTime,
      endTime: qingMei.value.endTime,
      gameplayKey: 'qingmei',
      gameplayTargets: ['qingmei'],
      detailTarget: 'qingmei',
    })
  }
  if (charity.value) {
    appendDetailEntry({
      id: charity.value.groupId || charity.value.activityId,
      activityIds: [charity.value.groupId, charity.value.activityId].filter(Boolean),
      name: charity.value.title,
      startTime: charity.value.startTime,
      endTime: charity.value.endTime,
      gameplayKey: 'charity',
      gameplayTargets: ['charity'],
      detailTarget: 'charity',
    })
  }
  if (weather.value) {
    appendDetailEntry({
      id: weather.value.groupId || weather.value.activityId,
      activityIds: [weather.value.groupId, weather.value.catalogActivityId, weather.value.taskActivityId, weather.value.researchActivityId].filter(Boolean),
      name: weather.value.title,
      startTime: weather.value.startTime,
      endTime: weather.value.endTime,
      gameplayKey: 'weather',
      gameplayTargets: ['weather'],
      detailTarget: 'weather',
    })
  }

  const statusRank: Record<ActivityStatus, number> = { active: 0, upcoming: 1, ended: 2 }
  return entries.sort((left, right) => {
    const leftStatus = activityStatus(left)
    const rightStatus = activityStatus(right)
    if (leftStatus !== rightStatus)
      return statusRank[leftStatus] - statusRank[rightStatus]
    if (leftStatus === 'ended')
      return (right.endTime || 0) - (left.endTime || 0)
    return (left.startTime || 0) - (right.startTime || 0)
  })
})
const hasActivities = computed(() => displayActivities.value.length > 0)
const pageTitle = computed(() => currentData.value?.title || season.value?.title || '—')
const theme = computed(() => activeTab.value === 'solar' ? 'day' : 'night')
const endTime = computed(() => {
  if (activeTab.value === 'shop')
    return shop.value?.endTime
  if (selectedActivity.value === 'qixi')
    return qixi.value?.endTime
  if (selectedActivity.value === 'qingmei')
    return qingMei.value?.endTime
  if (selectedActivity.value === 'charity')
    return charity.value?.endTime
  if (selectedActivity.value === 'weather')
    return weather.value?.endTime
  if (activeTab.value === 'constellation')
    return constellation.value?.endTime || season.value?.endTime
  if (activeTab.value === 'solar')
    return season.value?.endTime
  return season.value?.endTime
})
const remaining = computed(() => {
  if (!endTime.value)
    return ''
  const diff = Math.max(0, endTime.value - serverNow.value)
  if (diff === 0)
    return '活动已结束'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff % 86400000 / 3600000)
  const minutes = Math.floor(diff % 3600000 / 60000)
  return days > 0 ? `剩余：${days}天${hours}小时` : `剩余：${hours}小时${minutes}分钟`
})
const balanceVisible = computed(() => activeTab.value === 'travel' || activeTab.value === 'shop')

function accountId() {
  return String(currentAccountId.value || '')
}
function load(force = false) {
  return force ? activityStore.refresh(accountId()) : activityStore.lazyLoad(accountId())
}
function validActivityTime(value: unknown): number | null {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null
}
function activityStatus(activity: ActivityDirectoryItemDto): ActivityStatus {
  const startTime = validActivityTime(activity.startTime)
  const endTime = validActivityTime(activity.endTime)
  if (endTime !== null && serverNow.value >= endTime)
    return 'ended'
  if (startTime !== null && serverNow.value < startTime)
    return 'upcoming'
  return 'active'
}
function activityStatusLabel(activity: ActivityDirectoryItemDto) {
  return { active: '进行中', upcoming: '未开始', ended: '已结束' }[activityStatus(activity)]
}
function activityCanOpen(activity: ActivityDirectoryItemDto) {
  return activityHasGameplay(activity) && activityStatus(activity) === 'active'
}
function formatActivityPeriod(activity: ActivityDirectoryItemDto) {
  const startTime = validActivityTime(activity.startTime)
  const endTime = validActivityTime(activity.endTime)
  const start = startTime === null ? '' : dateFormatter.format(startTime)
  const end = endTime === null ? '' : dateFormatter.format(endTime)
  if (start && end)
    return `${start} - ${end}`
  if (start)
    return `${start} 开始`
  if (end)
    return `${end} 结束`
  return '活动时间待定'
}
async function openActivity(activity: ActivityDirectoryItemDto) {
  if (!activityCanOpen(activity))
    return
  const gameplay = resolveActivityGameplay(activity)
  if (!gameplay)
    return
  if (gameplay.module.key === 'stellar')
    activeTab.value = gameplay.entryTab as ActivityTab
  selectedActivity.value = gameplay.module.key
  const detailsLoaded = await activityStore.loadDetails(accountId(), gameplay.module.key)
  if (gameplay.module.key === 'qixi' && currentAccountId.value) {
    await friendStore.fetchFriends(String(currentAccountId.value))
  }
  else if (gameplay.module.key === 'weather' && currentAccountId.value && detailsLoaded) {
    void activityStore.loadWeatherFriends(String(currentAccountId.value))
  }
}
function goBack() {
  if (selectedActivity.value) {
    selectedActivity.value = null
    return
  }
  router.back()
}
function claimPass() {
  activityStore.claimPass(accountId())
}
function lightConstellation() {
  activityStore.lightConstellation(accountId())
}
function claimSolar(termId: string) {
  activityStore.claimSolarTerm(accountId(), termId)
}
function claimQixiBridge() {
  activityStore.claimQixiBridgeRewards(accountId())
}
function giftQixiSachet(friendGid: string) {
  activityStore.giftQixiSachet(accountId(), friendGid)
}
function claimQingMeiSeed() {
  activityStore.claimQingMeiDailySeed(accountId())
}
function startQingMeiBrew(ingredients: Array<{ uid: string, count: number }>) {
  activityStore.startQingMeiBrew(accountId(), ingredients)
}
function continueQingMeiBrew() {
  activityStore.continueQingMeiBrew(accountId())
}
function settleQingMeiBrew() {
  activityStore.settleQingMeiBrew(accountId())
}
function claimCharitySeeds() {
  activityStore.claimCharityRedFlowerSeeds(accountId())
}
function donateCharityLove() {
  activityStore.donateCharityRedFlowerLove(accountId())
}
function claimCharityDailyGift() {
  activityStore.claimCharityRedFlowerDailyGift(accountId())
}
function lightWeatherResearch(nodeId: string) {
  activityStore.lightWeatherResearch(accountId(), nodeId)
}
function buyWeatherBottle() {
  activityStore.buyWeatherBottle(accountId(), 1)
}
function inspectWeatherFriend(friendGid: string) {
  void activityStore.inspectWeatherFriend(accountId(), friendGid)
}
function collectWeatherBottle(targetGid: string) {
  activityStore.collectWeatherBottle(accountId(), targetGid)
}
function summonWeatherRain() {
  activityStore.summonWeatherRain(accountId())
}
function refreshQixiFriends() {
  if (currentAccountId.value)
    friendStore.fetchFriends(String(currentAccountId.value), true)
}
async function refreshQixiActivity() {
  await activityStore.loadDetails(accountId(), 'qixi')
}
async function refreshSelectedActivity() {
  if (!selectedActivity.value)
    return
  await activityStore.loadDetails(accountId(), selectedActivity.value)
  if (selectedActivity.value === 'weather')
    await activityStore.loadWeatherFriends(accountId())
}
function selectShopGoods(goods: ShopGoodsDto) {
  selectedShopGoods.value = goods
}
function closeExchangeDialog() {
  if (!pendingActions.value.exchange)
    selectedShopGoods.value = null
}
async function exchangeShopGoods(goodsId: string, count: number) {
  const succeeded = await activityStore.exchangeStarSandGoods(accountId(), goodsId, count)
  if (succeeded)
    selectedShopGoods.value = null
}

watch(currentAccountId, () => {
  selectedShopGoods.value = null
  selectedActivity.value = null
  load(true)
}, { flush: 'post' })
watch(activeTab, (tab) => {
  if (tab !== 'shop' && !pendingActions.value.exchange)
    selectedShopGoods.value = null
})
watch([notice, actionError], ([successMessage, failureMessage]) => {
  if (!selectedActivity.value)
    return

  if (failureMessage) {
    notification.error({
      title: '操作失败',
      content: failureMessage,
      duration: 5000,
      keepAliveOnHover: true,
    })
  }
  else if (successMessage) {
    notification.success({
      title: '操作成功',
      content: successMessage,
      duration: 3500,
      keepAliveOnHover: true,
    })
  }
  else {
    return
  }

  activityStore.clearActionMessages()
})
watch(stellarDetailsAvailable, (available) => {
  if (selectedActivity.value === 'stellar' && !available)
    selectedActivity.value = null
})
onMounted(() => {
  load(true)
  clockTimer = window.setInterval(() => clockNow.value = Date.now(), 1000)
})
onUnmounted(() => {
  if (clockTimer)
    window.clearInterval(clockTimer)
})
</script>

<template>
  <section v-if="!selectedActivity" class="activity-picker">
    <button type="button" class="picker-back" aria-label="返回" @click="goBack">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg>
    </button>
    <header class="picker-heading">
      <span>活动中心</span>
      <h1>{{ accountDataLoaded && !loading && !hasActivities ? '当前无活动' : '活动列表' }}</h1>
    </header>
    <div v-if="!currentAccountId" class="picker-state">
      <div class="i-carbon-user-avatar" />
      <strong>请先选择账号</strong>
      <span>选择账号后查看当前活动</span>
    </div>
    <div v-else-if="loading && !accountDataLoaded" class="picker-state">
      <div class="activity-spinner picker-spinner" />
      <strong>正在加载活动</strong>
    </div>
    <div v-else-if="error && !hasActivities" class="picker-state">
      <div class="i-carbon-warning-alt" />
      <strong>活动加载失败</strong>
      <span>{{ error }}</span>
      <button type="button" :disabled="loading" @click="load(true)">
        重新加载
      </button>
    </div>
    <div v-else-if="accountDataLoaded && !loading && !hasActivities" class="picker-state empty-activities">
      <div class="i-carbon-calendar" />
      <strong>当前无活动</strong>
      <span>服务器暂未返回活动配置</span>
      <button type="button" @click="load(true)">
        刷新活动
      </button>
    </div>
    <div v-else class="picker-list">
      <button
        v-for="activity in displayActivities"
        :key="activity.id"
        type="button"
        class="activity-entry"
        :class="[`activity-entry--${activityStatus(activity)}`, { 'activity-entry--supported': activityCanOpen(activity) }]"
        :disabled="!activityCanOpen(activity)"
        @click="openActivity(activity)"
      >
        <span class="activity-entry__topline">
          <span class="activity-entry__icon"><span class="i-carbon-calendar" /></span>
          <span class="activity-entry__status">{{ activityStatusLabel(activity) }}</span>
        </span>
        <strong>{{ activity.name }}</strong>
        <span class="activity-entry__period">{{ formatActivityPeriod(activity) }}</span>
        <span class="activity-entry__footer">
          <small>{{ activity.id }}</small>
          <span v-if="activityCanOpen(activity)">查看详情 <span class="i-carbon-arrow-right" /></span>
          <span v-else-if="activityStatus(activity) === 'ended'">活动已结束 <span class="i-carbon-locked" /></span>
          <span v-else-if="activityStatus(activity) === 'upcoming'">活动未开始 <span class="i-carbon-locked" /></span>
          <span v-else>暂未支持详情 <span class="i-carbon-locked" /></span>
        </span>
      </button>
    </div>
  </section>

  <ActivityShell v-else-if="selectedActivity === 'stellar'" :theme="theme">
    <div class="activity-center">
      <ActivityHeader :title="pageTitle" :remaining="remaining" :balance="balanceVisible ? (shop?.balanceKnown ? (shop.balance ?? '0') : '--') : undefined" :currency-image="shop?.currency.image" :currency-name="shop?.currency.name" :loading="loading" :show-refresh="activeTab !== 'constellation'" @back="goBack" @refresh="refreshSelectedActivity" />
      <div v-if="!currentAccountId" class="activity-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="loading && !season && !shop && !solarTerms && !constellation" class="activity-state">
        <div class="activity-spinner" /><strong>正在加载活动</strong>
      </div>
      <template v-else>
        <div v-if="error" class="activity-message" role="status">
          <span>{{ error }}</span><button type="button" :disabled="loading" @click="refreshSelectedActivity">
            重试
          </button>
        </div>
        <main class="activity-content" :class="{ 'activity-content--travel': activeTab === 'travel' }">
          <TravelPassTab v-if="activeTab === 'travel'" :season="season" :enabled="actions.claimPass.enabled" :pending="pendingActions.claimPass" @claim="claimPass" />
          <ConstellationTab v-else-if="activeTab === 'constellation'" :constellation="constellation" :enabled="actions.lightConstellation.enabled" :pending="pendingActions.lightConstellation" @light="lightConstellation" />
          <StarSandShopTab v-else-if="activeTab === 'shop'" :shop="shop" :enabled="actions.exchange.enabled" :pending="pendingActions.exchange" @select="selectShopGoods" />
          <SolarTermsTab v-else :solar="solarTerms" :now="serverNow" :pending="pendingActions.claimSolar" @claim="claimSolar" />
        </main>
      </template>
      <BottomNav v-model="activeTab" :badges="tabBadges" />
      <StarSandExchangeDialog
        :open="!!selectedShopGoods"
        :goods="selectedShopGoods"
        :shop="shop"
        :pending="pendingActions.exchange"
        @close="closeExchangeDialog"
        @confirm="exchangeShopGoods"
      />
    </div>
  </ActivityShell>

  <ActivityShell v-else-if="selectedActivity === 'qixi'" theme="day">
    <div class="activity-center">
      <ActivityHeader
        :title="qixi?.title || '鹊桥寄情'"
        :remaining="remaining"
        :balance="qixi?.balances.known ? (qixi.balances.feather || '0') : '--'"
        :currency-image="qixi?.feather.image"
        :currency-name="qixi?.feather.name || '鹊羽'"
        :loading="loading"
        show-refresh
        @back="goBack"
        @refresh="refreshQixiActivity"
      />
      <div v-if="!currentAccountId" class="activity-state detail-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="loading && !qixi" class="activity-state detail-state">
        <div class="activity-spinner" /><strong>正在加载鹊桥活动</strong>
      </div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status">
          <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="refreshSelectedActivity">
            重试
          </button>
        </div>
        <main class="activity-content gameplay-content">
          <QixiActivityView
            :activity="qixi"
            :friends="friends"
            :friends-loading="friendsLoading"
            :pending-bridge="pendingActions.claimQixiBridge"
            :pending-gift="pendingActions.giftQixiSachet"
            @claim-bridge="claimQixiBridge"
            @gift="giftQixiSachet"
            @refresh-friends="refreshQixiFriends"
          />
        </main>
      </template>
    </div>
  </ActivityShell>

  <ActivityShell v-else-if="selectedActivity === 'qingmei'" theme="day">
    <div class="activity-center">
      <ActivityHeader
        :title="qingMei?.title || '青酿换万金'"
        :remaining="remaining"
        :balance="qingMei?.balanceKnown ? (qingMei.balance || '0') : '--'"
        :currency-image="qingMei?.ingredient.image"
        :currency-name="qingMei?.ingredient.name || '青梅'"
        :loading="loading"
        show-refresh
        @back="goBack"
        @refresh="refreshSelectedActivity"
      />
      <div v-if="!currentAccountId" class="activity-state detail-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="loading && !qingMei" class="activity-state detail-state">
        <div class="activity-spinner" /><strong>正在加载青梅活动</strong>
      </div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status">
          <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="refreshSelectedActivity">
            重试
          </button>
        </div>
        <main class="activity-content gameplay-content">
          <QingMeiBrewTab
            :activity="qingMei"
            :pending-seed="pendingActions.claimQingMeiSeed"
            :pending-start="pendingActions.startQingMeiBrew"
            :pending-continue="pendingActions.continueQingMeiBrew"
            :pending-sell="pendingActions.settleQingMeiBrew"
            @claim-seed="claimQingMeiSeed"
            @start="startQingMeiBrew"
            @continue="continueQingMeiBrew"
            @settle="settleQingMeiBrew"
          />
        </main>
      </template>
    </div>
  </ActivityShell>

  <ActivityShell v-else-if="selectedActivity === 'charity'" theme="day">
    <div class="activity-center">
      <ActivityHeader
        :title="charity?.title || '公益小红花'"
        :remaining="remaining"
        :balance="charity?.loveBalance || '0'"
        :currency-image="charity?.love.image"
        :currency-name="charity?.love.name || '爱心'"
        :loading="loading"
        show-refresh
        @back="goBack"
        @refresh="refreshSelectedActivity"
      />
      <div v-if="!currentAccountId" class="activity-state detail-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="loading && !charity" class="activity-state detail-state">
        <div class="activity-spinner" /><strong>正在加载公益小红花活动</strong>
      </div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status">
          <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="refreshSelectedActivity">
            重试
          </button>
        </div>
        <main class="activity-content gameplay-content">
          <CharityRedFlowerView
            :activity="charity"
            :pending-seeds="pendingActions.claimCharitySeeds"
            :pending-donate="pendingActions.donateCharityLove"
            :pending-daily-gift="pendingActions.claimCharityDailyGift"
            @claim-seeds="claimCharitySeeds"
            @donate-love="donateCharityLove"
            @claim-daily-gift="claimCharityDailyGift"
          />
        </main>
      </template>
    </div>
  </ActivityShell>

  <ActivityShell v-else-if="selectedActivity === 'weather'" theme="day">
    <div class="activity-center">
      <ActivityHeader
        :title="weather?.title || '雨落成诗'"
        :remaining="remaining"
        :balance="weather?.balances.known ? (weather.balances.badge || '0') : '--'"
        :currency-image="weather?.badge.image"
        :currency-name="weather?.badge.name || '雷电徽章'"
        :loading="loading"
        show-refresh
        @back="goBack"
        @refresh="refreshSelectedActivity"
      />
      <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status">
        <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="refreshSelectedActivity">
          重试
        </button>
      </div>
      <main class="activity-content gameplay-content">
        <WeatherActivityView
          :activity="weather"
          :pending-research="pendingActions.lightWeatherResearch"
          :pending-buy="pendingActions.buyWeatherBottle"
          :pending-collect="pendingActions.collectWeatherBottle"
          :pending-summon="pendingActions.summonWeatherRain"
          :inspecting-gid="weatherFriendInspectingGid"
          :loading-friends="weatherFriendsLoading"
          @light="lightWeatherResearch"
          @buy="buyWeatherBottle"
          @inspect="inspectWeatherFriend"
          @collect="collectWeatherBottle"
          @summon="summonWeatherRain"
        />
      </main>
    </div>
  </ActivityShell>
</template>

<style scoped>
.activity-picker {
  position: relative;
  width: 100%;
  min-height: calc(100dvh - 72px);
  overflow: auto;
  padding: 24px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  color: var(--ui-ink);
  background: rgba(255, 255, 255, 0.58);
  box-shadow: var(--ui-shadow-sm);
}

.picker-back {
  position: absolute;
  top: 22px;
  left: 24px;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  color: var(--ui-primary);
  background: var(--ui-surface);
  line-height: 0;
  cursor: pointer;
}

.picker-back svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.picker-heading {
  width: 100%;
  margin: 54px 0 18px;
}

.picker-heading span {
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: 700;
}

.picker-heading h1 {
  margin: 3px 0 0;
  color: var(--ui-ink);
  font-size: 27px;
  letter-spacing: 0;
}

.picker-list {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.picker-state {
  width: 100%;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 auto;
  padding: 30px;
  color: var(--ui-muted);
  text-align: center;
}

.picker-state > div {
  font-size: 38px;
}

.picker-state strong {
  color: var(--ui-ink);
  font-size: 18px;
}

.picker-state span {
  max-width: 420px;
  color: var(--ui-muted);
  font-size: 12px;
}

.picker-state button {
  min-height: 36px;
  margin-top: 8px;
  padding: 0 15px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  color: var(--ui-primary);
  background: var(--ui-surface);
  font-weight: 700;
  cursor: pointer;
}

.picker-state button:disabled {
  opacity: 0.55;
  cursor: wait;
}

.picker-state .picker-spinner {
  width: 42px;
  height: 42px;
  font-size: 0;
}

.empty-activities > div {
  color: var(--ui-muted);
}

.activity-entry {
  position: relative;
  min-height: 168px;
  display: flex;
  overflow: hidden;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 0;
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-ink);
  text-align: left;
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm);
  cursor: pointer;
  appearance: none;
}

.activity-entry--supported:hover {
  border-color: rgba(67, 141, 99, 0.3);
  box-shadow: var(--ui-shadow-md);
  transform: translateY(-1px);
}

.activity-entry--upcoming {
  border-color: rgba(186, 125, 27, 0.3);
}

.activity-entry--ended {
  border-color: rgba(89, 102, 97, 0.18);
  background: rgba(245, 247, 246, 0.58);
}

.activity-entry:disabled {
  cursor: default;
  opacity: 1;
}

.activity-entry__topline,
.activity-entry__footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.activity-entry__topline {
  margin-bottom: 17px;
}

.activity-entry__icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.activity-entry__icon > span {
  font-size: 16px;
}

.activity-entry__status {
  padding: 3px 8px;
  border: 1px solid rgba(67, 141, 99, 0.18);
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 10px;
  font-weight: 700;
}

.activity-entry--upcoming .activity-entry__icon,
.activity-entry--upcoming .activity-entry__status {
  color: #93651e;
  background: var(--ui-warning-soft);
}

.activity-entry--ended .activity-entry__icon,
.activity-entry--ended .activity-entry__status {
  color: var(--ui-muted);
  background: var(--ui-bg-soft);
}

.activity-entry > strong {
  width: 100%;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 17px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-entry__period {
  margin-top: 5px;
  color: var(--ui-muted);
  font-size: 11px;
}

.activity-entry__footer {
  margin-top: auto;
  padding-top: 15px;
  color: var(--ui-muted);
}

.activity-entry__footer > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 700;
}

.activity-entry--supported .activity-entry__footer > span {
  color: var(--ui-primary);
}

.activity-entry__footer small {
  color: var(--ui-muted);
  font-size: 10px;
}

.activity-entry__footer .i-carbon-arrow-right,
.activity-entry__footer .i-carbon-locked {
  font-size: 13px;
}

.activity-center {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.activity-content {
  position: absolute;
  inset: calc(110px + env(safe-area-inset-top)) 24px 24px 260px;
  overflow-x: hidden;
  overflow-y: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: rgba(255, 255, 255, 0.54);
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(67, 141, 99, 0.35) transparent;
}

.activity-message {
  position: absolute;
  z-index: 25;
  top: calc(102px + env(safe-area-inset-top));
  right: 36px;
  left: 272px;
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid rgba(201, 95, 102, 0.2);
  border-radius: 10px;
  color: #9a4048;
  background: rgba(250, 233, 234, 0.94);
  font-size: 10px;
}

.activity-message.success {
  border-color: rgba(67, 141, 99, 0.2);
  color: #2e714b;
  background: rgba(228, 241, 231, 0.94);
}

.activity-message button {
  flex: none;
  padding: 3px 8px;
  border: 1px solid currentcolor;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.activity-state {
  position: absolute;
  z-index: 5;
  inset: calc(110px + env(safe-area-inset-top)) 24px 24px 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--ui-ink);
  text-align: center;
}

.activity-state strong {
  margin-top: 12px;
  font-size: 16px;
}

.activity-state span {
  margin-top: 4px;
  color: var(--ui-muted);
  font-size: 11px;
}

.activity-spinner {
  width: 43px;
  height: 43px;
  border: 3px solid rgba(67, 141, 99, 0.18);
  border-top-color: var(--ui-primary);
  border-radius: 50%;
  animation: spin 0.85s linear infinite;
}

.gameplay-content {
  inset: calc(86px + env(safe-area-inset-top)) 0 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border: 0;
  border-radius: 0;
  background: transparent;
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
}

.detail-state {
  inset: calc(86px + env(safe-area-inset-top)) 0 0;
  border-radius: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1100px) and (min-width: 621px) {
  .picker-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .activity-picker {
    min-height: auto;
    padding: 18px 12px 24px;
  }

  .picker-back {
    top: 16px;
    left: 14px;
  }

  .picker-heading {
    margin-top: 58px;
  }

  .activity-content,
  .activity-state {
    inset: calc(136px + env(safe-area-inset-top)) 10px 10px;
    border-radius: var(--ui-radius-card);
  }

  .activity-content--travel {
    overflow: hidden;
  }

  .activity-message {
    top: calc(128px + env(safe-area-inset-top));
    right: 18px;
    left: 18px;
  }

  .gameplay-content,
  .detail-state {
    inset: calc(72px + env(safe-area-inset-top)) 0 0;
    border-radius: 0;
  }
}

@media (max-width: 620px) {
  .picker-heading h1 {
    font-size: 25px;
  }

  .picker-list {
    grid-template-columns: 1fr;
  }

  .activity-entry {
    min-height: 164px;
  }
}
</style>
