<script setup lang="ts">
import type { ActivityTab } from '@/components/activity/BottomNav.vue'
import type { ActivityDirectoryItemDto, ActivityGameplayKey } from '@/stores/activity-center'
import { useNotification } from 'naive-ui/es/notification'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { resolveActivityGameplay } from '@/components/activity/gameplays'
import ShareRewardActivity from '@/components/activity/ShareRewardActivity.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'
import { useAppStore } from '@/stores/app'
import { useFriendStore } from '@/stores/friend'
import ActivityDirectoryPage from './activity-center/ActivityDirectoryPage.vue'
import AutumnActivityPage from './activity-center/AutumnActivityPage.vue'
import CharityActivityPage from './activity-center/CharityActivityPage.vue'
import MilkTeaPage from './activity-center/MilkTeaPage.vue'
import PetDiaryPage from './activity-center/PetDiaryPage.vue'
import QingMeiActivityPage from './activity-center/QingMeiActivityPage.vue'
import QixiActivityPage from './activity-center/QixiActivityPage.vue'
import StellarActivityPage from './activity-center/StellarActivityPage.vue'
import WeatherActivityPage from './activity-center/WeatherActivityPage.vue'

const router = useRouter()
const notification = useNotification()
const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const friendStore = useFriendStore()
const { currentAccountId } = storeToRefs(accountStore)
const { season, shop, solarTerms, constellation, notice, actionError } = storeToRefs(activityStore)
const selectedActivity = ref<ActivityGameplayKey | null>(null)
const selectedInstanceId = ref('')
const appStore = useAppStore()
watch(selectedActivity, (value) => {
  appStore.activityDetailOpen = !!value
}, { immediate: true })
const stellarEntryTab = ref<ActivityTab>('travel')
const stellarDetailsAvailable = computed(() => !!(season.value || shop.value || constellation.value || solarTerms.value))

function accountId() {
  return String(currentAccountId.value || '')
}

async function openActivity(activity: ActivityDirectoryItemDto) {
  const gameplay = resolveActivityGameplay(activity)
  if (!gameplay)
    return
  if (gameplay.module.key === 'stellar')
    stellarEntryTab.value = gameplay.entryTab as ActivityTab

  selectedActivity.value = gameplay.module.key
  selectedInstanceId.value = activity.instanceId || activity.activityIds.find(id => ['2026092501', '2026110104'].includes(id)) || ''
  if (['pet', 'wish', 'happy', 'milk'].includes(gameplay.module.key))
    return
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

watch(currentAccountId, () => {
  selectedActivity.value = null
  activityStore.refresh(accountId())
}, { flush: 'post' })

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
  activityStore.refresh(accountId())
})
onUnmounted(() => {
  appStore.activityDetailOpen = false
})
</script>

<template>
  <ActivityDirectoryPage
    v-if="!selectedActivity"
    @back="goBack"
    @open="openActivity"
  />
  <MilkTeaPage v-else-if="selectedActivity === 'milk'" @back="goBack" />
  <ShareRewardActivity v-else-if="selectedActivity === 'happy'" :activity-id="selectedInstanceId" @back="goBack" />
  <AutumnActivityPage
    v-else-if="selectedActivity === 'wish'"
    kind="wish"
    @back="goBack"
  />
  <StellarActivityPage
    v-else-if="selectedActivity === 'stellar'"
    :entry-tab="stellarEntryTab"
    @back="goBack"
  />
  <QixiActivityPage
    v-else-if="selectedActivity === 'qixi'"
    @back="goBack"
  />
  <QingMeiActivityPage
    v-else-if="selectedActivity === 'qingmei'"
    @back="goBack"
  />
  <CharityActivityPage
    v-else-if="selectedActivity === 'charity'"
    @back="goBack"
  />
  <WeatherActivityPage
    v-else-if="selectedActivity === 'weather'"
    @back="goBack"
  />
  <PetDiaryPage v-else-if="selectedActivity === 'pet'" @back="goBack" />
</template>

<style>
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
  font-weight: var(--fw-700);
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
  background: color-mix(in srgb, var(--ui-surface-soft) 70%, transparent);
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
  font-weight: var(--fw-700);
}

.activity-entry--upcoming .activity-entry__icon,
.activity-entry--upcoming .activity-entry__status {
  color: var(--ui-warning);
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
  font-weight: var(--fw-700);
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
