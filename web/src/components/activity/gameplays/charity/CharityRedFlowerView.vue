<script setup lang="ts">
import type { CharityRedFlowerActivityDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  activity: CharityRedFlowerActivityDto | null
  pendingSeeds: boolean
  pendingDonate: boolean
  pendingDailyGift: boolean
}>()

const emit = defineEmits<{
  claimSeeds: []
  donateLove: []
  claimDailyGift: []
}>()

const confirmingDonate = ref(false)

const globalPercent = computed(() => {
  const donated = Number(props.activity?.globalProgress.donated || 0)
  const target = Number(props.activity?.globalProgress.target || 0)
  if (!Number.isFinite(donated) || !Number.isFinite(target) || target <= 0)
    return 0
  return Math.min(100, Math.max(0, donated / target * 100))
})

const seedStatus = computed(() => {
  if (props.activity?.seedReward.claimed)
    return '今日已领取'
  if (props.activity?.seedReward.claimable)
    return '可以领取'
  return '完成今日任务后可领取'
})

const dailyGiftStatus = computed(() => {
  if (props.activity?.dailyGift.claimed)
    return '今日已领取'
  return '今日收获小红花后可尝试领取'
})

function formatCount(value: string) {
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : value || '0'
}

function formatFundDate(value: string) {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value
}

function requestDonation() {
  confirmingDonate.value = true
}

function confirmDonation() {
  confirmingDonate.value = false
  emit('donateLove')
}

watch(() => props.activity?.loveBalance, () => confirmingDonate.value = false)
</script>

<template>
  <div class="charity-page">
    <template v-if="activity">
      <section class="overview-band">
        <div class="overview-title">
          <span class="overview-mark i-carbon-favorite-filled" />
          <div>
            <small>我的公益进度</small>
            <h2>每一份爱心都会计入累计捐赠</h2>
          </div>
        </div>
        <div class="overview-metrics">
          <div>
            <span>当前爱心</span>
            <strong>{{ formatCount(activity.loveBalance) }}</strong>
          </div>
          <div>
            <span>累计捐赠</span>
            <strong>{{ formatCount(activity.donatedLove) }}</strong>
          </div>
          <div>
            <span>结算资格</span>
            <strong :class="{ eligible: activity.settlement.eligible }">
              {{ activity.settlement.eligible ? '已达成' : `${formatCount(activity.donatedLove)} / ${formatCount(activity.settlement.requiredLove)}` }}
            </strong>
          </div>
        </div>
      </section>

      <section class="global-band">
        <header>
          <div>
            <small>全服共同目标</small>
            <h2>公益爱心进度</h2>
          </div>
          <strong>{{ globalPercent.toFixed(2) }}%</strong>
        </header>
        <div class="global-track" role="progressbar" :aria-valuenow="globalPercent" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${globalPercent}%` }" />
        </div>
        <div class="global-detail">
          <span>{{ formatCount(activity.globalProgress.donated) }} / {{ formatCount(activity.globalProgress.target) }} 爱心</span>
          <div class="inline-reward">
            <img v-if="activity.globalProgress.reward.image" :src="activity.globalProgress.reward.image" alt="">
            <span>目标奖励 {{ activity.globalProgress.reward.name || activity.globalProgress.reward.id }}</span>
            <b>×{{ activity.globalProgress.reward.count }}</b>
          </div>
        </div>
      </section>

      <section class="commands-section">
        <header class="section-heading">
          <div>
            <small>每日公益行动</small>
            <h2>领取与捐赠</h2>
          </div>
        </header>

        <div class="command-grid">
          <article class="command-item seed-command">
            <div class="command-icon i-carbon-sprout" />
            <div class="command-copy">
              <small>每日种子</small>
              <strong>{{ seedStatus }}</strong>
              <div class="inline-reward">
                <img v-if="activity.seedReward.reward.image" :src="activity.seedReward.reward.image" alt="">
                <span>{{ activity.seedReward.reward.name || activity.seedReward.reward.id }}</span>
                <b>×{{ activity.seedReward.reward.count }}</b>
              </div>
            </div>
            <button
              type="button"
              :disabled="pendingSeeds || !activity.actions.claimSeeds.enabled"
              @click="emit('claimSeeds')"
            >
              <span :class="pendingSeeds ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-download'" />
              {{ pendingSeeds ? '领取中' : activity.seedReward.claimed ? '已领取' : '领取种子' }}
            </button>
          </article>

          <article class="command-item donate-command">
            <div class="command-icon i-carbon-favorite" />
            <div class="command-copy">
              <small>爱心捐赠</small>
              <strong>本次将捐赠全部 {{ formatCount(activity.loveBalance) }} 份</strong>
              <span>协议会一次性清空当前爱心余额</span>
            </div>
            <div v-if="confirmingDonate" class="confirm-actions">
              <button type="button" class="secondary" :disabled="pendingDonate" @click="confirmingDonate = false">
                取消
              </button>
              <button type="button" :disabled="pendingDonate" @click="confirmDonation">
                <span class="i-carbon-send-alt" />确认捐赠
              </button>
            </div>
            <button
              v-else
              type="button"
              :disabled="pendingDonate || !activity.actions.donateLove.enabled"
              @click="requestDonation"
            >
              <span :class="pendingDonate ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-send-alt'" />
              {{ pendingDonate ? '捐赠中' : `捐赠全部 ${formatCount(activity.loveBalance)}` }}
            </button>
          </article>

          <article class="command-item gift-command">
            <div class="command-icon i-carbon-gift" />
            <div class="command-copy">
              <small>每日公益礼包</small>
              <strong>{{ dailyGiftStatus }}</strong>
              <div class="inline-reward">
                <img v-if="activity.dailyGift.reward.image" :src="activity.dailyGift.reward.image" alt="">
                <span>{{ activity.dailyGift.reward.name || activity.dailyGift.reward.id }}</span>
                <b>×{{ activity.dailyGift.reward.count }}</b>
              </div>
              <span v-if="activity.dailyGift.publicFund">公益记录 {{ formatFundDate(activity.dailyGift.publicFund.date) }}</span>
            </div>
            <button
              type="button"
              :disabled="pendingDailyGift || !activity.actions.claimDailyGift.enabled"
              @click="emit('claimDailyGift')"
            >
              <span :class="pendingDailyGift ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-gift'" />
              {{ pendingDailyGift ? '领取中' : activity.dailyGift.claimed ? '已领取' : '领取礼包' }}
            </button>
          </article>
        </div>
      </section>

      <section class="progress-section">
        <header class="section-heading">
          <div>
            <small>个人累计捐赠</small>
            <h2>进度奖励</h2>
          </div>
          <span class="readonly-label"><span class="i-carbon-locked" /> 仅展示</span>
        </header>
        <div class="milestone-track">
          <article
            v-for="reward in activity.progressRewards"
            :key="reward.target"
            class="milestone"
            :class="{ reached: reward.reached }"
          >
            <span class="milestone-dot">
              <span v-if="reward.reached" class="i-carbon-checkmark" />
              <span v-else class="i-carbon-favorite" />
            </span>
            <strong>{{ reward.target }} 爱心</strong>
            <div class="milestone-reward">
              <img v-if="reward.reward.image" :src="reward.reward.image" alt="">
              <span>{{ reward.reward.name || reward.reward.id }}</span>
              <b>×{{ reward.reward.count }}</b>
            </div>
            <small>{{ reward.reached ? '已达成，需在游戏内领取' : '尚未达成' }}</small>
          </article>
        </div>
      </section>

      <section class="settlement-band">
        <div>
          <span class="i-carbon-trophy" />
          <div>
            <small>活动结算奖励</small>
            <strong>累计捐赠 {{ activity.settlement.requiredLove }} 份爱心</strong>
          </div>
        </div>
        <div class="inline-reward">
          <img v-if="activity.settlement.reward.image" :src="activity.settlement.reward.image" alt="">
          <span>{{ activity.settlement.reward.name || activity.settlement.reward.id }}</span>
          <b>×{{ activity.settlement.reward.count }}</b>
        </div>
        <span class="settlement-status" :class="{ eligible: activity.settlement.eligible }">
          {{ activity.settlement.eligible ? '已获得结算资格' : `还差 ${Math.max(0, Number(activity.settlement.requiredLove) - Number(activity.donatedLove))} 份爱心` }}
        </span>
      </section>

      <details v-if="activity.rules.paragraphs.length" class="rules-section">
        <summary>{{ activity.rules.title || '活动说明' }}</summary>
        <p v-for="line in activity.rules.paragraphs" :key="line">
          {{ line }}
        </p>
      </details>
    </template>

    <div v-else class="empty-state">
      <span class="i-carbon-favorite" />
      <strong>当前账号暂未发现公益小红花活动</strong>
    </div>
  </div>
</template>

<style scoped>
.charity-page {
  min-height: 100%;
  padding: 22px 18px 56px;
  color: #253730;
  background: #f5f7f4;
}

.overview-band,
.global-band,
.commands-section,
.progress-section,
.settlement-band,
.rules-section {
  width: min(1120px, 100%);
  margin: 0 auto 14px;
  border: 1px solid #dce3de;
  border-radius: 8px;
  background: #fff;
}

.overview-band {
  display: grid;
  grid-template-columns: minmax(240px, 0.8fr) minmax(420px, 1.2fr);
  align-items: center;
  gap: 24px;
  padding: 20px 22px;
  border-top: 4px solid #d94c58;
}

.overview-title,
.overview-metrics,
.command-item,
.section-heading,
.global-band header,
.global-detail,
.settlement-band,
.settlement-band > div,
.inline-reward,
.confirm-actions {
  display: flex;
  align-items: center;
}

.overview-title {
  gap: 14px;
}

.overview-mark {
  color: #d94c58;
  font-size: 34px;
}

.overview-title div,
.section-heading div,
.command-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

small {
  color: #718078;
  font-size: 11px;
}

h2 {
  margin: 2px 0 0;
  font-size: 17px;
  letter-spacing: 0;
}

.overview-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid #e1e6e2;
  border-radius: 7px;
  background: #e1e6e2;
}

.overview-metrics > div {
  min-width: 0;
  padding: 12px 14px;
  background: #f9faf9;
}

.overview-metrics span,
.overview-metrics strong {
  display: block;
}

.overview-metrics span {
  color: #718078;
  font-size: 11px;
}

.overview-metrics strong {
  margin-top: 4px;
  overflow-wrap: anywhere;
  font-size: 19px;
}

.eligible {
  color: #17835b;
}

.global-band {
  padding: 18px 22px;
}

.global-band header,
.global-detail,
.section-heading,
.settlement-band {
  justify-content: space-between;
  gap: 16px;
}

.global-band header > strong {
  color: #245f88;
  font-size: 20px;
}

.global-track {
  height: 10px;
  overflow: hidden;
  margin: 14px 0 10px;
  border-radius: 5px;
  background: #e5ecef;
}

.global-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #2c7ea8;
  transition: width 240ms ease;
}

.global-detail > span {
  color: #53635b;
  font-size: 12px;
}

.inline-reward {
  min-width: 0;
  gap: 7px;
  color: #53635b;
  font-size: 12px;
}

.inline-reward img,
.milestone-reward img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.inline-reward b,
.milestone-reward b {
  color: #253730;
}

.commands-section,
.progress-section {
  padding: 18px 22px 22px;
}

.section-heading {
  margin-bottom: 14px;
}

.command-item button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 13px;
  border: 0;
  border-radius: 6px;
  color: #fff;
  font-weight: 700;
  background: #247455;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.readonly-label,
.settlement-status {
  flex: none;
  color: #53635b;
  font-size: 12px;
  font-weight: 700;
}

.command-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 14px;
  border: 1px solid #e1e6e2;
  border-radius: 7px;
}

.command-item {
  min-width: 0;
  align-items: flex-start;
  gap: 11px;
  padding: 16px;
}

.command-item + .command-item {
  border-left: 1px solid #e1e6e2;
}

.command-icon {
  flex: none;
  margin-top: 3px;
  color: #247455;
  font-size: 24px;
}

.donate-command .command-icon {
  color: #d94c58;
}

.gift-command .command-icon {
  color: #7161a8;
}

.command-copy {
  flex: 1;
  gap: 3px;
}

.command-copy strong,
.command-copy span {
  overflow-wrap: anywhere;
}

.command-copy > span {
  color: #718078;
  font-size: 11px;
}

.command-item > button,
.confirm-actions {
  align-self: center;
}

.confirm-actions {
  flex-direction: column;
  gap: 6px;
}

.confirm-actions .secondary {
  width: 100%;
  border: 1px solid #cdd6d0;
  color: #53635b;
  background: #fff;
}

.progress-section {
  overflow: hidden;
}

.readonly-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.milestone-track {
  display: grid;
  grid-template-columns: repeat(5, minmax(128px, 1fr));
  border-top: 1px solid #e1e6e2;
}

.milestone {
  position: relative;
  min-width: 0;
  padding: 34px 12px 12px;
  text-align: center;
}

.milestone + .milestone {
  border-left: 1px solid #e1e6e2;
}

.milestone::before {
  position: absolute;
  top: 15px;
  right: 50%;
  left: -50%;
  height: 2px;
  content: '';
  background: #dfe5e1;
}

.milestone:first-child::before {
  display: none;
}

.milestone.reached::before {
  background: #48a879;
}

.milestone-dot {
  position: absolute;
  z-index: 1;
  top: 7px;
  left: 50%;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: 2px solid #cbd5ce;
  border-radius: 50%;
  color: #829087;
  background: #fff;
  transform: translateX(-50%);
}

.milestone.reached .milestone-dot {
  border-color: #48a879;
  color: #fff;
  background: #48a879;
}

.milestone-reward {
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 6px 0;
  font-size: 11px;
}

.milestone small {
  display: block;
  min-height: 32px;
}

.milestone.reached small {
  color: #17835b;
  font-weight: 700;
}

.settlement-band {
  padding: 16px 22px;
  border-left: 4px solid #7161a8;
}

.settlement-band > div:first-child {
  gap: 11px;
}

.settlement-band > div:first-child > span {
  color: #7161a8;
  font-size: 25px;
}

.settlement-band > div:first-child div {
  display: flex;
  flex-direction: column;
}

.settlement-status {
  padding: 6px 9px;
  border-radius: 5px;
  background: #eef1ef;
}

.settlement-status.eligible {
  color: #146e4c;
  background: #e5f5eb;
}

.rules-section {
  padding: 14px 18px;
}

.rules-section summary {
  cursor: pointer;
  font-weight: 700;
}

.rules-section p {
  margin: 10px 0 0;
  color: #53635b;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-line;
}

.empty-state {
  min-height: 360px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: #718078;
}

.empty-state span {
  font-size: 34px;
}

@media (max-width: 960px) {
  .overview-band {
    grid-template-columns: 1fr;
  }

  .command-grid {
    grid-template-columns: 1fr;
  }

  .command-item + .command-item {
    border-top: 1px solid #e1e6e2;
    border-left: 0;
  }

  .confirm-actions {
    flex-direction: row;
  }

  .milestone-track {
    overflow-x: auto;
    grid-template-columns: repeat(5, minmax(150px, 1fr));
  }
}

@media (max-width: 620px) {
  .charity-page {
    padding: 14px 10px 44px;
  }

  .overview-band,
  .global-band,
  .commands-section,
  .progress-section,
  .settlement-band {
    padding: 14px;
  }

  .overview-metrics {
    grid-template-columns: 1fr;
  }

  .command-item,
  .settlement-band,
  .global-detail {
    align-items: stretch;
    flex-direction: column;
  }

  .command-item > button,
  .confirm-actions {
    width: 100%;
  }

  .confirm-actions button {
    flex: 1;
  }

  .settlement-band .inline-reward {
    justify-content: flex-start;
  }
}
</style>
