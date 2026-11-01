<script setup lang="ts">
import type { SeasonDto } from '@/stores/activity-center'
import { computed, ref } from 'vue'
import RewardItem from './RewardItem.vue'
import TravelRulesDialog from './TravelRulesDialog.vue'

const props = defineProps<{
  season: SeasonDto | null
  pending?: boolean
  enabled?: boolean
}>()
const emit = defineEmits<{ claim: [] }>()
const pass = computed(() => props.season?.pass ?? null)
const currentLevel = computed(() => pass.value?.level)
const rulesOpen = ref(false)
const percentage = computed(() => {
  const value = pass.value?.progress
  const maximum = pass.value?.progressMax
  return value === null || value === undefined || maximum === null || maximum === undefined || maximum <= 0 ? 0 : Math.min(100, Math.max(0, value / maximum * 100))
})
const hasClaimableNode = computed(() => pass.value?.nodes.some(node => node.claimable) === true)
const canClaim = computed(() => Boolean(props.enabled && hasClaimableNode.value && !props.pending))
</script>

<template>
  <div class="travel-tab">
    <section class="travel-progress">
      <div class="travel-progress__badge">
        <b>{{ currentLevel ?? '--' }}</b><small>等级</small>
      </div>
      <div class="travel-progress__main">
        <strong>游记积分</strong>
        <div class="score">
          <span>{{ pass?.progress ?? '--' }}</span><i>/</i><span>{{ pass?.progressMax ?? '--' }}</span>
        </div>
        <div class="progress">
          <i :style="{ width: `${percentage}%` }" />
        </div>
      </div>
    </section>

    <div class="travel-tip">
      <span>收获游记果实可获得游记积分</span>
      <button type="button" aria-label="查看千星游记活动说明" @click="rulesOpen = true">
        ?
      </button>
    </div>
    <div class="travel-labels">
      <span>游记等级</span><span>游记奖励</span>
    </div>

    <div v-if="pass?.nodes.length" class="travel-list">
      <article v-for="node in pass.nodes" :key="node.id" class="travel-row" :class="{ current: node.current || (node.level && node.level === currentLevel), claimed: node.claimed, claimable: node.claimable, milestone: node.keyLevel }">
        <div class="level-medal">
          <b>{{ node.level || '--' }}</b><small>等级</small>
        </div>
        <div class="reward-group">
          <RewardItem v-for="(item, index) in node.rewards" :key="item.id || index" :name="item.name" :count="item.count" :image="item.image" :rarity="item.rarity" :locked="item.locked || node.locked" compact />
        </div>
        <span v-if="node.claimed" class="state">已领取</span>
      </article>
    </div>
    <div v-else class="travel-empty">
      <span class="empty-star" aria-hidden="true">☆</span><p>暂无数据</p>
    </div>

    <div class="claim-action">
      <button type="button" :disabled="!canClaim" @click="emit('claim')">
        {{ pending ? '领取中…' : '一键领取' }}
      </button>
    </div>

    <TravelRulesDialog :open="rulesOpen" :rules="pass?.rules || { title: '活动说明', paragraphs: [] }" @close="rulesOpen = false" />
  </div>
</template>

<style scoped>
.travel-tab {
  min-height: 100%;
  padding: calc(125px + env(safe-area-inset-top)) 13px 180px;
  background: radial-gradient(ellipse at 50% 8%, rgba(76, 146, 218, 0.38), transparent 34%);
}
.travel-progress {
  position: relative;
  min-height: 103px;
  display: grid;
  grid-template-columns: 77px 1fr;
  align-items: center;
  gap: 8px;
  padding: 11px 17px 11px 5px;
  border: 2px solid rgba(144, 218, 255, 0.62);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(10, 83, 151, 0.92), rgba(7, 55, 115, 0.93));
  box-shadow:
    inset 0 0 18px rgba(126, 211, 255, 0.2),
    0 4px 10px rgba(0, 28, 72, 0.25);
}
.travel-progress__badge,
.level-medal {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: white;
  background: linear-gradient(145deg, #64d7f8, #1a72bf);
  clip-path: polygon(
    50% 0,
    63% 22%,
    88% 18%,
    82% 46%,
    100% 65%,
    73% 76%,
    64% 100%,
    50% 84%,
    36% 100%,
    27% 76%,
    0 65%,
    18% 46%,
    12% 18%,
    37% 22%
  );
  filter: drop-shadow(0 3px 2px #063f79);
}
.travel-progress__badge {
  width: 74px;
  height: 84px;
}
.travel-progress__badge b {
  font-size: 37px;
  line-height: 1;
}
.travel-progress__badge small {
  font-size: 11px;
}
.travel-progress__main {
  min-width: 0;
}
.travel-progress__main strong {
  display: block;
  overflow: hidden;
  color: #e8f7ff;
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.score {
  margin-top: 6px;
  color: #fff;
  font-size: 15px;
  font-weight: var(--fw-700);
}
.score i {
  padding: 0 3px;
  color: #9fd3ef;
  font-style: normal;
}
.progress {
  height: 11px;
  margin-top: 7px;
  overflow: hidden;
  border: 1px solid #65b7e4;
  border-radius: 99px;
  background: #073f73;
  box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.4);
}
.progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #ffd36c, #fff0ac);
}
.travel-tip {
  min-height: 31px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 7px 3px 0;
  padding: 4px 8px 4px 12px;
  border-radius: 12px;
  color: #cbeaff;
  background: rgba(46, 139, 201, 0.3);
  font-size: 11px;
}
.travel-tip span {
  flex: 1;
  text-align: center;
}
.travel-tip button {
  flex: none;
  width: 21px;
  height: 21px;
  padding: 0;
  border: 1px solid rgba(226, 247, 255, 0.85);
  border-radius: 50%;
  color: #effbff;
  background: rgba(7, 65, 119, 0.62);
  font-size: 13px;
  font-weight: var(--fw-700);
  line-height: 19px;
  cursor: pointer;
}
.travel-tip button:focus-visible {
  outline: 2px solid #fff0a1;
  outline-offset: 2px;
}
.travel-labels {
  display: flex;
  justify-content: space-between;
  padding: 9px 34px 5px;
  color: #c9e9fa;
  font-size: 12px;
}
.travel-list {
  display: grid;
  gap: 7px;
}
.travel-row {
  position: relative;
  min-height: 85px;
  display: grid;
  grid-template-columns: 76px 1fr;
  align-items: center;
  overflow: hidden;
  border: 1px solid rgba(111, 187, 235, 0.62);
  border-radius: 14px;
  background: linear-gradient(90deg, rgba(8, 75, 135, 0.82), rgba(15, 106, 164, 0.55));
}
.travel-row.current {
  border-color: #9deeff;
  background: linear-gradient(90deg, rgba(51, 172, 222, 0.95), rgba(22, 119, 184, 0.8));
  box-shadow: 0 0 13px rgba(90, 216, 255, 0.3);
}
.travel-row.claimable {
  border-color: #ffe5a1;
  box-shadow: 0 0 13px rgba(255, 213, 100, 0.35);
}
.travel-row.claimed {
  opacity: 0.72;
}
.travel-row.milestone::before {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(255, 224, 142, 0.32);
  border-radius: 13px;
  content: '';
  pointer-events: none;
}
.level-medal {
  width: 66px;
  height: 75px;
  margin-left: 5px;
}
.level-medal b {
  font-size: 26px;
  line-height: 1;
}
.level-medal small {
  font-size: 9px;
}
.reward-group {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  padding: 7px 5px;
}
.state {
  position: absolute;
  top: 4px;
  right: 6px;
  padding: 2px 6px;
  border-radius: 8px;
  color: #d0e5f0;
  background: rgba(0, 30, 68, 0.55);
  font-size: 9px;
}
.travel-empty {
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #b9dced;
}
.empty-star {
  font-size: 58px;
  color: rgba(167, 226, 251, 0.45);
}
.travel-empty p {
  margin: 2px;
}
.claim-action {
  position: fixed;
  z-index: 29;
  right: 0;
  bottom: calc(92px + env(safe-area-inset-bottom));
  left: 0;
  display: flex;
  justify-content: center;
  padding: 8px 0 6px;
  pointer-events: none;
}
.claim-action button {
  pointer-events: auto;
}
.claim-action button {
  min-width: 158px;
  padding: 10px 27px;
  border: 2px solid #fff1a8;
  border-radius: 27px;
  color: #fff8d5;
  background: linear-gradient(#f4bd52, #b97827);
  box-shadow:
    0 0 16px rgba(255, 207, 93, 0.55),
    inset 0 1px rgba(255, 255, 255, 0.5);
  font-size: 16px;
  font-weight: var(--fw-700);
  cursor: pointer;
}
.claim-action button:disabled {
  border-color: #9eb4c9;
  color: #d5e0e9;
  background: linear-gradient(#7892aa, #526b83);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.24);
  cursor: not-allowed;
  filter: none;
  opacity: 0.8;
}

/* Generic activity gameplay layout. */
.travel-tab {
  min-height: 100%;
  padding: 24px;
  color: #203a32;
  background: transparent;
}
.travel-progress {
  min-height: 112px;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 18px;
  padding: 16px 20px;
  border: 1px solid rgba(42, 112, 86, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.7);
  box-shadow:
    0 12px 30px rgba(40, 74, 61, 0.08),
    inset 0 1px rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(16px);
}
.travel-progress__badge,
.level-medal {
  clip-path: none;
  filter: none;
  border: 1px solid rgba(38, 129, 94, 0.16);
  border-radius: 14px;
  color: #1f7453;
  background: rgba(226, 245, 237, 0.9);
}
.travel-progress__badge {
  width: 76px;
  height: 76px;
}
.travel-progress__badge b {
  font-size: 30px;
}
.travel-progress__main strong {
  color: #263d36;
  font-size: 14px;
}
.score {
  color: #1c6249;
}
.score i {
  color: #87958f;
}
.progress {
  height: 9px;
  border: 0;
  background: #e4ebe8;
  box-shadow: inset 0 1px 2px rgba(24, 60, 46, 0.1);
}
.progress i {
  background: linear-gradient(90deg, #40a979, #5a8bd6);
}
.travel-tip {
  justify-content: flex-start;
  margin: 10px 0 0;
  padding: 8px 10px 8px 14px;
  border: 1px solid rgba(72, 111, 97, 0.1);
  border-radius: 10px;
  color: #62756e;
  background: rgba(244, 248, 246, 0.72);
}
.travel-tip span {
  text-align: left;
}
.travel-tip button {
  border-color: rgba(53, 104, 84, 0.24);
  color: #356b56;
  background: white;
}
.travel-labels {
  padding: 20px 10px 8px;
  color: #6e7e78;
}
.travel-list {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.travel-row {
  min-height: 96px;
  grid-template-columns: 72px minmax(0, 1fr);
  border: 1px solid rgba(52, 85, 73, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.62);
  box-shadow: 0 8px 22px rgba(36, 68, 56, 0.06);
}
.travel-row.current {
  border-color: rgba(56, 140, 108, 0.38);
  background: rgba(233, 247, 241, 0.9);
  box-shadow: 0 8px 24px rgba(39, 112, 83, 0.1);
}
.travel-row.claimable {
  border-color: rgba(197, 142, 44, 0.4);
  box-shadow: 0 8px 24px rgba(154, 112, 36, 0.1);
}
.travel-row.milestone::before {
  border-color: rgba(195, 146, 51, 0.2);
}
.level-medal {
  width: 58px;
  height: 66px;
  margin-left: 8px;
  color: #366b58;
  background: #eef5f2;
}
.level-medal b {
  font-size: 22px;
}
.state {
  color: #52655d;
  background: rgba(234, 239, 237, 0.92);
}
.travel-empty {
  color: #76877f;
}
.empty-star {
  color: rgba(59, 118, 94, 0.28);
}
.claim-action {
  position: sticky;
  right: auto;
  bottom: 0;
  left: auto;
  margin: 16px -24px -24px;
  padding: 12px 24px;
  border-top: 1px solid rgba(45, 76, 65, 0.1);
  background: rgba(248, 251, 250, 0.82);
  backdrop-filter: blur(16px);
}
.claim-action button {
  min-width: 142px;
  padding: 10px 22px;
  border: 1px solid #2d8b66;
  border-radius: 10px;
  color: white;
  background: #2d8b66;
  box-shadow: 0 8px 18px rgba(35, 113, 83, 0.2);
  font-size: 14px;
}
.claim-action button:disabled {
  border-color: #cbd5d1;
  color: #87938e;
  background: #e5ebe8;
  box-shadow: none;
}
@media (max-width: 760px) {
  .travel-tab {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 14px;
  }
  .travel-list {
    min-height: 0;
    flex: 1;
    grid-template-columns: 1fr;
    align-content: start;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .travel-progress {
    min-height: 68px;
    grid-template-columns: 48px minmax(0, 1fr);
    gap: 8px;
    padding: 9px 10px;
    border-radius: 12px;
  }
  .travel-progress__badge {
    width: 46px;
    height: 46px;
    border-radius: 10px;
  }
  .travel-progress__badge b {
    font-size: 19px;
  }
  .travel-progress__badge small {
    font-size: 9px;
  }
  .travel-progress__main strong {
    font-size: 12px;
  }
  .score {
    margin-top: 3px;
    font-size: 12px;
  }
  .progress {
    height: 6px;
    margin-top: 5px;
  }
  .travel-row {
    min-height: 72px;
    grid-template-columns: 52px minmax(0, 1fr);
  }
  .level-medal {
    width: 44px;
    height: 50px;
    margin-left: 4px;
  }
  .level-medal b {
    font-size: 18px;
  }
  .level-medal small {
    font-size: 8px;
  }
  .reward-group {
    gap: 4px;
    padding: 5px 3px;
  }
  .travel-row :deep(.reward-item) {
    width: 46px;
    height: 46px;
  }
  .claim-action {
    position: static;
    flex: none;
    margin: 8px -14px -14px;
    padding: 8px 14px;
  }
  .travel-empty {
    min-height: 0;
    flex: 1;
  }
}
</style>
