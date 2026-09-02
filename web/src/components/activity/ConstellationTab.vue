<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { ConstellationDto, ConstellationGroupDto } from '@/stores/activity-center'
import { computed, nextTick, ref, watch } from 'vue'
import ActivityRulesDialog from './ActivityRulesDialog.vue'
import RewardItem from './RewardItem.vue'

const props = defineProps<{
  constellation: ConstellationDto | null
  pending?: boolean
  enabled?: boolean
}>()
const emit = defineEmits<{ light: [] }>()
const selectedGroupId = ref('')
const rulesOpen = ref(false)
const tabButtons = new Map<string, HTMLButtonElement>()

const orderedGroups = computed(() => [...(props.constellation?.groups ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)))
const selectedGroup = computed(() => orderedGroups.value.find(group => group.id === selectedGroupId.value) ?? null)
const catalogUnsupported = computed(() => props.constellation?.catalogStatus.toLowerCase() === 'unsupported')
const stateLabel = computed(() => {
  if (selectedGroup.value?.visualState === 'lit')
    return selectedGroup.value.claimStatus === 'confirmed-no-claimable' ? '今日已领取' : '已点亮'
  if (selectedGroup.value?.visualState === 'locked')
    return '未开启'
  if (selectedGroup.value?.visualState === 'unknown')
    return '历史状态待同步'
  return ''
})
const canLight = computed(() => ['lightable', 'claimableUnknown'].includes(selectedGroup.value?.visualState || '') && Boolean(props.enabled) && !props.pending)

function setTabRef(groupId: string, value: Element | ComponentPublicInstance | null) {
  if (value instanceof HTMLButtonElement)
    tabButtons.set(groupId, value)
  else
    tabButtons.delete(groupId)
}

function selectGroup(group: ConstellationGroupDto, focus = false) {
  selectedGroupId.value = group.id
  nextTick(() => {
    const button = tabButtons.get(group.id)
    button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    if (focus)
      button?.focus()
  })
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  let target = index
  if (event.key === 'ArrowRight')
    target = Math.min(orderedGroups.value.length - 1, index + 1)
  else if (event.key === 'ArrowLeft')
    target = Math.max(0, index - 1)
  else if (event.key === 'Home')
    target = 0
  else if (event.key === 'End')
    target = orderedGroups.value.length - 1
  else
    return
  event.preventDefault()
  const group = orderedGroups.value[target]
  if (group)
    selectGroup(group, true)
}

watch(() => props.constellation, (value) => {
  const groups = value?.groups ?? []
  if (!groups.some(group => group.id === selectedGroupId.value))
    selectedGroupId.value = groups.find(group => group.current)?.id || groups.find(group => ['lightable', 'claimableUnknown'].includes(group.visualState))?.id || groups[0]?.id || ''
}, { immediate: true })
</script>

<template>
  <div class="constellation-tab">
    <div v-if="catalogUnsupported" class="catalog-unsupported" role="status">
      <span aria-hidden="true">✦</span>
      <strong>本期星宿配置暂未支持</strong>
    </div>

    <template v-else>
      <div v-if="orderedGroups.length" class="group-strip" role="tablist" aria-label="二十八星宿">
        <button
          v-for="(item, index) in orderedGroups"
          :id="`constellation-tab-${item.id}`"
          :key="item.id"
          :ref="value => setTabRef(item.id, value)"
          type="button"
          role="tab"
          :aria-selected="item.id === selectedGroupId"
          :aria-controls="`constellation-rewards-${item.id}`"
          :tabindex="item.id === selectedGroupId ? 0 : -1"
          :class="[`state-${item.visualState}`, { active: item.id === selectedGroupId }]"
          @click="selectGroup(item)"
          @keydown="onTabKeydown($event, index)"
        >
          <span class="group-strip__name">{{ item.name || '未命名' }}</span>
          <span v-if="item.visualState === 'lightable'" class="group-strip__dot" aria-label="可点亮" />
          <span v-else-if="item.visualState === 'claimableUnknown'" class="group-strip__sync" aria-label="领取状态待同步">?</span>
          <svg v-else-if="item.visualState === 'locked'" class="group-strip__lock" viewBox="0 0 24 24" aria-label="未开启"><rect x="5" y="10" width="14" height="10" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          <svg v-else-if="item.visualState === 'lit'" class="group-strip__done" viewBox="0 0 24 24" aria-label="已点亮"><path d="m5 12 4 4 10-9" /></svg>
        </button>
      </div>

      <section v-if="selectedGroup" :id="`constellation-rewards-${selectedGroup.id}`" class="star-reward" role="tabpanel" :aria-labelledby="`constellation-tab-${selectedGroup.id}`">
        <h2 class="star-reward__title">
          <span>星宿福利</span>
          <button type="button" aria-label="查看观星礼录活动说明" title="查看活动说明" @click.stop="rulesOpen = true">
            ?
          </button>
        </h2>
        <div class="star-reward__items">
          <RewardItem
            v-for="(reward, index) in selectedGroup.rewards"
            :key="reward.id || index"
            :name="reward.name"
            :count="reward.count"
            :image="reward.image"
            :rarity="reward.rarity"
            :locked="selectedGroup.visualState === 'locked'"
            :claimed="selectedGroup.visualState === 'lit'"
            compact
          />
        </div>
      </section>

      <div v-if="selectedGroup" class="light-action" :class="`light-action--${selectedGroup.visualState}`" role="status">
        <button v-if="selectedGroup.visualState === 'lightable' || selectedGroup.visualState === 'claimableUnknown'" type="button" :disabled="!canLight" @click="emit('light')">
          {{ pending ? '同步中…' : selectedGroup.visualState === 'claimableUnknown' ? '尝试领取今日奖励' : '点亮' }}
        </button>
        <strong v-else>{{ stateLabel }}</strong>
      </div>

      <ActivityRulesDialog :open="rulesOpen" :rules="constellation?.rules" @close="rulesOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.constellation-tab {
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(280px, 0.75fr);
  align-content: start;
  gap: 14px;
  padding: 24px;
  color: #203a32;
}
.group-strip {
  grid-column: 1 / -1;
  display: flex;
  gap: 7px;
  margin: 0;
  padding: 4px 0 10px;
  overflow-x: auto;
  scrollbar-width: none;
}
.group-strip::-webkit-scrollbar {
  display: none;
}
.group-strip button {
  position: relative;
  min-width: 82px;
  height: 42px;
  flex: none;
  padding: 5px 12px 5px 32px;
  border: 1px solid rgba(48, 82, 70, 0.14);
  border-radius: 10px;
  color: #697a73;
  background: rgba(255, 255, 255, 0.58);
  cursor: pointer;
}
.group-strip button.active {
  border-color: rgba(54, 118, 166, 0.3);
  color: #315f80;
  background: rgba(230, 240, 248, 0.94);
}
.group-strip button.state-lit:not(.active) {
  color: #456e5e;
}
.group-strip button:focus-visible {
  outline: 2px solid rgba(46, 138, 102, 0.45);
  outline-offset: 2px;
}
.group-strip__dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #e34d5f;
}
.group-strip__sync {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border: 1px solid #8bbda8;
  border-radius: 50%;
  color: #2e8a66;
  background: #e6f4ed;
  transform: translateY(-50%);
  font-size: 10px;
}
.group-strip__lock,
.group-strip__done {
  position: absolute;
  top: 50%;
  left: 9px;
  width: 16px;
  height: 16px;
  transform: translateY(-50%);
}
.group-strip__lock {
  fill: #c5d6cd;
  stroke: #6e8b7d;
  stroke-width: 2;
}
.group-strip__done {
  padding: 2px;
  border: 1px solid rgba(47, 142, 105, 0.4);
  border-radius: 50%;
  fill: none;
  stroke: #2e8a66;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  background: #e5f4ec;
}
.star-reward {
  min-height: 220px;
  margin: 0;
  padding: 52px 18px 20px;
  border: 1px solid rgba(49, 82, 70, 0.12);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 12px 30px rgba(38, 69, 57, 0.07);
}
.star-reward__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 18px;
  color: #2b493f;
  font-size: 16px;
}
.star-reward__title button {
  width: 20px;
  height: 20px;
  display: inline-grid;
  flex: none;
  place-items: center;
  padding: 0;
  border: 1px solid #d4bd91;
  border-radius: 50%;
  color: #8d633f;
  background: #fff8df;
  font-family: Arial, sans-serif;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  text-align: center;
  cursor: pointer;
  appearance: none;
}
.star-reward__items {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 10px;
}
.light-action {
  min-height: 82px;
  align-self: start;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  border: 1px solid rgba(49, 82, 70, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.52);
}
.light-action strong {
  color: #416858;
  font-size: 16px;
}
.light-action button {
  min-width: 126px;
  min-height: 40px;
  padding: 8px 18px;
  border: 1px solid #2e8a66;
  border-radius: 10px;
  color: white;
  background: #2e8a66;
  box-shadow: 0 8px 18px rgba(35, 113, 83, 0.18);
  font-size: 14px;
  cursor: pointer;
}
.light-action button:disabled {
  cursor: wait;
  opacity: 0.7;
}
.catalog-unsupported {
  grid-column: 1 / -1;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #667a72;
  text-align: center;
}
.catalog-unsupported span {
  color: #4b8b72;
  font-size: 50px;
}
@media (max-width: 760px) {
  .constellation-tab {
    grid-template-columns: 1fr;
    gap: 10px;
    padding: 14px;
  }
  .group-strip {
    grid-column: auto;
  }
  .star-reward {
    min-height: 150px;
  }
  .light-action {
    min-height: 66px;
  }
}
</style>
