<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api, { getApiErrorMessage } from '@/api'
import CollectionRulesPopover from '@/components/CollectionRulesPopover.vue'
import BookSection from '@/components/illustrated/BookSection.vue'
import BookTile from '@/components/illustrated/BookTile.vue'
import BookToolbar from '@/components/illustrated/BookToolbar.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { vLazySrc } from '@/directives/lazy-src'

interface Mutation { id: number, name: string, image: string, effect: string, description: string, probabilities: Array<{ rarity: number | null, percent: number }> }
interface Series { id: number, name: string, rarity?: number, rarityName: string, description: string, mutationRules: Array<{ name: string, probability: number, guarantee: number }>, items: Array<{ id: number, name: string, image: string }> }

const router = useRouter()
const tab = ref('normal')
const query = ref('')
const catalog = ref<{ normal: Mutation[], decoration: Mutation[], collections: Series[] } | null>(null)
const loading = ref(false)
const error = ref('')
const rarityNames = ['', '普通', '稀有', '珍品', '天工']
const RARITY_COLORS: Record<number, string> = { 1: 'var(--ui-primary)', 2: 'var(--ui-blue)', 3: 'var(--ui-violet)', 4: 'var(--ui-warning)' }

const tabs = computed(() => [
  { value: 'normal', label: '常规变异', count: catalog.value?.normal.length },
  { value: 'decoration', label: '装扮变异', count: catalog.value?.decoration.length },
  { value: 'collections', label: '藏品变异', count: catalog.value?.collections.length },
])
const keyword = computed(() => query.value.trim())
const effects = computed(() => {
  if (tab.value === 'collections')
    return []
  return (catalog.value?.[tab.value as 'normal' | 'decoration'] || []).filter(effect => !keyword.value || `${effect.name}${effect.effect}${effect.description}`.includes(keyword.value))
})
const series = computed(() => (catalog.value?.collections || []).map(entry => ({
  ...entry,
  items: entry.items.filter(item => !keyword.value || `${item.name} ${entry.name}`.includes(keyword.value)),
})).filter(entry => entry.items.length))

function seriesColor(entry: Series) {
  const rarity = entry.rarity || rarityNames.indexOf(entry.rarityName)
  return RARITY_COLORS[rarity] || 'var(--ui-primary)'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await api.get('/api/illustrated/mutations', { skipErrorToast: true } as any)
    if (!response.data?.ok)
      throw new Error(response.data?.error || '变异宝典读取失败')
    catalog.value = response.data.data
  }
  catch (cause) {
    error.value = getApiErrorMessage(cause, '变异宝典读取失败')
  }
  finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<template>
  <div class="book-page">
    <EmptyState v-if="error" title="变异宝典读取失败" :description="error" tone="error" icon="i-carbon-warning-alt">
      <NButton secondary @click="load">
        重新读取
      </NButton>
    </EmptyState>
    <div v-else-if="loading && !catalog" class="book-loading" role="status" aria-label="正在读取变异宝典">
      <span class="i-svg-spinners-90-ring-with-bg" />
    </div>
    <template v-else-if="catalog">
      <BookToolbar v-model:filter="tab" v-model:query="query" :filters="tabs" label="变异宝典分类" :placeholder="tab === 'collections' ? '搜索藏品或系列' : '搜索变异或效果'" />

      <template v-if="tab !== 'collections'">
        <!-- 列表而非卡片网格：条目字段固定，按列对齐后不会因缺少概率行而留白。 -->
        <ul v-if="effects.length" class="mutation-list">
          <li v-for="effect in effects" :key="effect.id" class="mutation-row">
            <span class="mutation-row__well"><img v-if="effect.image" v-lazy-src="effect.image" alt="" loading="lazy" decoding="async"></span>
            <div class="mutation-row__main">
              <h3>{{ effect.name }}</h3>
              <p>{{ effect.description || '—' }}</p>
            </div>
            <div class="mutation-row__odds" :aria-label="`${effect.name}变异概率`">
              <template v-if="effect.probabilities.length">
                <span v-for="probability in effect.probabilities" :key="probability.rarity || 0">
                  {{ probability.rarity ? rarityNames[probability.rarity] : '触发' }}<b>{{ probability.percent }}%</b>
                </span>
              </template>
              <span v-else class="is-empty">—</span>
            </div>
            <span class="mutation-row__effect" :title="effect.effect">{{ effect.effect }}</span>
          </li>
        </ul>
        <EmptyState v-else bare title="没有符合条件的变异" description="换个搜索词试试" icon="i-carbon-search" />
      </template>

      <template v-else>
        <div class="mutation-intro">
          <span><span class="i-carbon-information" aria-hidden="true" /> 种在蓝晶土地上的作物有概率变异为藏品，各系列概率与保底次数见标题旁的问号。</span>
          <NButton size="small" secondary @click="router.replace({ query: { tab: 'collection' } })">
            查看我的藏品
          </NButton>
        </div>
        <BookSection
          v-for="entry in series"
          :key="entry.id"
          :title="entry.name"
          :tag="entry.rarityName"
          :count="`${entry.items.length} 款`"
          :description="entry.description"
          :accent="seriesColor(entry)"
        >
          <template #title-extra>
            <CollectionRulesPopover :title="entry.name" :rules="entry.mutationRules" />
          </template>
          <BookTile v-for="item in entry.items" :key="item.id" :name="item.name" :image="item.image" />
        </BookSection>
        <EmptyState v-if="!series.length" bare title="没有符合条件的藏品" description="换个搜索词试试" icon="i-carbon-search" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.book-page {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
}

.book-loading {
  display: grid;
  min-height: 240px;
  place-items: center;
  color: var(--ui-primary);
  font-size: 28px;
}

.mutation-list {
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  list-style: none;
}

.mutation-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) minmax(0, 240px) 128px;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
}

.mutation-row + .mutation-row {
  border-top: 1px solid var(--ui-border);
}

.mutation-row__well {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 11px;
  background: var(--ui-surface-soft);
}

.mutation-row__well img {
  width: 74%;
  height: 74%;
  object-fit: contain;
}

.mutation-row__main {
  min-width: 0;
}

.mutation-row__main h3 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  line-height: 20px;
}

.mutation-row__main p {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mutation-row__odds {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mutation-row__odds > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border-radius: 6px;
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
  font-size: 11px;
  line-height: 20px;
}

.mutation-row__odds > .is-empty {
  padding: 0;
  background: transparent;
}

.mutation-row__odds b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.mutation-row__effect {
  justify-self: end;
  max-width: 100%;
  overflow: hidden;
  padding: 0 10px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  font-weight: var(--fw-600);
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mutation-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 12px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 13px;
  line-height: 1.6;
}

.mutation-intro > span > span {
  color: var(--ui-primary);
}

@media (max-width: 639px) {
  /* 手机端：图标 + 名称/说明 + 效果一行，概率换到下一行，与名称左对齐。 */
  .mutation-row {
    grid-template-columns: 40px minmax(0, 1fr) auto;
    gap: 6px 12px;
    padding: 12px;
  }

  .mutation-row__well {
    width: 40px;
    height: 40px;
  }

  .mutation-row__main p {
    white-space: normal;
  }

  .mutation-row__odds {
    grid-column: 2 / -1;
    grid-row: 2;
  }

  .mutation-row__odds:has(> .is-empty) {
    display: none;
  }

  .mutation-row__effect {
    grid-column: 3;
    grid-row: 1;
  }

  .mutation-intro {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
