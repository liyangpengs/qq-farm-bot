<script setup lang="ts">
import { NButton, NCard, NModal, NProgress, NTab, NTabs } from 'naive-ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useIllustratedStore } from '@/stores/illustrated'

const accountStore = useAccountStore()
const illustratedStore = useIllustratedStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { data, loading, error } = storeToRefs(illustratedStore)
const currentType = ref<'crop' | 'mutant'>('crop')
const detailsOpen = ref(false)

const book = computed(() => data.value?.[currentType.value] || null)
const isConnected = computed(() => !!currentAccount.value?.running)
const collectedCount = computed(() => (Array.isArray(book.value?.items) ? book.value.items : []).filter((item: any) => item.unlocked).length)
const currentBonuses = computed(() => {
  const bonuses = Array.isArray(book.value?.attributeBonuses) ? book.value.attributeBonuses : []
  return bonuses.length ? bonuses : (book.value?.currentBonus ? [book.value.currentBonus] : [])
})
const illustratedBuffs = computed(() => Array.isArray(book.value?.buffs) ? book.value.buffs : [])
const currentIllustratedBuffs = computed(() => Array.isArray(book.value?.currentBuffs) ? book.value.currentBuffs : [])
const illustratedLevelMap = computed(() => new Map(
  (Array.isArray(book.value?.levels) ? book.value.levels : []).map((level: any) => [Number(level?.level) || 0, level]),
))
const formatBuffValue = (bonus: any) => {
  const value = Number(bonus?.value) || 0
  return bonus?.valueType === 'probability' ? `触发概率 ${value / 10}%` : `数量 +${value}`
}
const formatBuffLevelState = (bonus: any) => {
  if (Number(bonus?.level) <= Number(book.value?.level || 0))
    return '已达成'
  const level = illustratedLevelMap.value.get(Number(bonus?.level) || 0) as any
  return level?.progress ? `${level.progress} 进度` : '未达成'
}
const mutantGroups = computed(() => {
  const items = Array.isArray(book.value?.items) ? [...book.value.items].sort((a: any, b: any) => Number(a.sort || 0) - Number(b.sort || 0)) : []
  return [
    { key: 'gold', label: '黄金果实', items: items.filter((item: any) => item.group === 'gold') },
    { key: 'decoration', label: '装扮果实', items: items.filter((item: any) => item.group === 'decoration') },
    { key: 'activity', label: '活动果实', items: items.filter((item: any) => item.group === 'activity') },
  ]
})

function progressPercent(value: any, next: any) {
  const current = Math.max(0, Number(value) || 0)
  const target = Math.max(current, Number(next) || 0)
  return target > 0 ? Math.min(100, Math.round(current / target * 100)) : 0
}

async function refresh() {
  if (currentAccountId.value && isConnected.value)
    await illustratedStore.fetch(currentAccountId.value)
}

onMounted(refresh)
watch(currentAccountId, () => {
  illustratedStore.reset()
  void refresh()
})
watch(isConnected, refresh)
</script>

<template>
  <div class="space-y-5">
    <div class="cartoon-card rounded-2xl bg-white p-5 shadow-lg dark:bg-gray-800">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="flex items-center gap-2 text-xl font-bold font-display"><span class="i-carbon-book text-amber-600" /> 图鉴</h3>
          <p class="mt-1 text-sm text-gray-500">查看作物收藏、超变果实与图鉴属性加成</p>
        </div>
        <NButton secondary :loading="loading" :disabled="!currentAccountId || !isConnected" @click="refresh">
          <span class="i-carbon-renew mr-1" /> 刷新
        </NButton>
      </div>

      <NTabs v-model:value="currentType" type="segment" animated>
        <NTab name="crop">作物图鉴</NTab>
        <NTab name="mutant">超变图鉴</NTab>
      </NTabs>
    </div>

    <div v-if="!currentAccountId" class="cartoon-card rounded-2xl p-12 text-center text-gray-500 shadow-md">
      <span class="i-carbon-user-avatar mb-3 block text-5xl" /> 请先选择农场账号
    </div>
    <div v-else-if="!isConnected" class="cartoon-card rounded-2xl p-12 text-center text-gray-500 shadow-md">
      <span class="i-carbon-network-4 mb-3 block text-5xl" /> 请先启动账号
    </div>
    <div v-else-if="loading && !data" class="cartoon-card flex justify-center rounded-2xl p-12 shadow-md">
      <span class="i-svg-spinners-90-ring-with-bg text-4xl text-amber-500" />
    </div>
    <div v-else-if="error" class="cartoon-card rounded-2xl p-8 text-center text-red-600 shadow-md">
      <div>{{ error }}</div>
      <NButton class="mt-3" secondary type="error" @click="refresh">重试</NButton>
    </div>
    <template v-else-if="book">
      <section class="illustrated-progress rounded-2xl p-4">
        <div class="illustrated-progress__badge"><b>{{ book.level || 0 }}</b><small>等级</small></div>
        <div class="illustrated-progress__main">
          <div class="flex items-center justify-between gap-2">
            <strong>{{ currentType === 'mutant' ? '超变图鉴进度' : '作物图鉴进度' }}</strong>
            <div class="flex items-center gap-2"><span class="text-sm font-bold">{{ book.progress || 0 }} / {{ book.nextLevelProgress || '—' }}</span><NButton size="tiny" secondary @click="detailsOpen = true">详情</NButton></div>
          </div>
          <NProgress class="mt-2" type="line" status="success" :percentage="progressPercent(book.progress, book.nextLevelProgress)" :show-indicator="false" />
        </div>
      </section>

      <div v-if="currentType === 'mutant'" class="space-y-4">
        <div v-for="group in mutantGroups" :key="group.key" class="cartoon-card rounded-2xl bg-white p-5 shadow-lg dark:bg-gray-800">
          <h4 class="mb-3 text-lg font-bold">{{ group.label }} <span class="text-sm text-gray-400">({{ group.items.length }})</span></h4>
          <div v-if="group.items.length" class="grid grid-cols-4 gap-2 md:grid-cols-5 lg:grid-cols-6">
            <div v-for="item in group.items" :key="item.seedId" class="rounded-xl border p-3" :class="item.unlocked ? 'border-amber-300 bg-amber-50/50 dark:bg-amber-950/20' : 'border-gray-200 opacity-55 dark:border-gray-700'">
              <img v-if="item.image" :src="item.image" alt="" class="mx-auto h-10 w-10 object-contain sm:h-12 sm:w-12">
              <div class="mt-1 truncate text-center text-xs font-medium">{{ item.name }}</div>
              <div class="text-center text-xs text-gray-500">{{ item.unlocked ? '已解锁' : '未解锁' }}</div>
            </div>
          </div>
          <div v-else class="text-sm text-gray-400">暂无记录</div>
        </div>
      </div>
      <div v-else class="cartoon-card rounded-2xl bg-white p-5 shadow-lg dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between"><h4 class="text-lg font-bold">作物图鉴</h4><span class="text-sm text-gray-500">已收藏 {{ collectedCount }} / {{ book.items?.length || 0 }}</span></div>
        <div class="grid grid-cols-4 gap-2 md:grid-cols-5 lg:grid-cols-6">
          <div v-for="item in book.items" :key="item.seedId" class="rounded-xl border p-3" :class="item.unlocked ? 'border-green-300 bg-green-50/50 dark:bg-green-950/20' : 'border-gray-200 opacity-55 dark:border-gray-700'">
            <img v-if="item.image" :src="item.image" alt="" class="mx-auto h-10 w-10 object-contain sm:h-12 sm:w-12">
            <div class="mt-1 truncate text-center text-xs font-medium">{{ item.name }}</div>
            <div class="text-center text-xs text-gray-500">{{ item.unlocked ? '已收藏' : '未收藏' }}</div>
          </div>
        </div>
      </div>

      <NModal v-model:show="detailsOpen">
        <NCard :title="currentType === 'mutant' ? '超变图鉴属性加成' : '作物图鉴收藏奖励'" closable class="w-[calc(100vw-24px)] max-w-3xl" @close="detailsOpen = false">
          <template v-if="currentType === 'mutant'">
            <div class="mb-4 rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
              <div class="mb-2 text-sm font-semibold">当前加成</div>
              <div v-if="currentIllustratedBuffs.length" class="flex flex-wrap gap-2">
                <span v-for="bonus in currentIllustratedBuffs" :key="`current-buff-${bonus.id}`" class="rounded-lg bg-white px-2 py-1 text-sm dark:bg-gray-900">{{ bonus.name }}：{{ formatBuffValue(bonus) }}</span>
              </div>
              <div v-else class="text-sm text-gray-500">暂无当前加成</div>
            </div>
            <div v-if="illustratedBuffs.length" class="grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              <div v-for="bonus in illustratedBuffs" :key="`all-buff-${bonus.id}`" class="rounded-xl border p-3" :class="bonus.level <= (book.level || 0) ? 'border-green-300 bg-green-50/50 dark:bg-green-950/20' : 'border-gray-200 dark:border-gray-700'">
                <div class="flex items-center justify-between text-sm">
                  <span class="font-semibold">Lv.{{ bonus.level }}</span>
                  <span :class="bonus.level <= (book.level || 0) ? 'text-green-600' : 'text-gray-400'">{{ formatBuffLevelState(bonus) }}</span>
                </div>
                <div class="mt-2 flex flex-wrap gap-1">
                  <span class="rounded bg-white/80 px-1.5 py-0.5 text-xs dark:bg-gray-900/50">{{ bonus.name }} · {{ formatBuffValue(bonus) }}</span>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-gray-500">暂无属性加成</div>
          </template>
          <div v-else class="mb-4 rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
            <div class="mb-2 text-sm font-semibold">当前加成</div>
            <div v-if="currentBonuses.length" class="flex flex-wrap gap-2"><span v-for="bonus in currentBonuses" :key="bonus.itemId" class="rounded-lg bg-white px-2 py-1 text-sm dark:bg-gray-900">{{ bonus.name }} +{{ bonus.count }}</span></div>
            <div v-else class="text-sm text-gray-500">暂无当前加成</div>
          </div>
          <div v-if="currentType !== 'mutant'" class="grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
            <div v-for="level in book.levels" :key="level.level" class="rounded-xl border p-3" :class="level.level <= (book.level || 0) ? 'border-green-300 bg-green-50/50 dark:bg-green-950/20' : 'border-gray-200 dark:border-gray-700'">
              <div class="flex items-center justify-between text-sm"><span class="font-semibold">Lv.{{ level.level }}</span><span :class="level.level <= (book.level || 0) ? 'text-green-600' : 'text-gray-400'">{{ level.level <= (book.level || 0) ? '已达成' : `${level.progress} 进度` }}</span></div>
              <div v-if="level.rewards?.length" class="mt-2 flex flex-wrap gap-1"><span v-for="reward in level.rewards" :key="`${level.level}-${reward.itemId}`" class="rounded bg-white/80 px-1.5 py-0.5 text-xs dark:bg-gray-900/50">{{ reward.name }} ×{{ reward.count }}</span></div>
            </div>
          </div>
        </NCard>
      </NModal>
    </template>
  </div>
</template>

<style scoped>
.illustrated-progress {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  color: #263d36;
  border: 1px solid rgba(42, 112, 86, 0.18);
  background: rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 30px rgba(40, 74, 61, 0.08), inset 0 1px rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(16px);
}
.illustrated-progress__badge { width: 58px; height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid rgba(38, 129, 94, 0.16); border-radius: 14px; color: #1f7453; background: rgba(226, 245, 237, 0.9); }
.illustrated-progress__badge b { font-size: 25px; line-height: 1; }
.illustrated-progress__badge small { font-size: 10px; }
.illustrated-progress__main { min-width: 0; }
.illustrated-progress__main strong { color: #263d36; }
:global(.dark) .illustrated-progress { color: #d8e7e1; border-color: rgba(116, 174, 151, 0.2); background: rgba(31, 41, 55, 0.78); box-shadow: inset 0 1px rgba(255, 255, 255, 0.04); }
:global(.dark) .illustrated-progress__badge { color: #9bd9bd; border-color: rgba(116, 174, 151, 0.22); background: rgba(45, 91, 73, 0.48); }
:global(.dark) .illustrated-progress__main strong { color: #e5eee9; }
@media (max-width: 520px) { .illustrated-progress { grid-template-columns: 54px minmax(0, 1fr); gap: 8px; padding: 12px; } }
</style>
