<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { computed, ref, watch } from 'vue'
import RanchFeedMenu from '@/components/ranch/RanchFeedMenu.vue'

/** 单只动物：与农场土地卡同一套结构（顶部标签 / 图 / 名称 / 状态 / 进度条），可选底部操作。 */
const props = withDefaults(defineProps<{
  animal: any
  /** 所在设施名称，例如“窝”“棚”。 */
  pen?: string
  /** 距离下一阶段的剩余时间文本，由父组件按服务器时钟计算。 */
  remaining?: string
  actionable?: boolean
  friend?: boolean
  disabled?: boolean
  buckets?: ReadonlyArray<{ id: number, name: string, seconds?: number | string }>
}>(), { pen: '', remaining: '', actionable: false, friend: false, disabled: false })

const emit = defineEmits<{ produce: [], harvest: [], feed: [bucketType: 1 | 2, produceAfterFeed: boolean], release: [], stroke: [] }>()
const failed = ref(false)
watch(() => props.animal?.image, () => failed.value = false)

const giant = computed(() => !!props.animal?.mutation?.type)
const weight = computed(() => {
  const x10 = Number(props.animal?.mutation?.weightX10) || 0
  return x10 > 0 ? `${(x10 / 100).toFixed(2).replace(/\.?0+$/, '')}kg` : ''
})
const status = computed(() => {
  const a = props.animal
  if (a.canHarvest)
    return { kind: 'ripe', text: '可收获', icon: 'i-carbon-checkmark-filled' }
  if (a.canProduce)
    return { kind: 'produce', text: '可生产', icon: 'i-carbon-circle-dash' }
  if (a.grassBlocked)
    return { kind: 'blocked', text: '缺少牧草', icon: 'i-carbon-warning-alt' }
  return null
})
const rounds = computed(() => {
  const max = Number(props.animal?.maxProduceCount) || 0
  return max > 0 ? { done: Math.min(max, Number(props.animal.produceCount) || 0), max } : null
})
</script>

<template>
  <article class="pen" :class="[status ? `pen--${status.kind}` : '', { 'pen--giant': giant }]" :title="animal.name">
    <header class="pen__top">
      <span v-if="pen" class="pen__chip">{{ pen }}</span>
      <span v-if="giant" class="pen__giant" :title="weight ? `巨大 · ${weight}` : '巨大'">巨大<template v-if="weight"> {{ weight }}</template></span>
    </header>

    <div class="pen__animal">
      <img v-if="animal.image && !failed" :src="animal.image" alt="" loading="lazy" @error="failed = true">
      <span v-else class="pen__placeholder i-carbon-pet-image-o" aria-hidden="true" />
    </div>

    <div class="pen__name">
      {{ animal.name }}
    </div>

    <div class="pen__time">
      <span v-if="status" class="pen__state" :class="`is-${status.kind}`"><span :class="status.icon" aria-hidden="true" />{{ status.text }}</span>
      <span v-else-if="remaining" class="pen__countdown"><span class="i-carbon-time" aria-hidden="true" />{{ remaining }}</span>
      <span v-else class="pen__state is-muted">{{ animal.stageName }}</span>
    </div>

    <div v-if="rounds" class="pen__rounds" :title="`已生产 ${rounds.done} / ${rounds.max} 轮`" :aria-label="`已生产 ${rounds.done} / ${rounds.max} 轮`" role="img">
      <i v-for="n in rounds.max" :key="n" :class="{ 'is-done': n <= rounds.done }" />
    </div>
    <div v-else class="pen__rounds" aria-hidden="true" />

    <footer v-if="actionable" class="pen__foot">
      <NButton v-if="friend" size="tiny" type="primary" secondary :disabled="disabled || !animal.canStroke" :aria-label="`抚摸${animal.name}，${pen}第${animal.slot}栏`" @click="emit('stroke')">
        {{ animal.stroked ? '已抚摸' : animal.canStroke ? '抚摸' : '不可抚摸' }}
      </NButton>
      <NButton v-else-if="animal.canHarvest" size="tiny" type="primary" :disabled="disabled" @click="emit('harvest')">
        收获
      </NButton>
      <NButton v-else-if="animal.canProduce" size="tiny" type="primary" secondary :disabled="disabled" @click="emit('produce')">
        生产
      </NButton>
      <RanchFeedMenu v-else-if="animal.canFeed" v-slot="{ unavailable }" :buckets="buckets" :limited-can-used="animal.limitedCanUsed" :disabled="disabled" @feed="(type, produce) => emit('feed', type, produce)">
        <NButton size="tiny" secondary aria-haspopup="menu" :disabled="unavailable" :title="unavailable && !disabled ? '可用罐头不足或本轮已使用' : undefined">
          <span class="i-carbon-flash mr-0.5" aria-hidden="true" />喂养
        </NButton>
      </RanchFeedMenu>
      <span v-else class="pen__idle">成长中</span>
      <NButton v-if="!friend && animal.canRelease" size="tiny" quaternary :disabled="disabled" :aria-label="`放生${animal.name}，${pen}第${animal.slot}栏`" @click="emit('release')">
        放生
      </NButton>
    </footer>
  </article>
</template>

<style scoped>
/* 卡面用干草色，与农场普通土地同一色系；巨大动物换成金色。 */
.pen {
  --pen-bg: #fbf8f1;
  --pen-line: #e6dbc2;
  --pen-ink: #86642e;
  --pen-chip: #f1e7d2;

  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  padding: 8px 10px 10px;
  border: 1px solid var(--pen-line);
  border-radius: 14px;
  color: var(--ui-ink);
  background: var(--pen-bg);
  box-shadow: 0 1px 2px rgba(45, 66, 52, 0.05);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.pen--giant {
  --pen-bg: #fffae8;
  --pen-line: #ead57f;
  --pen-ink: #946600;
  --pen-chip: #f9e9a8;
}

.pen--ripe {
  border-color: color-mix(in srgb, var(--ui-primary) 55%, var(--pen-line));
}

.pen--blocked {
  border-color: color-mix(in srgb, var(--ui-warning) 60%, var(--pen-line));
}

.pen__top {
  display: flex;
  width: 100%;
  height: 20px;
  align-items: center;
  gap: 4px;
}

.pen__chip,
.pen__giant {
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--fw-700);
  line-height: 16px;
  white-space: nowrap;
}

.pen__chip {
  color: var(--pen-ink);
  background: var(--pen-chip);
}

.pen__giant {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: #fff;
  background: #c08a12;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.pen__animal {
  width: 52px;
  height: 52px;
  display: grid;
  margin-top: 2px;
  place-items: center;
}

.pen__animal img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.12));
}

.pen__placeholder {
  color: color-mix(in srgb, var(--pen-ink) 40%, transparent);
  font-size: 26px;
}

.pen__name {
  width: 100%;
  margin-top: 4px;
  overflow: hidden;
  font-size: 12px;
  font-weight: var(--fw-650);
  line-height: 16px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pen__time {
  display: flex;
  max-width: 100%;
  height: 20px;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}

.pen__countdown {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ui-warning);
  font-size: 11px;
  font-weight: var(--fw-700);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.pen__state {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--fw-700);
  line-height: 18px;
  white-space: nowrap;
}

.pen__state.is-ripe {
  color: #fff;
  background: var(--ui-primary-fill);
}

.pen__state.is-produce {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.pen__state.is-blocked {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.pen__state.is-muted {
  padding: 0;
  color: var(--ui-subtle);
  font-weight: var(--fw-500);
}

/* 生产轮次：一轮一格，替代土地卡的成长进度条。 */
.pen__rounds {
  display: flex;
  width: 100%;
  height: 4px;
  gap: 3px;
  margin-top: 6px;
}

.pen__rounds i {
  flex: 1;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pen-ink) 14%, transparent);
}

.pen__rounds i.is-done {
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
}

.pen__foot {
  display: flex;
  width: 100%;
  min-height: 28px;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  justify-content: center;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed color-mix(in srgb, var(--pen-ink) 22%, transparent);
}

.pen__foot :deep(.n-button) {
  min-width: 48px;
  min-height: 24px;
}

.pen__idle {
  color: var(--ui-subtle);
  font-size: 11px;
}

.dark .pen {
  --pen-tint: #c9a867;
  border-color: color-mix(in srgb, var(--pen-tint) 28%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--pen-tint) 12%, #1d2228) 0%, #1a1f25 70%);
  box-shadow: none;
}

.dark .pen--giant {
  --pen-tint: #e6c35a;
}

.dark .pen--ripe {
  border-color: color-mix(in srgb, var(--ui-primary) 55%, transparent);
}

.dark .pen--blocked {
  border-color: color-mix(in srgb, var(--ui-warning) 55%, transparent);
}

.dark .pen__chip {
  color: var(--pen-tint);
  background: color-mix(in srgb, var(--pen-tint) 15%, transparent);
}

.dark .pen__rounds i {
  background: rgba(255, 255, 255, 0.08);
}

.dark .pen__rounds i.is-done {
  background: linear-gradient(90deg, #6fae5a, var(--ui-primary));
}

.dark .pen__foot {
  border-top-color: rgba(255, 255, 255, 0.08);
}
</style>
