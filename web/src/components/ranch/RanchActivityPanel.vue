<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRanchClock, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useRanchStore } from '@/stores/ranch'

/** 牧场活动目录（服务端场景 2）。每日首次分享属于每日礼包，在“个人 → 我的任务”中。 */
const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('activities')
const { serverNow } = useRanchClock()

const activities = computed<any[]>(() => state.value?.activities || [])

function phase(activity: any) {
  if (activity.startTime > serverNow.value)
    return { text: '即将开始', tone: 'soon' }
  if (activity.endTime > 0 && activity.endTime <= serverNow.value)
    return { text: '已结束', tone: 'ended' }
  return { text: '进行中', tone: 'live' }
}
function range(activity: any) {
  const format = (ms: number) => new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  if (!activity.startTime)
    return ''
  return activity.endTime > 0 ? `${format(activity.startTime)} – ${format(activity.endTime)}` : `${format(activity.startTime)} 起`
}
</script>

<template>
  <div class="activity">
    <RanchGate @retry="refresh">
      <div class="page-toolbar !mb-0">
        <span class="activity__count">共 {{ activities.length }} 个牧场活动</span>
        <div class="page-toolbar__actions">
          <NButton secondary circle title="刷新活动" aria-label="刷新活动" :loading="loading" @click="refresh">
            <template #icon>
              <span class="i-carbon-renew" />
            </template>
          </NButton>
        </div>
      </div>

      <EmptyState v-if="!activities.length" title="当前没有牧场活动" description="牧场开启限时活动后会显示在这里" icon="i-carbon-calendar" />
      <section v-else class="farm-card rounded-2xl p-5">
        <ul class="events">
          <li v-for="activity in activities" :key="activity.id" class="event">
            <span class="event__name">{{ activity.name }}</span>
            <span class="event__range">{{ range(activity) }}</span>
            <span class="event__phase" :class="`is-${phase(activity).tone}`">{{ phase(activity).text }}</span>
          </li>
        </ul>
      </section>
    </RanchGate>
  </div>
</template>

<style scoped>
.activity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 24px;
}

.activity__count {
  color: var(--ui-muted);
  font-size: 13px;
}

.events {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.event {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  font-size: 14px;
}

.event + .event {
  border-top: 1px solid var(--ui-border);
}

.event__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event__range {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.event__phase {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 20px;
}

.event__phase.is-live {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.event__phase.is-soon {
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
}

.event__phase.is-ended {
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
}
</style>
