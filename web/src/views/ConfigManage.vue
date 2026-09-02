<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NInput } from 'naive-ui/es/input'
import { NPagination } from 'naive-ui/es/pagination'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{
  section: 'seeds' | 'fruits' | 'items'
}>()

const toast = useToastStore()

const activeTab = computed(() => props.section)

// ============ 通用状态 ============
const loading = ref(false)
const imageErrors = ref<Record<string | number, boolean>>({})
const searchKeyword = ref('')
const isDesktop = useMediaQuery('(min-width: 640px)')
const currentPage = ref(1)
const pageSize = computed(() => isDesktop.value ? 50 : 30)

// ============ 种子 ============
const seedList = ref<any[]>([])
const seedSort = ref('name')
const seedSeasonFilter = ref('')

const seedSortOptions = [
  { value: 'name', label: '名称' },
  { value: 'seedId', label: '种子ID' },
  { value: 'price', label: '价格' },
  { value: 'requiredLevel', label: '等级' },
  { value: 'growTime', label: '生长时间' },
]

const filteredSeeds = computed(() => {
  let list = seedList.value
  if (searchKeyword.value) {
    const kw = searchKeyword.value.toLowerCase()
    list = list.filter((s: any) =>
      s.name?.toLowerCase().includes(kw)
      || String(s.seedId).includes(kw)
      || String(s.plantId || '').includes(kw),
    )
  }
  if (seedSeasonFilter.value) {
    const seasons = Number(seedSeasonFilter.value)
    list = list.filter((s: any) => s.seasons === seasons)
  }
  const sortKey = seedSort.value
  return [...list].sort((a: any, b: any) => {
    const va = a[sortKey] ?? ''
    const vb = b[sortKey] ?? ''
    if (typeof va === 'number' && typeof vb === 'number')
      return va - vb
    return String(va).localeCompare(String(vb))
  })
})

// ============ 果实 ============
const fruitList = ref<any[]>([])
const fruitSort = ref('name')
const fruitRarityFilter = ref('')

const fruitSortOptions = [
  { value: 'name', label: '名称' },
  { value: 'id', label: '果实ID' },
  { value: 'price', label: '售价' },
]

const filteredFruits = computed(() => {
  let list = fruitList.value
  if (searchKeyword.value) {
    const kw = searchKeyword.value.toLowerCase()
    list = list.filter((f: any) =>
      f.name?.toLowerCase().includes(kw)
      || String(f.id).includes(kw)
      || String(f.plantId || '').includes(kw),
    )
  }
  if (fruitRarityFilter.value !== '') {
    const rarity = Number(fruitRarityFilter.value)
    list = list.filter((f: any) => f.rarity === rarity)
  }
  const sortKey = fruitSort.value
  return [...list].sort((a: any, b: any) => {
    const va = a[sortKey] ?? ''
    const vb = b[sortKey] ?? ''
    if (typeof va === 'number' && typeof vb === 'number')
      return va - vb
    return String(va).localeCompare(String(vb))
  })
})

// ============ 道具 ============
const itemList = ref<any[]>([])
const itemSort = ref('name')
const itemTypeFilter = ref('')
const itemRarityFilter = ref('')

const itemSortOptions = [
  { value: 'name', label: '名称' },
  { value: 'id', label: '物品ID' },
  { value: 'price', label: '价格' },
  { value: 'type', label: '类型' },
]

const itemTypeOptions = [
  { value: '', label: '全部类型' },
  { value: '1', label: '特殊道具' },
  { value: '2', label: '货币' },
  { value: '3', label: '经验' },
  { value: '4', label: '农场工具' },
  { value: '7', label: '化肥' },
  { value: '8', label: '宠物' },
  { value: '9', label: '宠物食品' },
  { value: '10', label: '头像框' },
  { value: '11', label: '礼品盒' },
  { value: '12', label: '收藏点' },
  { value: '13', label: '活跃点' },
  { value: '14', label: '解锁卡' },
  { value: '15', label: '高级货币' },
  { value: '16', label: '自选礼包' },
  { value: '17', label: '变异果实' },
  { value: '18', label: '装饰' },
  { value: '19', label: '印章' },
  { value: '23', label: '特殊' },
]

const itemTypeLabelMap: Record<number, string> = {
  1: '特殊道具',
  2: '货币',
  3: '经验',
  4: '农场工具',
  5: '种子',
  6: '果实',
  7: '化肥',
  8: '宠物',
  9: '宠物食品',
  10: '头像框',
  11: '礼品盒',
  12: '收藏点',
  13: '活跃点',
  14: '解锁卡',
  15: '高级货币',
  16: '自选礼包',
  17: '变异果实',
  18: '装饰',
  19: '印章',
  23: '特殊',
}

const rarityLabelMap: Record<number, string> = {
  0: '普通',
  1: '优秀',
  2: '精良',
  3: '稀有',
  4: '史诗',
  5: '传说',
}

const rarityFilterOptions = [
  { value: '', label: '全部稀有度' },
  { value: '0', label: '普通' },
  { value: '1', label: '优秀' },
  { value: '2', label: '精良' },
  { value: '3', label: '稀有' },
  { value: '4', label: '史诗' },
  { value: '5', label: '传说' },
]

const filteredItems = computed(() => {
  let list = itemList.value
  if (searchKeyword.value) {
    const kw = searchKeyword.value.toLowerCase()
    list = list.filter((i: any) =>
      i.name?.toLowerCase().includes(kw)
      || String(i.id).includes(kw),
    )
  }
  if (itemTypeFilter.value) {
    const t = Number(itemTypeFilter.value)
    list = list.filter((i: any) => i.type === t)
  }
  if (itemRarityFilter.value !== '') {
    const r = Number(itemRarityFilter.value)
    list = list.filter((i: any) => i.rarity === r)
  }
  const sortKey = itemSort.value
  return [...list].sort((a: any, b: any) => {
    const va = a[sortKey] ?? ''
    const vb = b[sortKey] ?? ''
    if (typeof va === 'number' && typeof vb === 'number')
      return va - vb
    return String(va).localeCompare(String(vb))
  })
})

const activeItemCount = computed(() => {
  if (activeTab.value === 'seeds')
    return filteredSeeds.value.length
  if (activeTab.value === 'fruits')
    return filteredFruits.value.length
  return filteredItems.value.length
})
const totalPages = computed(() => Math.max(1, Math.ceil(activeItemCount.value / pageSize.value)))

function paginate<T>(items: T[]) {
  const start = (currentPage.value - 1) * pageSize.value
  return items.slice(start, start + pageSize.value)
}

const paginatedSeeds = computed(() => paginate(filteredSeeds.value))
const paginatedFruits = computed(() => paginate(filteredFruits.value))
const paginatedItems = computed(() => paginate(filteredItems.value))

watch([
  activeTab,
  searchKeyword,
  seedSort,
  seedSeasonFilter,
  fruitSort,
  fruitRarityFilter,
  itemSort,
  itemTypeFilter,
  itemRarityFilter,
  pageSize,
], () => {
  currentPage.value = 1
})

watch(totalPages, (pages) => {
  currentPage.value = Math.min(currentPage.value, pages)
})

// ============ 数据加载 ============
async function loadSeeds() {
  loading.value = true
  try {
    const { data } = await api.get('/api/config/seeds')
    if (data?.ok)
      seedList.value = data.data || []
  }
  catch { /* ignore */ }
  finally { loading.value = false }
}

async function loadFruits() {
  loading.value = true
  try {
    const { data } = await api.get('/api/config/fruits')
    if (data?.ok)
      fruitList.value = data.data || []
  }
  catch { /* ignore */ }
  finally { loading.value = false }
}

async function loadItems() {
  loading.value = true
  try {
    const { data } = await api.get('/api/config/items')
    if (data?.ok)
      itemList.value = data.data || []
  }
  catch { /* ignore */ }
  finally { loading.value = false }
}

function loadCurrentTab() {
  if (activeTab.value === 'seeds')
    loadSeeds()
  else if (activeTab.value === 'fruits')
    loadFruits()
  else if (activeTab.value === 'items')
    loadItems()
}

function resetFilters() {
  searchKeyword.value = ''
  seedSeasonFilter.value = ''
  fruitRarityFilter.value = ''
  itemTypeFilter.value = ''
  itemRarityFilter.value = ''
}

onMounted(() => {
  loadCurrentTab()
})

watch(() => props.section, () => {
  resetFilters()
  loadCurrentTab()
})

// ============ 操作确认 ============
const confirmVisible = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
let confirmAction: (() => Promise<void>) | null = null

function showConfirm(title: string, message: string, action: () => Promise<void>) {
  confirmTitle.value = title
  confirmMessage.value = message
  confirmAction = action
  confirmVisible.value = true
}

async function executeConfirm() {
  if (confirmAction)
    await confirmAction()
  confirmVisible.value = false
}

// ============ 黑名单 ============
async function handleToggleBlacklist(seedId: number) {
  const seed = seedList.value.find((s: any) => s.seedId === seedId)
  const name = seed?.name || `种子${seedId}`
  showConfirm('加入黑名单', `确定要将「${name}」加入偷菜黑名单吗？加入后自动偷菜时会跳过该作物。`, async () => {
    try {
      const { data } = await api.post('/api/plant-blacklist', { seedId })
      if (data?.ok) {
        toast.success(data.message || '操作成功')
      }
      else {
        toast.error(data.error || '操作失败')
      }
    }
    catch (e: any) {
      toast.error(e.response?.data?.error || e.message)
    }
  })
}

// ============ 工具函数 ============
function formatGrowTime(seconds: number): string {
  if (!seconds || seconds <= 0)
    return '-'
  if (seconds < 60)
    return `${seconds}秒`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}分`
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`
}

function formatPrice(price: number, priceId?: number): string {
  if (priceId === 1005)
    return `${price} 金豆`
  if (priceId === 1004)
    return `${price} 钻石`
  return `${price} 金币`
}
</script>

<template>
  <div class="space-y-5">
    <div class="border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
      <!-- 搜索 + 筛选 -->
      <div class="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
        <NInput
          v-model:value="searchKeyword"
          class="w-52 shrink-0"
          clearable
          :placeholder="activeTab === 'seeds' ? '搜索种子...' : activeTab === 'fruits' ? '搜索果实...' : '搜索道具...'"
        >
          <template #prefix>
            <span class="i-carbon-search" />
          </template>
        </NInput>
        <!-- 种子筛选 -->
        <BaseSelect
          v-show="activeTab === 'seeds'"
          v-model="seedSeasonFilter"
          :options="[
            { value: '', label: '全部季节' },
            { value: '1', label: '单季' },
            { value: '2', label: '双季' },
          ]"
          class="w-40"
        />
        <BaseSelect
          v-show="activeTab === 'seeds'"
          v-model="seedSort"
          :options="seedSortOptions"
          class="w-40"
        />
        <!-- 果实筛选 -->
        <BaseSelect
          v-show="activeTab === 'fruits'"
          v-model="fruitRarityFilter"
          :options="rarityFilterOptions"
          class="w-40"
        />
        <BaseSelect
          v-show="activeTab === 'fruits'"
          v-model="fruitSort"
          :options="fruitSortOptions"
          class="w-40"
        />
        <!-- 道具筛选 -->
        <BaseSelect
          v-show="activeTab === 'items'"
          v-model="itemTypeFilter"
          :options="itemTypeOptions"
          class="w-40"
        />
        <BaseSelect
          v-show="activeTab === 'items'"
          v-model="itemRarityFilter"
          :options="rarityFilterOptions"
          class="w-40"
        />
        <BaseSelect
          v-show="activeTab === 'items'"
          v-model="itemSort"
          :options="itemSortOptions"
          class="w-40"
        />
        <span class="shrink-0 text-xs text-gray-400">
          {{ activeTab === 'seeds' ? filteredSeeds.length : activeTab === 'fruits' ? filteredFruits.length : filteredItems.length }} 条
        </span>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="flex justify-center py-16">
        <div class="i-svg-spinners-90-ring-with-bg text-4xl text-green-500" />
      </div>

      <!-- ============ 种子列表 ============ -->
      <div v-else-if="activeTab === 'seeds'" class="p-4">
        <div v-if="filteredSeeds.length === 0" class="py-16 text-center text-gray-400">
          {{ searchKeyword ? '没有匹配的种子' : '暂无种子数据' }}
        </div>
        <div v-else-if="isDesktop" class="overflow-hidden border farm-card border-gray-200 rounded-2xl shadow-sm dark:border-gray-700">
          <div class="overflow-x-auto">
            <table class="w-full whitespace-nowrap text-left text-sm">
              <thead class="border-b bg-gray-50 text-xs text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400">
                <tr>
                  <th class="sticky left-0 z-10 bg-gray-50 px-4 py-3 font-medium shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800">
                    种子
                  </th>
                  <th class="px-4 py-3 font-medium">
                    种子ID
                  </th>
                  <th class="px-4 py-3 font-medium">
                    等级
                  </th>
                  <th class="px-4 py-3 font-medium">
                    季节
                  </th>
                  <th class="px-4 py-3 font-medium">
                    生长时间
                  </th>
                  <th class="px-4 py-3 font-medium">
                    收获数
                  </th>
                  <th class="px-4 py-3 font-medium">
                    经验
                  </th>
                  <th class="px-4 py-3 font-medium">
                    价格
                  </th>
                  <th class="px-4 py-3 text-center font-medium">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
                <tr v-for="item in paginatedSeeds" :key="item.seedId" class="group transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td class="sticky left-0 bg-white px-4 py-2 shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800 dark:group-hover:bg-gray-700/50">
                    <div class="flex items-center gap-3">
                      <div class="relative h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                        <img
                          v-if="item.image && !imageErrors[item.seedId]"
                          :src="item.image"
                          class="h-8 w-8 object-contain"
                          loading="lazy"
                          @error="imageErrors[item.seedId] = true"
                        >
                        <div v-else class="i-carbon-sprout text-xl text-gray-400" />
                      </div>
                      <span class="text-gray-900 font-bold dark:text-gray-100">{{ item.name }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.seedId }}
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    Lv.{{ item.requiredLevel }}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="item.seasons === 2
                        ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
                        : 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'"
                    >
                      {{ item.seasons === 2 ? '双季' : '单季' }}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ formatGrowTime(item.growTime) }}
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.harvestCount || '-' }}
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.exp || '-' }}
                  </td>
                  <td class="px-4 py-2 text-amber-600 font-medium dark:text-amber-400">
                    {{ formatPrice(item.price, item.priceId) }}
                  </td>
                  <td class="px-4 py-2 text-center">
                    <div class="flex items-center justify-center gap-1">
                      <NButton
                        quaternary
                        circle
                        size="small"
                        type="warning"
                        title="加入/移出黑名单"
                        aria-label="加入或移出黑名单"
                        @click="handleToggleBlacklist(item.seedId)"
                      >
                        🚫
                      </NButton>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <!-- 移动端卡片 -->
        <div v-else class="space-y-3">
          <div v-for="item in paginatedSeeds" :key="item.seedId" class="border border-gray-200 rounded-xl bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
            <div class="flex items-center gap-3">
              <div class="relative h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                <img
                  v-if="item.image && !imageErrors[item.seedId]"
                  :src="item.image"
                  class="h-10 w-10 object-contain"
                  loading="lazy"
                  @error="imageErrors[item.seedId] = true"
                >
                <div v-else class="i-carbon-sprout text-xl text-gray-400" />
              </div>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-gray-900 font-bold dark:text-gray-100">{{ item.name }}</span>
                  <span
                    class="rounded-full px-1.5 py-0.5 text-xs"
                    :class="item.seasons === 2 ? 'bg-purple-100 text-purple-600' : 'bg-green-100 text-green-600'"
                  >
                    {{ item.seasons === 2 ? '双季' : '单季' }}
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                  <span>ID:{{ item.seedId }}</span>
                  <span>Lv.{{ item.requiredLevel }}</span>
                  <span>{{ formatGrowTime(item.growTime) }}</span>
                  <span class="text-amber-600">{{ formatPrice(item.price, item.priceId) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 果实列表 ============ -->
      <div v-else-if="activeTab === 'fruits'" class="p-4">
        <div v-if="filteredFruits.length === 0" class="py-16 text-center text-gray-400">
          {{ searchKeyword ? '没有匹配的果实' : '暂无果实数据' }}
        </div>
        <div v-else-if="isDesktop" class="overflow-hidden border farm-card border-gray-200 rounded-2xl shadow-sm dark:border-gray-700">
          <div class="overflow-x-auto">
            <table class="w-full whitespace-nowrap text-left text-sm">
              <thead class="border-b bg-gray-50 text-xs text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400">
                <tr>
                  <th class="sticky left-0 z-10 bg-gray-50 px-4 py-3 font-medium shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800">
                    果实
                  </th>
                  <th class="px-4 py-3 font-medium">
                    果实ID
                  </th>
                  <th class="px-4 py-3 font-medium">
                    关联植物
                  </th>
                  <th class="px-4 py-3 font-medium">
                    种子ID
                  </th>
                  <th class="px-4 py-3 font-medium">
                    售价
                  </th>
                  <th class="px-4 py-3 font-medium">
                    等级
                  </th>
                  <th class="px-4 py-3 font-medium">
                    稀有度
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
                <tr v-for="item in paginatedFruits" :key="item.id" class="group transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td class="sticky left-0 bg-white px-4 py-2 shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800 dark:group-hover:bg-gray-700/50">
                    <div class="flex items-center gap-3">
                      <div class="relative h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                        <img
                          v-if="item.image && !imageErrors[item.id]"
                          :src="item.image"
                          class="h-8 w-8 object-contain"
                          loading="lazy"
                          @error="imageErrors[item.id] = true"
                        >
                        <div v-else class="i-carbon-crop-growth text-xl text-gray-400" />
                      </div>
                      <span class="text-gray-900 font-bold dark:text-gray-100">{{ item.name }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.id }}
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.plantName || '-' }}
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.seedId || '-' }}
                  </td>
                  <td class="px-4 py-2 text-amber-600 font-medium dark:text-amber-400">
                    {{ formatPrice(item.price, item.priceId) }}
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    Lv.{{ item.level }}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="item.rarity >= 3 ? 'bg-purple-100 text-purple-600' : item.rarity >= 1 ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'"
                    >
                      {{ rarityLabelMap[item.rarity] || '普通' }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="space-y-3">
          <div v-for="item in paginatedFruits" :key="item.id" class="border border-gray-200 rounded-xl bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
            <div class="flex items-center gap-3">
              <div class="relative h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                <img
                  v-if="item.image && !imageErrors[item.id]"
                  :src="item.image"
                  class="h-10 w-10 object-contain"
                  loading="lazy"
                  @error="imageErrors[item.id] = true"
                >
                <div v-else class="i-carbon-crop-growth text-xl text-gray-400" />
              </div>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-gray-900 font-bold dark:text-gray-100">{{ item.name }}</span>
                  <span
                    class="rounded-full px-1.5 py-0.5 text-xs"
                    :class="item.rarity >= 3 ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-500'"
                  >
                    {{ rarityLabelMap[item.rarity] || '普通' }}
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                  <span>ID:{{ item.id }}</span>
                  <span v-if="item.plantName">{{ item.plantName }}</span>
                  <span class="text-amber-600">{{ formatPrice(item.price, item.priceId) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 道具列表 ============ -->
      <div v-else-if="activeTab === 'items'" class="p-4">
        <div v-if="filteredItems.length === 0" class="py-16 text-center text-gray-400">
          {{ searchKeyword || itemTypeFilter ? '没有匹配的道具' : '暂无道具数据' }}
        </div>
        <div v-else-if="isDesktop" class="overflow-hidden border farm-card border-gray-200 rounded-2xl shadow-sm dark:border-gray-700">
          <div class="overflow-x-auto">
            <table class="w-full whitespace-nowrap text-left text-sm">
              <thead class="border-b bg-gray-50 text-xs text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400">
                <tr>
                  <th class="sticky left-0 z-10 bg-gray-50 px-4 py-3 font-medium shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800">
                    道具
                  </th>
                  <th class="px-4 py-3 font-medium">
                    物品ID
                  </th>
                  <th class="px-4 py-3 font-medium">
                    类型
                  </th>
                  <th class="px-4 py-3 font-medium">
                    价格
                  </th>
                  <th class="px-4 py-3 font-medium">
                    可使用
                  </th>
                  <th class="px-4 py-3 font-medium">
                    等级
                  </th>
                  <th class="px-4 py-3 font-medium">
                    稀有度
                  </th>
                  <th class="px-4 py-3 font-medium">
                    描述
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
                <tr v-for="item in paginatedItems" :key="item.id" class="group transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td class="sticky left-0 bg-white px-4 py-2 shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800 dark:group-hover:bg-gray-700/50">
                    <div class="flex items-center gap-3">
                      <div class="relative h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                        <img
                          v-if="item.image && !imageErrors[item.id]"
                          :src="item.image"
                          class="h-8 w-8 object-contain"
                          loading="lazy"
                          @error="imageErrors[item.id] = true"
                        >
                        <div v-else class="i-carbon-box text-xl text-gray-400" />
                      </div>
                      <span class="text-gray-900 font-bold dark:text-gray-100">{{ item.name }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.id }}
                  </td>
                  <td class="px-4 py-2">
                    <span class="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-600 font-medium dark:bg-blue-900/30 dark:text-blue-400">
                      {{ itemTypeLabelMap[item.type] || `类型${item.type}` }}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-amber-600 font-medium dark:text-amber-400">
                    {{ item.price > 0 ? formatPrice(item.price, item.priceId) : '-' }}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="item.canUse ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-500'"
                    >
                      {{ item.canUse ? '是' : '否' }}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {{ item.level > 0 ? `Lv.${item.level}` : '-' }}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="item.rarity >= 3 ? 'bg-purple-100 text-purple-600' : item.rarity >= 1 ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'"
                    >
                      {{ rarityLabelMap[item.rarity] || '普通' }}
                    </span>
                  </td>
                  <td class="max-w-[200px] truncate px-4 py-2 text-xs text-gray-400">
                    {{ item.desc || item.effectDesc || '-' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <!-- 移动端卡片 -->
        <div v-else class="space-y-3">
          <div v-for="item in paginatedItems" :key="item.id" class="w-full overflow-hidden border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
            <div class="flex items-center gap-3">
              <div class="relative h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                <img
                  v-if="item.image && !imageErrors[item.id]"
                  :src="item.image"
                  class="h-10 w-10 object-contain"
                  loading="lazy"
                  @error="imageErrors[item.id] = true"
                >
                <div v-else class="i-carbon-box text-xl text-gray-400" />
              </div>
              <div class="min-w-0 flex-1 overflow-hidden">
                <div class="min-w-0 flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-gray-900 font-bold dark:text-gray-100" :title="item.name">{{ item.name }}</span>
                  <span class="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">
                    {{ itemTypeLabelMap[item.type] || `类型${item.type}` }}
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                  <span>ID:{{ item.id }}</span>
                  <span v-if="item.price > 0" class="text-amber-600">{{ formatPrice(item.price, item.priceId) }}</span>
                  <span v-if="item.canUse" class="text-green-600">可使用</span>
                </div>
                <div
                  v-if="item.desc || item.effectDesc"
                  class="mt-1 block max-w-full min-w-0 w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-400"
                  :title="item.desc || item.effectDesc"
                >
                  {{ item.desc || item.effectDesc }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!loading && totalPages > 1" class="flex items-center justify-center border-t border-gray-100 px-4 py-3 dark:border-gray-700">
        <NPagination v-model:page="currentPage" :page-count="totalPages" :page-slot="5" />
      </div>
    </div>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmTitle"
      :message="confirmMessage"
      @confirm="executeConfirm"
      @cancel="confirmVisible = false"
    />
  </div>
</template>
