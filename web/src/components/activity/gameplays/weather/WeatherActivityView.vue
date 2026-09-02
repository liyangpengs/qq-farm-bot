<script setup lang="ts">
import type { WeatherActivityDto, WeatherFriendDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import RewardItem from '@/components/activity/RewardItem.vue'

const props = defineProps<{
  activity: WeatherActivityDto | null
  pendingResearch: boolean
  pendingBuy: boolean
  pendingCollect: boolean
  pendingSummon: boolean
  inspectingGid: string
  loadingFriends: boolean
}>()
const emit = defineEmits<{
  light: [nodeId: string]
  buy: []
  inspect: [friendGid: string]
  collect: [targetGid: string]
  summon: []
}>()

const router = useRouter()

const friendSearch = ref('')
const selectedFriendGid = ref('')
const failedAvatars = ref(new Set<string>())
const friendList = computed(() => (props.activity?.friends || []).filter(friend => Number(friend.gid) > 0))

// 好友列表只有基础信息，顺序沿用后端返回的姓名排序，点击后才读取这位好友的现场天气。
const orderedFriends = computed(() => friendList.value)

const filteredFriends = computed(() => {
  const keyword = friendSearch.value.trim().toLowerCase()
  if (!keyword)
    return orderedFriends.value.slice(0, 60)
  return orderedFriends.value.filter((friend) => {
    const name = friend.name.toLowerCase()
    return name.includes(keyword) || String(friend.gid || '').includes(keyword)
  }).slice(0, 60)
})

const selectedFriend = computed(() => friendList.value.find(friend => friend.gid === selectedFriendGid.value) || null)
const catalogGoods = computed(() => props.activity?.catalog?.[0] || null)
const collectionBottleUnavailable = computed(() => !!props.activity?.inventory.known && Number(props.activity.inventory.collectionBottle.count || 0) <= 0)
const rainBottleUnavailable = computed(() => !!props.activity?.inventory.known && Number(props.activity.inventory.rainBottle.count || 0) <= 0)
const inspectingSelected = computed(() => !!selectedFriend.value && props.inspectingGid === selectedFriend.value.gid)
const collectDisabled = computed(() => !selectedFriend.value?.canCollect || props.pendingCollect || collectionBottleUnavailable.value || inspectingSelected.value)
const currentWeather = computed(() => props.activity?.weather || null)
const weatherActive = computed(() => !!currentWeather.value?.active)
const currentWeatherTypeLabel = computed(() => currentWeather.value?.typeName || (currentWeather.value?.id === '1' ? '雷雨' : `未知天气（类型 ${currentWeather.value?.id || '--'}）`))
const currentWeatherStatusLabel = computed(() => currentWeather.value?.statusName || (currentWeather.value?.type === '2' ? '生效中' : `未知状态（${currentWeather.value?.type || '--'}）`))
const summonDisabled = computed(() => props.pendingSummon || weatherActive.value || rainBottleUnavailable.value)
const selectedFriendState = computed(() => {
  if (!selectedFriend.value)
    return null
  if (inspectingSelected.value)
    return { label: '读取中…', className: 'unknown', detail: '正在进入好友农场读取现场天气' }
  return friendState(selectedFriend.value)
})
const collectButtonLabel = computed(() => {
  if (props.pendingCollect)
    return '采集中…'
  if (collectionBottleUnavailable.value)
    return '天气采集瓶不足'
  if (!selectedFriend.value)
    return '请选择好友'
  if (inspectingSelected.value)
    return '正在读取现场天气…'
  if (selectedFriend.value.scanError)
    return '现场天气读取失败'
  if (!selectedFriend.value.inspected)
    return '点击好友读取现场天气'
  if (!selectedFriend.value.canCollect)
    return '当前好友不可采雨'
  return '采集这场雷雨'
})

const weatherTaskNames: Record<string, string> = {
  5001: '使用天气采集瓶',
  5002: '使用雷雨召唤瓶',
  5003: '收获闪电变异作物',
  5004: '使用雷雨引雷瓶',
  5005: '使用青蛙使坏瓶',
  5006: '使用乌云使坏瓶',
}

function taskName(task: { id: string, itemId: string, name: string }) {
  return task.name || weatherTaskNames[task.itemId] || `活动任务 ${task.id}`
}

function isInventoryTask(itemId: string) {
  return itemId === '5001' || itemId === '5002'
}

function inventoryTaskCount(itemId: string) {
  const inventory = props.activity?.inventory
  if (!inventory?.known)
    return '--'
  return itemId === '5001'
    ? inventory.collectionBottle.count || '0'
    : inventory.rainBottle.count || '0'
}

function taskCurrent(task: { id: string, itemId: string, current: string, active: boolean }) {
  const progress = props.activity?.progress
  if (!progress)
    return Number(task.current) || 0
  const isCurrent = task.active
    || task.id === progress.taskId
    || (!!progress.item.id && progress.item.id === task.itemId)
  return isCurrent ? (Number(progress.current) || 0) : (Number(task.current) || 0)
}

function taskTarget(task: { target: string }) {
  const target = Number(task.target)
  return Number.isFinite(target) && target > 0 ? target : 0
}

function taskPercent(task: { id: string, itemId: string, current: string, active: boolean, target: string }) {
  const target = taskTarget(task)
  return target > 0 ? Math.min(100, Math.max(0, taskCurrent(task) / target * 100)) : 0
}

function taskCompleted(task: { id: string, itemId: string, current: string, active: boolean, target: string }) {
  const target = taskTarget(task)
  return target > 0 && taskCurrent(task) >= target
}

function taskStatus(task: { id: string, itemId: string, current: string, active: boolean, target: string }) {
  if (taskCompleted(task))
    return '已完成'
  return taskCurrent(task) > 0 ? '进行中' : '未开始'
}

function formatWeatherTime(value: number | null) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime()))
    return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function friendState(friend: WeatherFriendDto) {
  if (friend.scanError)
    return { label: '检查失败', className: 'error', detail: friend.scanError }
  if (friend.availability === 'available') {
    const endTime = formatWeatherTime(friend.weather.endTime)
    return { label: '可采雨', className: 'available', detail: endTime ? `雷雨持续至 ${endTime}` : '当前雷雨可采集' }
  }
  if (friend.availability === 'collected')
    return { label: '本轮已采', className: 'collected', detail: '下轮雷雨可再次采集' }
  if (friend.availability === 'expired')
    return { label: '已失效', className: 'expired', detail: '这场雷雨已经结束' }
  if (friend.availability === 'unavailable')
    return { label: '晴天', className: 'clear', detail: '当前不是雷雨天气' }
  return { label: '待读取', className: 'unknown', detail: '点击好友读取现场天气' }
}

function friendName(friend: WeatherFriendDto) {
  return friend.name || `好友 ${friend.gid}`
}

function friendAvatar(friend: WeatherFriendDto) {
  return friend.avatarUrl
}

// 点击好友就读取这位好友的现场天气；后端命中 10 分钟缓存时不会真的进农场。
function chooseFriend(friend: WeatherFriendDto) {
  selectedFriendGid.value = friend.gid
  if (!props.inspectingGid)
    emit('inspect', friend.gid)
}

function markAvatarFailed(friend: WeatherFriendDto) {
  failedAvatars.value = new Set(failedAvatars.value).add(friend.gid)
}

function submitCollect() {
  if (!collectDisabled.value)
    emit('collect', selectedFriendGid.value)
}

function openInteractionItem(path: string, itemId: string) {
  void router.push({ path, query: { interactionItem: itemId } })
}

// 好友列表重载后，选中的好友已经不在列表里就清空选择。
watch(friendList, (friends) => {
  if (!selectedFriendGid.value)
    return
  if (!friends.some(friend => friend.gid === selectedFriendGid.value))
    selectedFriendGid.value = ''
})
</script>

<template>
  <div class="weather-page">
    <section v-if="activity" class="weather-status" :class="{ active: weatherActive }">
      <span class="weather-status__icon" :class="weatherActive ? 'i-carbon-thunderstorm' : 'i-carbon-sun'" />
      <div class="weather-status__content">
        <small>当前农场天气</small>
        <strong>{{ weatherActive ? `${currentWeatherTypeLabel} · ${currentWeatherStatusLabel}` : (currentWeather ? '当前无特殊天气' : '天气状态暂未读取') }}</strong>
        <span v-if="weatherActive && currentWeather">
          天气类型 {{ currentWeather.id || '--' }} · 状态码 {{ currentWeather.type || '--' }}
        </span>
      </div>
      <div v-if="weatherActive && currentWeather" class="weather-status__period">
        <small>持续时间</small>
        <strong v-if="currentWeather.endTime">至 {{ formatWeatherTime(currentWeather.endTime) }}</strong>
        <strong v-else>进行中</strong>
        <span v-if="currentWeather.beginTime">开始于 {{ formatWeatherTime(currentWeather.beginTime) }}</span>
      </div>
      <span class="weather-status__badge">{{ weatherActive ? currentWeatherStatusLabel : '空闲' }}</span>
    </section>

    <section v-if="activity" class="panel collect-panel">
      <header>
        <h2>好友天气采集与活动任务</h2>
        <span>{{ activity.balances.known ? `雷电徽章 ${activity.balances.badge || '0'}` : '徽章数量未知' }}</span>
      </header>
      <div class="collect-workspace">
        <div class="friend-picker">
          <div class="friend-toolbar">
            <label class="search-field">
              <span class="i-carbon-search" />
              <input v-model="friendSearch" type="search" placeholder="搜索好友名称或 GID">
            </label>
          </div>
          <div v-if="filteredFriends.length === 0" class="operation-empty">
            {{ friendSearch ? '没有匹配的好友' : (loadingFriends ? '正在加载好友列表…' : '暂无好友，稍后再试') }}
          </div>
          <div v-else class="friend-list">
            <button
              v-for="friend in filteredFriends"
              :key="String(friend.gid)"
              type="button"
              class="friend-option"
              :class="{ selected: selectedFriendGid === friend.gid }"
              :aria-pressed="selectedFriendGid === friend.gid"
              @click="chooseFriend(friend)"
            >
              <img v-if="friendAvatar(friend) && !failedAvatars.has(friend.gid)" :src="friendAvatar(friend)" alt="" @error="markAvatarFailed(friend)">
              <span v-else class="friend-avatar-fallback i-carbon-user-avatar" />
              <span class="friend-option__name">
                <strong>{{ friendName(friend) }}</strong>
                <small>Lv.{{ friend.level || '--' }} · GID {{ friend.gid }}</small>
              </span>
              <span v-if="inspectingGid === friend.gid" class="friend-option__loading i-carbon-circle-dash animate-spin" />
            </button>
          </div>
        </div>
        <div class="collect-composer">
          <div class="inventory-item">
            <img v-if="activity.inventory.collectionBottle.image" :src="activity.inventory.collectionBottle.image" alt="">
            <span>{{ activity.inventory.collectionBottle.name || '天气采集瓶' }}</span>
            <strong>{{ activity.inventory.known ? activity.inventory.collectionBottle.count : '--' }}</strong>
          </div>
          <div v-if="selectedFriend && selectedFriendState" class="selected-friend">
            <div class="selected-friend__heading">
              <span>采集对象</span>
              <em :class="selectedFriendState.className"><i />{{ selectedFriendState.label }}</em>
            </div>
            <div class="selected-friend__identity">
              <img
                v-if="friendAvatar(selectedFriend) && !failedAvatars.has(selectedFriend.gid)"
                :src="friendAvatar(selectedFriend)"
                alt=""
                @error="markAvatarFailed(selectedFriend)"
              >
              <span v-else class="friend-avatar-fallback i-carbon-user-avatar" />
              <span class="selected-friend__name">
                <strong :title="friendName(selectedFriend)">{{ friendName(selectedFriend) }}</strong>
                <small>Lv.{{ selectedFriend.level || '--' }} · GID {{ selectedFriend.gid }}</small>
              </span>
            </div>
            <small>{{ selectedFriendState.detail }}</small>
          </div>
          <div v-else class="selected-friend selected-friend--empty">
            <span class="i-carbon-user-follow" /><strong>选择一位好友</strong>
          </div>
          <button type="button" class="operation-button" :disabled="collectDisabled" @click="submitCollect">
            <span v-if="pendingCollect || inspectingSelected" class="i-carbon-circle-dash animate-spin" />
            <span v-else class="i-carbon-rain-drop" />
            {{ collectButtonLabel }}
          </button>
        </div>
      </div>
      <div class="task-progress">
        <div class="task-progress__title">
          <strong>活动任务</strong>
          <span>完成天气相关目标可获得右侧奖励</span>
        </div>
        <div v-for="task in activity.tasks" :key="task.id" class="task-row">
          <div class="task-row__main" :class="{ 'task-row__main--inventory': isInventoryTask(task.itemId) }">
            <div class="task-row__heading">
              <strong>{{ taskName(task) }}</strong>
              <span v-if="isInventoryTask(task.itemId)" class="task-stock">持有 {{ inventoryTaskCount(task.itemId) }}</span>
              <span v-else :class="{ completed: taskCompleted(task) }">{{ taskStatus(task) }} · {{ taskCurrent(task) }} / {{ taskTarget(task) }}</span>
            </div>
            <div v-if="!isInventoryTask(task.itemId)" class="task-meter">
              <i :class="{ completed: taskCompleted(task) }" :style="{ width: `${taskPercent(task)}%` }" />
            </div>
          </div>
          <RewardItem v-if="task.reward.id !== '0'" :name="task.reward.name || task.reward.id" :count="task.reward.count" :image="task.reward.image" :rarity="task.reward.rarity" compact />
        </div>
        <div v-if="!activity.tasks.length" class="task-empty">
          暂无活动任务数据
        </div>
      </div>
    </section>

    <section v-if="activity" class="panel item-panel">
      <header>
        <h2>天气活动道具</h2>
        <span>主动道具按目标使用，闪电感应为被动加成</span>
      </header>
      <div class="weather-items">
        <button type="button" class="weather-item" @click="openInteractionItem('/personal', '5003')">
          <img :src="activity.inventory.lightningMutationBottle.image" alt="">
          <span><strong>闪电变异瓶</strong><small>我的未成熟 1×1 作物 · 库存 {{ activity.inventory.known ? activity.inventory.lightningMutationBottle.count : '--' }}</small></span>
          <em>去我的农场</em>
        </button>
        <button type="button" class="weather-item" @click="openInteractionItem('/friends', '5004')">
          <img :src="activity.inventory.lightningAttractBottle.image" alt="">
          <span><strong>霹雳引雷瓶</strong><small>好友作物变雷击木，售价 ×1.5 · 库存 {{ activity.inventory.known ? activity.inventory.lightningAttractBottle.count : '--' }}</small></span>
          <em>去好友</em>
        </button>
        <button type="button" class="weather-item" @click="openInteractionItem('/friends', '5005')">
          <img :src="activity.inventory.frogBottle.image" alt="">
          <span><strong>青蛙使坏瓶</strong><small>好友农场整体放青蛙，获得 30 经验 · 库存 {{ activity.inventory.known ? activity.inventory.frogBottle.count : '--' }}</small></span>
          <em>去好友</em>
        </button>
        <button type="button" class="weather-item" @click="openInteractionItem('/friends', '5006')">
          <img :src="activity.inventory.darkCloudBottle.image" alt="">
          <span><strong>乌云使坏瓶</strong><small>好友作物放乌云，获得 30 经验 · 库存 {{ activity.inventory.known ? activity.inventory.darkCloudBottle.count : '--' }}</small></span>
          <em>去好友</em>
        </button>
        <div class="weather-item weather-item--passive">
          <img :src="activity.inventory.lightningSense.image" alt="">
          <span><strong>闪电感应</strong><small>无需主动使用，每份提升 {{ activity.inventory.lightningSense.effectPerItemPercent || 2 }}% 闪电变异概率</small></span>
          <em>{{ activity.inventory.lightningSense.active ? `当前 +${activity.inventory.lightningSense.effectPercent || 0}%` : '未获得' }}</em>
        </div>
      </div>
    </section>

    <section v-if="activity" class="weather-grid operation-grid">
      <article class="panel operation-panel">
        <header><h2>天气瓶补给</h2><span v-if="catalogGoods">{{ catalogGoods.name || '天气瓶' }}</span></header>
        <div v-if="catalogGoods" class="operation-item">
          <img v-if="catalogGoods.item.image" :src="catalogGoods.item.image" alt="">
          <div>
            <strong>{{ catalogGoods.item.name || '天气瓶' }} ×{{ catalogGoods.item.count || '1' }}</strong>
            <span>消耗 {{ catalogGoods.cost.name || catalogGoods.cost.id }} ×{{ catalogGoods.cost.count || '0' }}</span>
          </div>
        </div>
        <p v-else class="operation-empty">
          暂未读取到补给目录
        </p>
        <button type="button" class="operation-button" :disabled="pendingBuy || !catalogGoods" @click="emit('buy')">
          <span v-if="pendingBuy" class="i-carbon-circle-dash animate-spin" />
          <span v-else class="i-carbon-shopping-cart" />
          {{ pendingBuy ? '购买中…' : '购买天气瓶' }}
        </button>
      </article>

      <article class="panel operation-panel">
        <header><h2>召唤降雨</h2><span>{{ weatherActive ? '已有特殊天气' : '使用降雨瓶' }}</span></header>
        <div class="inventory-item">
          <img v-if="activity.inventory.rainBottle.image" :src="activity.inventory.rainBottle.image" alt="">
          <span>{{ activity.inventory.rainBottle.name || '雷雨召唤瓶' }}</span>
          <strong>{{ activity.inventory.known ? activity.inventory.rainBottle.count : '--' }}</strong>
        </div>
        <p class="operation-description">
          {{ weatherActive ? '当前特殊天气结束后，才能再次召唤降雨。' : '使用好友采集获得的降雨瓶，为当前农场召唤一场天气。' }}
        </p>
        <button type="button" class="operation-button" :disabled="summonDisabled" @click="emit('summon')">
          <span v-if="pendingSummon" class="i-carbon-circle-dash animate-spin" />
          <span v-else-if="weatherActive" class="i-carbon-time" />
          <span v-else class="i-carbon-rain-drop" />
          {{ pendingSummon ? '召唤中…' : (weatherActive ? '特殊天气进行中' : (rainBottleUnavailable ? '雷雨召唤瓶不足' : '召唤降雨')) }}
        </button>
      </article>
    </section>
    <section v-if="activity" class="panel research-panel">
      <header><h2>气象研究</h2><span>按路径依次解锁</span></header>
      <div class="research-grid">
        <article v-for="node in activity.research" :key="node.id" class="research-node" :class="{ done: node.claimed, active: node.claimable }">
          <RewardItem
            :name="node.reward.name || node.reward.id"
            :count="node.reward.count"
            :image="node.reward.image"
            :rarity="node.reward.rarity"
            :locked="!node.claimable && !node.claimed"
            :claimed="node.claimed"
            compact
          />
          <div class="research-node__content">
            <small>研究节点 {{ node.id }}</small>
            <strong>{{ node.reward.name || node.reward.id }}</strong>
            <span class="research-node__cost">
              <img v-if="node.cost.image" :src="node.cost.image" alt="">
              消耗 {{ node.cost.count }} {{ node.cost.name || '雷电徽章' }}
            </span>
          </div>
          <div class="research-node__action">
            <button v-if="node.claimable" type="button" :disabled="pendingResearch" @click="emit('light', node.id)">
              {{ pendingResearch ? '研究中…' : '推进' }}
            </button>
            <em v-else>{{ node.claimed ? '已完成' : '未解锁' }}</em>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.weather-page {
  min-height: 100%;
  padding: 28px;
  color: #203a32;
  background: linear-gradient(
    145deg,
    rgba(225, 241, 235, 0.96),
    rgba(246, 248, 247, 0.98) 48%,
    rgba(235, 239, 247, 0.96)
  );
}
.weather-grid {
  display: grid;
  grid-template-columns: 1.4fr 0.6fr;
  gap: 16px;
}
.item-panel {
  margin-top: 16px;
}
.weather-items {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 84px;
  gap: 10px;
  align-items: stretch;
}
.weather-item {
  width: 100%;
  height: 84px;
  display: grid;
  min-width: 0;
  grid-template-columns: 48px minmax(0, 1fr) minmax(68px, auto);
  align-items: center;
  gap: 10px;
  padding: 8px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid rgba(49, 82, 70, 0.14);
  border-radius: 12px;
  color: #203a32;
  background: rgba(255, 255, 255, 0.78);
  text-align: left;
  cursor: pointer;
}
.weather-item--passive {
  cursor: default;
  background: rgba(238, 235, 255, 0.78);
}
.weather-item img {
  width: 42px;
  height: 42px;
  object-fit: contain;
}
.weather-item span {
  display: flex;
  min-width: 0;
  min-height: 54px;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  overflow: hidden;
}
.weather-item strong {
  min-height: 1.35em;
  display: -webkit-box;
  overflow: hidden;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.weather-item small {
  min-height: 2.7em;
  display: -webkit-box;
  overflow: hidden;
  color: #5e7068;
  font-size: 12px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.weather-item em {
  min-width: 68px;
  color: #357b62;
  font-size: 12px;
  font-style: normal;
  line-height: 1.35;
  text-align: right;
  white-space: nowrap;
}
.weather-status {
  display: grid;
  min-height: 84px;
  grid-template-columns: 46px minmax(0, 1fr) minmax(150px, auto) auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 16px;
  padding: 15px 18px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 10px 26px rgba(38, 68, 57, 0.07);
}
.weather-status.active {
  border-color: rgba(181, 135, 42, 0.24);
  background: rgba(255, 249, 228, 0.82);
}
.weather-status__icon {
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  border-radius: 50%;
  color: #2f7d5f;
  background: rgba(226, 244, 237, 0.9);
  font-size: 25px;
}
.weather-status.active .weather-status__icon {
  color: #956816;
  background: rgba(247, 229, 176, 0.72);
}
.weather-status__content,
.weather-status__period {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.weather-status small,
.weather-status__content span,
.weather-status__period span {
  color: #71817a;
  font-size: 11px;
}
.weather-status__content strong,
.weather-status__period strong {
  overflow-wrap: anywhere;
}
.weather-status__badge {
  padding: 5px 9px;
  border-radius: 6px;
  color: #2f7459;
  background: rgba(221, 241, 233, 0.9);
  font-size: 11px;
  font-weight: 700;
}
.weather-status.active .weather-status__badge {
  color: #79530e;
  background: rgba(245, 222, 157, 0.72);
}
.panel {
  margin-bottom: 16px;
  padding: 20px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 10px 26px rgba(38, 68, 57, 0.07);
}
.panel header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.panel header > span {
  max-width: 68%;
  color: #6c7d76;
  font-size: 12px;
  line-height: 1.5;
  text-align: right;
  overflow-wrap: anywhere;
}
.panel h2 {
  flex: none;
  margin: 0;
  font-size: 19px;
}
.meter {
  height: 10px;
  overflow: hidden;
  border-radius: 5px;
  background: rgba(67, 113, 95, 0.12);
}
.meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #3b9a73;
}
.task-progress {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(48, 79, 68, 0.1);
}
.task-progress__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.task-progress__title strong {
  color: #273d36;
  font-size: 15px;
}
.task-progress__title span {
  color: #6c7d76;
  font-size: 12px;
}
.task-row {
  display: flex;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  padding: 8px 0;
  border-top: 1px solid rgba(48, 79, 68, 0.1);
}
.task-row__main {
  width: 100%;
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.task-row__heading {
  width: 100%;
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.task-row__heading strong {
  min-width: 0;
  overflow: hidden;
  color: #273d36;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-row__heading span {
  flex: none;
  color: #6c7d76;
  font-size: 12px;
  white-space: nowrap;
}
.task-row__heading span.completed {
  color: #2e8a66;
  font-weight: 700;
}
.task-stock {
  display: block;
  margin-left: auto;
  color: #236e52 !important;
  font-weight: 700;
  text-align: right !important;
}
.task-meter {
  height: 7px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(67, 113, 95, 0.12);
}
.task-meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #3b9a73;
  transition: width 0.2s ease;
}
.task-meter i.completed {
  background: #d39a32;
}
.task-row > .reward-item {
  flex: 0 0 auto;
}
.task-empty {
  padding: 16px 0 6px;
  color: #6c7d76;
  font-size: 12px;
  text-align: center;
}
.operation-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.operation-panel {
  display: flex;
  min-height: 205px;
  flex-direction: column;
}
.operation-item {
  display: flex;
  align-items: center;
  gap: 12px;
}
.inventory-item {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
  padding: 7px 9px;
  border: 1px solid rgba(49, 82, 70, 0.1);
  border-radius: 8px;
  background: rgba(245, 250, 247, 0.78);
}
.inventory-item img {
  width: 40px;
  height: 40px;
  object-fit: contain;
}
.inventory-item span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: #536b61;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.inventory-item strong {
  color: #236e52;
  font-size: 18px;
}
.operation-item img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}
.operation-item div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.operation-item span,
.operation-description,
.operation-empty {
  color: #6c7d76;
  font-size: 13px;
}
.operation-description {
  margin: 0;
  line-height: 1.7;
}
.operation-empty {
  padding: 18px 0;
  text-align: center;
}
.operation-button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: auto;
  padding: 9px 14px;
  border: 0;
  border-radius: 7px;
  color: white;
  background: #2e8a66;
  box-shadow: 0 8px 18px rgba(35, 113, 83, 0.18);
  cursor: pointer;
}
.operation-button:disabled,
.research-node button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.collect-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(210px, 0.4fr);
  gap: 18px;
}
.friend-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.search-field {
  display: flex;
  height: 38px;
  align-items: center;
  gap: 8px;
  padding: 0 11px;
  border: 1px solid rgba(49, 82, 70, 0.16);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.82);
}
.search-field input {
  width: 100%;
  border: 0;
  outline: none;
  color: inherit;
  background: transparent;
}
.selected-friend__heading em {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.selected-friend__heading em i {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #9aa7a2;
}
.selected-friend__heading em.available i {
  background: #2e8a66;
}
.selected-friend__heading em.collected i {
  background: #c08a2f;
}
.selected-friend__heading em.clear i {
  background: #7d9aab;
}
.selected-friend__heading em.expired i {
  background: #8b9691;
}
.selected-friend__heading em.error i {
  background: #bd6268;
}
.friend-list {
  display: grid;
  max-height: 286px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  overflow: auto;
  margin-top: 10px;
}
.friend-option {
  display: grid;
  min-width: 0;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  padding: 9px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 7px;
  text-align: left;
  color: inherit;
  background: rgba(255, 255, 255, 0.72);
  cursor: pointer;
}
.friend-option.selected {
  border-color: rgba(38, 124, 91, 0.28);
  background: rgba(226, 244, 237, 0.86);
}
.friend-option img,
.friend-avatar-fallback {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}
.friend-avatar-fallback {
  display: grid;
  place-items: center;
  color: #4b8b72;
  background: rgba(226, 241, 235, 0.9);
}
.friend-option__name {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.friend-option__name strong,
.friend-option__name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.friend-option__name small {
  color: #71817a;
  font-size: 11px;
}
.friend-option__loading {
  color: #4b8b72;
  font-size: 14px;
}
.collect-composer {
  display: flex;
  flex-direction: column;
  padding-left: 18px;
  border-left: 1px solid rgba(49, 82, 70, 0.12);
}
.selected-friend {
  display: flex;
  min-height: 96px;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
}
.selected-friend span,
.selected-friend small {
  color: #71817a;
  font-size: 12px;
}
.selected-friend__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.selected-friend__heading em {
  color: #64766e;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
}
.selected-friend > small {
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.selected-friend__identity {
  display: grid;
  min-width: 0;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
.selected-friend__identity img,
.selected-friend__identity .friend-avatar-fallback {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}
.selected-friend__name {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.selected-friend__name strong,
.selected-friend__name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-friend--empty {
  align-items: center;
}
.selected-friend--empty > span {
  font-size: 28px;
}
.research-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(235px, 1fr));
  gap: 9px;
}
.research-node {
  display: grid;
  min-height: 92px;
  grid-template-columns: 54px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 9px 10px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 6px 16px rgba(38, 68, 57, 0.05);
}
.research-node.active {
  border-color: rgba(38, 124, 91, 0.26);
  background: rgba(226, 244, 237, 0.86);
}
.research-node.done {
  opacity: 0.68;
}
.research-node__content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.research-node small,
.research-node span,
.research-node em {
  color: #71817a;
  font-size: 11px;
  font-style: normal;
}
.research-node strong {
  overflow: hidden;
  color: #273d36;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.research-node__cost {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.research-node__cost img {
  width: 17px;
  height: 17px;
  object-fit: contain;
}
.research-node__action {
  display: flex;
  min-width: 42px;
  justify-content: flex-end;
}
.research-node button {
  padding: 7px 9px;
  border: 0;
  border-radius: 6px;
  color: white;
  background: #2e8a66;
  cursor: pointer;
}
.research-node em {
  white-space: nowrap;
}
.rules-panel p {
  color: #647870;
  font-size: 13px;
  line-height: 1.7;
}
.rules-panel p + p {
  margin-top: 8px;
}
@media (max-width: 800px) {
  .weather-page {
    padding: 14px;
  }
  .weather-grid,
  .operation-grid,
  .collect-workspace,
  .weather-items {
    grid-template-columns: 1fr;
  }
  .research-grid,
  .friend-list {
    grid-template-columns: 1fr;
  }
  .friend-toolbar {
    grid-template-columns: 1fr;
  }
  .scan-button {
    width: 100%;
  }
  .weather-status {
    min-height: 0;
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 10px 12px;
    align-items: start;
    padding: 14px;
  }
  .weather-status__icon {
    width: 42px;
    height: 42px;
  }
  .weather-status__content {
    padding-top: 1px;
  }
  .weather-status__content strong {
    line-height: 1.35;
  }
  .weather-status__content span {
    margin-top: 3px;
    line-height: 1.45;
  }
  .weather-status__period {
    grid-column: 1 / -1;
    padding: 9px 10px;
    border-radius: 8px;
    background: rgba(245, 248, 247, 0.78);
  }
  .weather-status__badge {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .panel {
    padding: 16px;
  }
  .panel header {
    flex-direction: column;
    gap: 4px;
  }
  .panel header > span {
    width: 100%;
    max-width: none;
    text-align: left;
  }
  .weather-item {
    height: 78px;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    grid-template-rows: 1fr;
    gap: 8px;
    padding: 7px;
  }
  .weather-item img {
    width: 36px;
    height: 36px;
    grid-row: 1;
  }
  .weather-item span {
    min-height: 0;
    gap: 2px;
  }
  .weather-item strong,
  .weather-item small {
    min-height: 0;
    -webkit-line-clamp: 1;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .weather-item em {
    width: 52px;
    min-width: 0;
    max-width: 52px;
    box-sizing: border-box;
    justify-self: end;
    padding: 3px 5px;
    border-radius: 999px;
    background: rgba(226, 244, 237, 0.86);
    overflow: hidden;
    text-align: center;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .weather-items {
    grid-auto-rows: 78px;
  }
  .weather-item--passive em {
    background: rgba(226, 220, 250, 0.72);
  }
  .task-row {
    min-height: 58px;
    gap: 8px;
  }
  .task-progress__title {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
  .task-row__main {
    gap: 5px;
  }
  .task-row__heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 1px;
  }
  .task-row__heading strong,
  .task-row__heading span {
    max-width: 100%;
  }
  .task-row__main--inventory .task-row__heading {
    flex-direction: row;
    align-items: center;
  }
  .task-row__main--inventory .task-row__heading strong {
    flex: 1;
  }
  .task-row__heading span.task-stock {
    width: auto;
    align-self: center;
    margin-left: 0;
    text-align: right !important;
  }
  .task-row > .reward-item {
    width: 48px;
    height: 48px;
  }
  .collect-composer {
    padding-top: 14px;
    padding-left: 0;
    border-top: 1px solid rgba(49, 82, 70, 0.12);
    border-left: 0;
  }
}
</style>
