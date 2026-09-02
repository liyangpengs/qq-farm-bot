<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  land: any
  selectable?: boolean
  selected?: boolean
  selectionDisabled?: boolean
  selectionLabel?: string
  showFertilizerActions?: boolean
  fertilizerPending?: boolean
  normalFertilizerDisabled?: boolean
  organicFertilizerDisabled?: boolean
  organicFertilizerLabel?: string
  showFarmingAction?: boolean
  farmingPending?: boolean
  farmingDisabled?: boolean
}>(), {
  selectable: false,
  selected: false,
  selectionDisabled: false,
  selectionLabel: '',
  showFertilizerActions: false,
  fertilizerPending: false,
  normalFertilizerDisabled: false,
  organicFertilizerDisabled: false,
  organicFertilizerLabel: '',
  showFarmingAction: false,
  farmingPending: false,
  farmingDisabled: false,
})

const emit = defineEmits<{
  select: [land: any]
  fertilize: [land: any, fertilizerType: 'normal' | 'organic']
  farm: [land: any]
}>()

const land = computed(() => props.land)

// 上游资源已统一按变异 ID 命名；仍保留加载失败回退，兼容尚无 PNG 的变异。
const failedMutantIcons = ref(new Set<number>())

const mutantEffects = computed(() => {
  const effects = Array.isArray(land.value?.mutantEffects) ? land.value.mutantEffects : []
  if (effects.length > 0) {
    return effects
      .map((effect: any) => ({
        id: Number(effect?.id) || 0,
        name: String(effect?.name || effect?.effect_name || '').trim(),
        icon: String(effect?.icon || '').trim(),
        description: String(effect?.description || effect?.desc || effect?.tips || '').trim(),
      }))
      .filter((effect: { name: string }) => !!effect.name)
  }
  const ids = Array.isArray(land.value?.mutantConfigIds) ? land.value.mutantConfigIds : []
  return ids
    .map((id: any) => {
      const numericId = Number(id) || 0
      return {
        id: numericId,
        name: numericId > 0 ? `变异 #${numericId}` : '',
        icon: '',
        description: '',
      }
    })
    .filter((effect: { name: string }) => !!effect.name)
})

const purpleCrystalResonancePercent = computed(() => (
  Math.max(0, Number(land.value?.purpleCrystalResonanceExpBonus) || 0) / 100
))

const growProgress = computed(() => {
  const matureInSec = land.value.matureInSec || 0
  const totalGrowTime = land.value.totalGrowTime || 0

  if (totalGrowTime <= 0 || matureInSec <= 0) {
    return 0
  }

  const progress = Math.min(100, Math.max(0, (matureInSec / totalGrowTime) * 100))
  return progress
})

function getLandStatusClass(land: any) {
  const status = land.status
  const level = Number(land.level) || 0

  if (status === 'locked')
    return 'land-locked opacity-60 border-dashed border-gray-300 dark:border-gray-600'

  let baseClass = 'soil-level-0'

  // 土地等级样式 — soil texture classes
  switch (level) {
    case 1: // 普通土地
      baseClass = 'soil-level-1'
      break
    case 2: // 红土地
      baseClass = 'soil-level-2'
      break
    case 3: // 黑土地
      baseClass = 'soil-level-3'
      break
    case 4: // 金土地
      baseClass = 'soil-level-4'
      break
    case 5: // 紫金土地
      baseClass = 'soil-level-5'
      break
  }

  // 状态叠加
  if (status === 'dead')
    return 'land-dead border-gray-400 dark:border-gray-600 grayscale'

  if (status === 'harvestable')
    return `${baseClass} land-harvestable`

  if (status === 'stealable')
    return `${baseClass} land-stealable`

  if (status === 'growing')
    return baseClass

  return baseClass
}

function formatTime(sec: number) {
  if (sec <= 0)
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function getSafeImageUrl(url: string) {
  if (!url)
    return ''
  if (url.startsWith('http://'))
    return url.replace('http://', 'https://')
  return url
}

function getLandTypeName(level: number) {
  const typeMap: Record<number, string> = {
    0: '普通土地',
    1: '普通土地',
    2: '红土地',
    3: '黑土地',
    4: '金土地',
    5: '紫金土地',
  }
  return typeMap[Number(level) || 0] || ''
}
function getPlantSizeText(land: any) {
  const size = Number(land?.plantSize) || 1
  if (size <= 1)
    return ''
  return `${size}x${size}`
}

function landTypeBadgeClass(level: number) {
  const lv = Number(level) || 0
  const map: Record<number, string> = {
    0: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    1: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    2: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    3: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    4: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    5: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  }
  return map[lv] || map[0]
}

function activateSelection() {
  if (props.selectable && !props.selectionDisabled)
    emit('select', props.land)
}

function requestFertilize(event: Event, fertilizerType: 'normal' | 'organic') {
  event.stopPropagation()
  if (props.fertilizerPending)
    return
  if (fertilizerType === 'normal' && props.normalFertilizerDisabled)
    return
  if (fertilizerType === 'organic' && props.organicFertilizerDisabled)
    return
  emit('fertilize', props.land, fertilizerType)
}

function requestFarming(event: Event) {
  event.stopPropagation()
  if (!props.farmingPending && !props.farmingDisabled)
    emit('farm', props.land)
}

const organicRemainingText = computed(() => {
  const left = land.value?.leftInorcFertTimes
  if (left == null || Number.isNaN(Number(left)))
    return ''
  return `有机剩 ${Math.max(0, Number(left))}`
})

function interactionEffectBadges(land: any) {
  const effects = Array.isArray(land?.interactionEffects) ? land.interactionEffects : []
  const seen = new Set<string>()
  return effects
    .filter((effect: any) => effect?.confirmed && effect?.itemId)
    .map((effect: any) => ({
      itemId: String(effect.itemId),
      name: String(effect.itemName || `道具${effect.itemId}`),
      title: `${String(effect.itemName || `道具${effect.itemId}`)}：已生效`,
    }))
    .filter((effect: any) => {
      if (seen.has(effect.itemId))
        return false
      seen.add(effect.itemId)
      return true
    })
}

function interactionBadgeClass(itemId: string) {
  if (itemId === '301101')
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
  if (itemId === '301102')
    return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
  if (itemId === '301103')
    return 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300'
  if (itemId === '5006')
    return 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200'
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
}

function mutantBadgeClass(effect: { icon?: string }) {
  const icon = String(effect?.icon || '').toLowerCase()
  const map: Record<string, string> = {
    golden: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    frozen: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    ice: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    snow: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    love: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300',
    dark: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
    moist: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
    haha: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    tata: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    lotus: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    moon: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
    mian: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
    crystal: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
    desert: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    lucky: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300',
    luxury: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
    shinning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    lightning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    butterfly: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
  }
  return map[icon] || 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300'
}

function mutantIconUrl(id: number) {
  const numericId = Number(id) || 0
  return numericId > 0 ? `/game-config/seed_images_named/mutant/${numericId}.png` : ''
}

function mutantIconName(effect: { icon?: string }) {
  return String(effect?.icon || '').trim().toLowerCase()
}

function showMutantImage(effect: { id?: number }) {
  const id = Number(effect?.id) || 0
  return id > 0 && !failedMutantIcons.value.has(id)
}

function markMutantIconFailed(effect: { id?: number }) {
  const id = Number(effect?.id) || 0
  if (id > 0)
    failedMutantIcons.value = new Set(failedMutantIcons.value).add(id)
}
</script>

<template>
  <div
    class="land-card relative min-h-[160px] flex flex-col items-center border-2 cartoon-card rounded-2xl p-3 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5"
    :class="[
      getLandStatusClass(land),
      {
        'land-card--selectable': selectable,
        'land-card--selected': selected,
        'land-card--selection-disabled': selectable && selectionDisabled,
      },
    ]"
    :role="selectable ? 'button' : undefined"
    :tabindex="selectable && !selectionDisabled ? 0 : undefined"
    :aria-pressed="selectable ? selected : undefined"
    :aria-disabled="selectable ? selectionDisabled : undefined"
    @click="activateSelection"
    @keydown.enter.prevent="activateSelection"
    @keydown.space.prevent="activateSelection"
  >
    <!-- Land ID badge -->
    <div class="absolute left-2 top-2 text-[10px] font-display font-mono opacity-50">
      #{{ land.id }}
    </div>

    <div
      v-if="selectable"
      class="selection-cue absolute right-2 top-2"
      :class="selected ? 'selection-cue--selected' : selectionDisabled ? 'selection-cue--disabled' : 'selection-cue--ready'"
      :title="selectionLabel || (selected ? '已选择' : selectionDisabled ? '不可选择' : '点击选择')"
    >
      <span class="selection-cue__mark">
        <span v-if="selected" class="i-carbon-checkmark" />
        <span v-else-if="selectionDisabled" class="i-carbon-subtract" />
      </span>
      <span v-if="selectionLabel" class="selection-cue__label">{{ selectionLabel }}</span>
    </div>

    <!-- Plant size badge (joint planting) -->
    <div
      v-if="land.plantSize > 1"
      class="absolute right-2 rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] text-pink-700 font-bold shadow-sm dark:bg-pink-900/30 dark:text-pink-300"
      :class="selectable ? 'top-8' : 'top-2'"
    >
      合种 {{ getPlantSizeText(land) }}
    </div>

    <!-- Plant image with growth animation -->
    <div
      class="plant-container mb-1 mt-5 h-12 w-12 flex items-center justify-center"
      :class="{ 'animate-plant-grow': land.matureInSec > 0 }"
    >
      <img
        v-if="land.seedImage"
        :src="getSafeImageUrl(land.seedImage)"
        class="max-h-full max-w-full object-contain drop-shadow-sm"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
      <span v-else class="i-carbon-sprout text-2xl opacity-30" />
    </div>

    <!-- Plant name -->
    <div class="w-full truncate px-1 text-center text-xs font-bold" :title="land.plantName">
      {{ land.plantName || '-' }}
    </div>

    <!-- Time/status line -->
    <div class="mb-0.5 mt-0.5 w-full text-center text-[10px]">
      <span v-if="land.matureInSec > 0" class="text-orange-600 font-bold dark:text-orange-400">
        <span class="i-carbon-time inline-block align-[-1px]" /> {{ formatTime(land.matureInSec) }}
      </span>
      <span v-else class="text-gray-500">
        {{ land.phaseName || (land.status === 'locked' ? '未解锁' : '未开垦') }}
      </span>
    </div>

    <!-- Cartoon progress bar -->
    <div v-if="land.matureInSec > 0 && land.totalGrowTime > 0" class="w-full px-2">
      <div class="farm-progress">
        <div
          class="farm-progress-fill"
          :style="{ width: `${growProgress}%` }"
        />
      </div>
    </div>

    <!-- Land type and season info -->
    <div class="mt-0.5 flex items-center gap-1.5 text-[10px]">
      <span class="rounded-full px-1.5 py-0.5 font-display" :class="landTypeBadgeClass(land.level)">
        {{ getLandTypeName(land.level) }}
      </span>
      <span class="text-gray-400">
        季 {{ land.totalSeason > 0 ? (`${land.currentSeason}/${land.totalSeason}`) : '-/-' }}
      </span>
    </div>

    <!-- Status Badges (game-style) -->
    <div class="mt-auto flex flex-wrap items-center justify-center gap-1 pt-1">
      <span
        v-if="purpleCrystalResonancePercent > 0"
        class="badge-purple-crystal inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        :title="`紫金土地上的任意变异作物经验 +${purpleCrystalResonancePercent}%`"
      >
        <span class="i-carbon-flash-filled" /> 紫晶共鸣
      </span>
      <span
        v-for="effect in mutantEffects"
        :key="effect.id || effect.name"
        class="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        :class="mutantBadgeClass(effect)"
        :title="effect.description || effect.name"
      >
        <img
          v-if="showMutantImage(effect)"
          :src="mutantIconUrl(effect.id)"
          :alt="effect.name"
          class="h-3 w-3 object-contain"
          @error="markMutantIconFailed(effect)"
        >
        <span v-else-if="mutantIconName(effect) === 'lightning'" class="i-carbon-lightning" />
        <span v-else-if="mutantIconName(effect) === 'butterfly'" class="i-carbon-bee" />
        <span v-else class="i-carbon-star" />
        {{ effect.name }}
      </span>
      <span
        v-for="effect in interactionEffectBadges(land)"
        :key="effect.itemId"
        class="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        :class="interactionBadgeClass(effect.itemId)"
        :title="effect.title"
      >
        <span class="i-carbon-checkmark-outline" /> {{ effect.name }}
      </span>
      <span
        v-if="land.needWater"
        class="badge-water inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
      >
        <span class="i-carbon-rain-drop" /> 缺水
      </span>
      <span
        v-if="land.needWeed"
        class="inline-flex items-center gap-0.5 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 font-bold dark:bg-green-900/40 dark:text-green-300"
      >
        <span class="i-carbon-clean" /> 杂草
      </span>
      <span
        v-if="land.needBug"
        class="badge-bug inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
      >
        <span class="i-carbon-debug" /> 虫害
      </span>
      <span
        v-if="land.status === 'harvestable'"
        class="badge-harvest inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
      >
        <span class="i-carbon-wheat" /> 收获
      </span>
      <span
        v-if="land.status === 'stealable'"
        class="inline-flex items-center gap-0.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700 font-bold dark:bg-purple-900/40 dark:text-purple-300"
      >
        <span class="i-carbon-touch-1" /> 可偷
      </span>
      <span
        v-if="land.status === 'harvested'"
        class="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700 font-bold dark:bg-gray-700 dark:text-gray-200"
      >
        <span class="i-carbon-wheat" /> 成熟不可偷
      </span>
      <span
        v-if="showFertilizerActions && organicRemainingText"
        class="inline-flex items-center gap-0.5 rounded-full bg-lime-100 px-1.5 py-0.5 text-[10px] text-lime-800 font-bold dark:bg-lime-900/40 dark:text-lime-300"
      >
        <span class="i-carbon-chemistry" /> {{ organicRemainingText }}
      </span>
    </div>

    <div v-if="showFarmingAction" class="farming-action-wrap mt-2 w-full" @click.stop>
      <button
        type="button"
        class="farming-action"
        :disabled="farmingPending || farmingDisabled"
        title="清理该地块的缺水、杂草、虫害或乌云，并同时处理农场中的青蛙"
        @click="requestFarming"
      >
        <span v-if="farmingPending" class="i-svg-spinners-90-ring-with-bg" />
        <span v-else class="i-carbon-clean" />
        务农
      </button>
    </div>

    <div v-if="showFertilizerActions" class="fertilizer-actions mt-2 w-full" @click.stop>
      <button
        type="button"
        class="fertilizer-action fertilizer-action--normal"
        :disabled="fertilizerPending || normalFertilizerDisabled"
        title="对该地块施一次普通化肥"
        @click="requestFertilize($event, 'normal')"
      >
        <span v-if="fertilizerPending" class="i-svg-spinners-90-ring-with-bg" />
        <span v-else class="i-carbon-chemistry" />
        普通
      </button>
      <button
        type="button"
        class="fertilizer-action fertilizer-action--organic"
        :disabled="fertilizerPending || organicFertilizerDisabled"
        :title="organicFertilizerDisabled ? (organicFertilizerLabel || '已无法再施有机肥') : '对该地块施一次有机化肥'"
        @click="requestFertilize($event, 'organic')"
      >
        <span v-if="fertilizerPending" class="i-svg-spinners-90-ring-with-bg" />
        <span v-else class="i-carbon-sprout" />
        有机
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Land colors stay independent from the shared glass-card surface. */
.land-card {
  border-width: 2px;
  border-radius: 8px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.38),
    0 8px 20px rgba(40, 48, 44, 0.12);
}
.land-card--selectable {
  cursor: pointer;
  user-select: none;
}
.land-card--selectable:focus-visible {
  outline: 3px solid rgba(37, 116, 88, 0.34);
  outline-offset: 3px;
}
.land-card--selected {
  border-color: #257458 !important;
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.72),
    0 0 0 3px rgba(37, 116, 88, 0.2),
    0 12px 24px rgba(37, 116, 88, 0.18) !important;
  transform: translateY(-2px);
}
.land-card--selection-disabled {
  cursor: not-allowed;
  filter: saturate(0.65);
  opacity: 0.72;
}
.selection-cue {
  z-index: 2;
  min-height: 22px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  pointer-events: none;
  line-height: 1.1;
}
.selection-cue--ready {
  color: #257458;
}
.selection-cue--selected {
  color: #257458;
}
.selection-cue--disabled {
  color: #7d8782;
}
.selection-cue__mark {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1.5px solid currentColor;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 2px 7px rgba(40, 62, 53, 0.14);
}
.selection-cue__mark > span {
  font-size: 15px;
}
.selection-cue--selected .selection-cue__mark {
  color: #fff;
  border-color: #257458;
  background: #257458;
}
.selection-cue--disabled .selection-cue__mark {
  color: #7d8782;
  border-color: #aab2ae;
  background: rgba(239, 242, 240, 0.96);
}
.selection-cue__label {
  padding: 4px 7px;
  border: 1px solid rgba(37, 116, 88, 0.24);
  border-radius: 999px;
  color: #245f4b;
  background: rgba(244, 252, 247, 0.96);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: 0 2px 7px rgba(40, 62, 53, 0.1);
}
.selection-cue--disabled .selection-cue__label {
  border-color: rgba(109, 119, 114, 0.22);
  color: #69736e;
  background: rgba(239, 242, 240, 0.96);
}

.land-card:hover:not(.land-card--selection-disabled):not(.land-card--selected) {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    0 12px 26px rgba(40, 48, 44, 0.16);
  transform: translateY(-1px);
}

/* ===== Soil Texture Backgrounds by Level ===== */
.soil-level-0 {
  background: linear-gradient(180deg, #f5f0e8 0%, #e8dcc8 60%, #d4c4a0 100%);
  border-color: #c9b88a;
}
.soil-level-1 {
  /* 普通土地 */
  background: linear-gradient(180deg, #f5f0e8 0%, #e8dcc8 60%, #d4c4a0 100%);
  border-color: #c9b88a;
}
.soil-level-2 {
  /* 红土地 — reddish-brown */
  background:
    radial-gradient(ellipse at 30% 70%, rgba(180, 80, 40, 0.2) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 25%, rgba(160, 60, 30, 0.15) 0%, transparent 45%),
    linear-gradient(180deg, #e8b09a 0%, #c87850 45%, #a85830 100%);
  border-color: #984828;
}
.soil-level-3 {
  /* 黑土地 — dark rich soil */
  background:
    radial-gradient(ellipse at 25% 75%, rgba(40, 40, 40, 0.3) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(60, 50, 40, 0.2) 0%, transparent 45%),
    linear-gradient(180deg, #6b6058 0%, #4a3f35 45%, #2e2520 100%);
  border-color: #3a2f25;
  color: #e8e0d8;
}
.soil-level-4 {
  /* 金土地 — golden shimmer */
  background:
    radial-gradient(ellipse at 30% 60%, rgba(255, 215, 0, 0.35) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 30%, rgba(255, 200, 50, 0.25) 0%, transparent 45%),
    linear-gradient(180deg, #fff0b0 0%, #f0d060 45%, #d4a820 100%);
  border-color: #c09818;
}
.soil-level-5 {
  /* 紫金土地 — purple-gold shimmer */
  background:
    radial-gradient(ellipse at 25% 65%, rgba(168, 85, 247, 0.3) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 30%, rgba(255, 215, 0, 0.3) 0%, transparent 45%),
    linear-gradient(180deg, #f0e0ff 0%, #d4a8f0 30%, #c084fc 60%, #a855f7 100%);
  border-color: #9333ea;
}

.land-locked {
  background: linear-gradient(180deg, #e8e8e8 0%, #d0d0d0 100%);
}
.land-dead {
  background: linear-gradient(180deg, #b0b0b0 0%, #888888 100%);
}

/* ===== Level-specific border accents ===== */
.soil-level-1 {
  border-color: #c9b88a;
}
.soil-level-2 {
  border-color: #984828;
}
.soil-level-3 {
  border-color: #5a4f45;
}
.soil-level-4 {
  border-color: #c09818;
}
.soil-level-5 {
  border-color: #9333ea;
}

/* ===== Harvestable / Stealable highlights — 增强发光效果 ===== */
.land-harvestable {
  box-shadow:
    0 0 0 3px #f0c040,
    0 0 16px rgba(240, 192, 64, 0.35),
    0 3px 0 rgba(0, 0, 0, 0.15);
}

@keyframes pulse-glow-gold {
  0%,
  100% {
    box-shadow:
      0 0 0 3px #f0c040,
      0 0 12px rgba(240, 192, 64, 0.3),
      0 3px 0 rgba(0, 0, 0, 0.15);
  }
  50% {
    box-shadow:
      0 0 0 4px #f0c040,
      0 0 24px rgba(240, 192, 64, 0.5),
      0 3px 0 rgba(0, 0, 0, 0.15);
  }
}

.land-stealable {
  box-shadow:
    0 0 0 3px #a855f7,
    0 0 16px rgba(168, 85, 247, 0.35),
    0 3px 0 rgba(0, 0, 0, 0.15);
}

/* ===== Plant Growth Animation ===== */
.animate-plant-grow {
  animation: plant-grow 0.45s ease-out both;
}

.land-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 160px;
}

@keyframes plant-grow {
  0% {
    transform: scale(0.96) translateY(2px);
    opacity: 0.75;
  }
  100% {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
}

/* ===== Golden shimmer for level 4 ===== */
@keyframes golden-shimmer {
  0%,
  100% {
    box-shadow:
      0 0 8px rgba(255, 215, 0, 0.2),
      var(--theme-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.08));
  }
  50% {
    box-shadow:
      0 0 16px rgba(255, 215, 0, 0.4),
      0 0 32px rgba(255, 215, 0, 0.15),
      var(--theme-shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
  }
}

@keyframes purple-gold-shimmer {
  0%,
  100% {
    box-shadow:
      0 0 8px rgba(168, 85, 247, 0.2),
      0 0 4px rgba(255, 215, 0, 0.15),
      var(--theme-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.08));
  }
  50% {
    box-shadow:
      0 0 16px rgba(168, 85, 247, 0.4),
      0 0 24px rgba(255, 215, 0, 0.2),
      var(--theme-shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
  }
}

/* ===== Cartoon Progress Bar (farm-progress) ===== */
.farm-progress {
  width: 100%;
  height: 10px;
  background: linear-gradient(180deg, #d4c8a0 0%, #c0b080 100%);
  border-radius: var(--theme-radius-md, 8px);
  overflow: hidden;
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.15),
    0 1px 2px rgba(255, 255, 255, 0.3);
  position: relative;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.farm-progress::before {
  content: '';
  position: absolute;
  top: 1px;
  left: 2px;
  right: 2px;
  height: 3px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.15));
  border-radius: 6px 6px 0 0;
  pointer-events: none;
  z-index: 1;
}

.farm-progress-fill {
  height: 100%;
  background: linear-gradient(180deg, #6dd400 0%, #44a800 40%, #2d8000 100%);
  border-radius: var(--theme-radius-md, 8px);
  transition: width 1s linear;
  position: relative;
  box-shadow:
    inset 0 1px 3px rgba(255, 255, 255, 0.4),
    inset 0 -1px 2px rgba(0, 0, 0, 0.15);
}

.farm-progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.35) 50%, transparent 100%);
  border-radius: var(--theme-radius-md, 8px);
}

@keyframes progress-shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(200%);
  }
}

/* ===== Status Badge Animations ===== */

/* Water drop animation */
.badge-water {
  background: linear-gradient(135deg, #e0f2fe, #bae6fd);
  color: #0369a1;
  animation: water-drop 1.5s ease-in-out infinite;
}
.dark .badge-water {
  background: rgba(56, 189, 248, 0.2);
  color: #7dd3fc;
}

@keyframes water-drop {
  0%,
  100% {
    transform: translateY(0) scale(1);
  }
  30% {
    transform: translateY(-3px) scale(1.1);
  }
  50% {
    transform: translateY(1px) scale(0.95);
  }
  70% {
    transform: translateY(-1px) scale(1.02);
  }
}

/* Bug wiggle animation */
.badge-bug {
  background: linear-gradient(135deg, #fee2e2, #fecaca);
  color: #dc2626;
  animation: cartoon-wiggle 0.6s ease-in-out infinite;
}
.dark .badge-bug {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

@keyframes cartoon-wiggle {
  0%,
  100% {
    transform: rotate(0deg);
  }
  20% {
    transform: rotate(-8deg);
  }
  40% {
    transform: rotate(8deg);
  }
  60% {
    transform: rotate(-5deg);
  }
  80% {
    transform: rotate(5deg);
  }
}

/* Harvest sparkle animation */
.badge-harvest {
  background: linear-gradient(135deg, #fef9c3, #fde68a);
  color: #b45309;
  animation: sparkle 1.2s ease-in-out infinite;
}
.dark .badge-harvest {
  background: rgba(245, 158, 11, 0.2);
  color: #fcd34d;
}

@keyframes sparkle {
  0%,
  100% {
    transform: scale(1);
    filter: brightness(1);
  }
  25% {
    transform: scale(1.15);
    filter: brightness(1.2);
  }
  50% {
    transform: scale(1);
    filter: brightness(1);
  }
  75% {
    transform: scale(1.1);
    filter: brightness(1.15);
  }
}

/* ===== Dark mode soil adjustments ===== */
@media all {
  :global(.dark) .soil-level-0 {
    background: linear-gradient(180deg, #3a3530 0%, #2e2820 100%);
    border-color: #555;
  }
  :global(.dark) .soil-level-1 {
    background:
      radial-gradient(ellipse at 20% 80%, rgba(200, 160, 60, 0.12) 0%, transparent 50%),
      linear-gradient(180deg, #5a4a20 0%, #4a3a18 100%);
    border-color: #7a6a30;
  }
  :global(.dark) .soil-level-2 {
    background:
      radial-gradient(ellipse at 30% 70%, rgba(180, 80, 40, 0.12) 0%, transparent 50%),
      linear-gradient(180deg, #5a2818 0%, #4a1810 100%);
    border-color: #7a3828;
  }
  :global(.dark) .soil-level-3 {
    background:
      radial-gradient(ellipse at 25% 75%, rgba(40, 40, 40, 0.3) 0%, transparent 50%),
      linear-gradient(180deg, #2a2018 0%, #1a1008 100%);
    border-color: #4a3f35;
    color: #d8d0c8;
  }
  :global(.dark) .soil-level-4 {
    background:
      radial-gradient(ellipse at 30% 60%, rgba(255, 215, 0, 0.15) 0%, transparent 50%),
      linear-gradient(180deg, #5a4810 0%, #4a3808 100%);
    border-color: #8a7820;
  }
  :global(.dark) .soil-level-5 {
    background:
      radial-gradient(ellipse at 25% 65%, rgba(168, 85, 247, 0.15) 0%, transparent 50%),
      radial-gradient(ellipse at 70% 30%, rgba(255, 215, 0, 0.12) 0%, transparent 45%),
      linear-gradient(180deg, #3a1850 0%, #2a1040 100%);
    border-color: #7c3aed;
    color: #e0d0f0;
  }

  :global(.dark) .land-locked {
    background: linear-gradient(180deg, #2a2a2a 0%, #222 100%);
  }
  :global(.dark) .land-dead {
    background: linear-gradient(180deg, #3a3a3a 0%, #2a2a2a 100%);
  }

  :global(.dark) .farm-progress {
    background: linear-gradient(180deg, #3a3530 0%, #2e2820 100%);
  }
}

/* Pale land surfaces keep every level recognizable without the old heavy texture. */
.land-card {
  min-height: 176px;
  border-width: 1px;
  color: var(--ui-ink);
  box-shadow: var(--ui-shadow-sm);
}
.land-card:hover {
  box-shadow: var(--ui-shadow-md);
}
.soil-level-0 {
  border-color: #ddd8ca;
  background: #f8f6f0;
}
.soil-level-1 {
  border-color: #e7d49a;
  background: #fff8df;
}
.soil-level-2 {
  border-color: #e8b8ac;
  background: #fff0ed;
}
.soil-level-3 {
  border-color: #bcb8b1;
  color: var(--ui-ink);
  background: #efeeeb;
}
.soil-level-4 {
  border-color: #e7d46c;
  background: #fffbdc;
}
.soil-level-5 {
  border-color: #c9b9e6;
  color: var(--ui-ink);
  background: #f4effc;
}
.land-locked {
  border-color: #d6dbd5;
  background: #f0f2ef;
}
.land-dead {
  border-color: #c7cbc6;
  color: var(--ui-muted);
  background: #e7e9e6;
}
.land-harvestable {
  border-color: rgba(67, 141, 99, 0.48);
  box-shadow:
    inset 0 3px 0 var(--ui-primary),
    var(--ui-shadow-sm);
}
.land-stealable {
  border-color: rgba(143, 121, 188, 0.48);
  box-shadow:
    inset 0 3px 0 var(--ui-violet),
    var(--ui-shadow-sm);
}
.farm-progress {
  height: 6px;
  border: 0;
  background: rgba(113, 125, 116, 0.12);
  box-shadow: none;
}
.farm-progress::before,
.farm-progress-fill::after {
  display: none;
}
.farm-progress-fill {
  background: linear-gradient(90deg, #ef8ca0, #efc76f, #8acb8f, #75b8cf, #aa8bd0);
  box-shadow: none;
}
.badge-water,
.badge-bug,
.badge-harvest {
  animation: none;
}

.badge-purple-crystal {
  color: #6d3da0;
  border: 1px solid rgba(146, 103, 190, 0.35);
  background: linear-gradient(135deg, rgba(239, 225, 255, 0.96), rgba(218, 244, 255, 0.92));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
}

:global(.dark) .badge-purple-crystal {
  color: #e9d5ff;
  border-color: rgba(196, 151, 255, 0.34);
  background: linear-gradient(135deg, rgba(88, 49, 121, 0.58), rgba(33, 82, 102, 0.52));
}

.fertilizer-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.farming-action {
  width: 100%;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid #a9d4b0;
  border-radius: 8px;
  color: #245f4b;
  background: #eaf8ed;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.farming-action:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(.dark) .farming-action {
  color: #bbf7d0;
  border-color: rgba(169, 212, 176, 0.38);
  background: rgba(20, 80, 50, 0.35);
}

.fertilizer-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.fertilizer-action--normal {
  color: #5b4630;
  background: #fff4d6;
  border-color: #ead28a;
}

.fertilizer-action--organic {
  color: #245f4b;
  background: #e8f7ea;
  border-color: #b5dcb8;
}

.fertilizer-action:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(.dark) .fertilizer-action--normal {
  color: #fde68a;
  background: rgba(120, 90, 20, 0.35);
  border-color: rgba(234, 210, 138, 0.4);
}

:global(.dark) .fertilizer-action--organic {
  color: #bbf7d0;
  background: rgba(20, 80, 50, 0.35);
  border-color: rgba(181, 220, 184, 0.35);
}
</style>
