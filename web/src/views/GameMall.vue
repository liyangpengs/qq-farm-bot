<script setup lang="ts">
import { NTab } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MallCatalogPanel from '@/components/commerce/MallCatalogPanel.vue'
import MysteryShopPanel from '@/components/commerce/MysteryShopPanel.vue'
import PageTabs from '@/components/PageTabs.vue'
import { useCommerceStore } from '@/stores/commerce'

type MallTab = 'mall' | 'svip' | 'mystery' | 'limited' | 'props'

const route = useRoute()
const router = useRouter()
const { purchasingGoodsId, mysteryPurchasing } = storeToRefs(useCommerceStore())
const tabs: Array<{ key: MallTab, label: string, icon: string }> = [
  { key: 'mall', label: '游戏商城', icon: 'i-carbon-shopping-bag' },
  { key: 'limited', label: '限时商店', icon: 'i-carbon-timer' },
  { key: 'props', label: '道具商店', icon: 'i-carbon-store' },
  { key: 'svip', label: 'SVIP 专属商城', icon: 'i-carbon-diamond-outline' },
  { key: 'mystery', label: '神秘商人', icon: 'i-carbon-store' },
]
const activeTab = computed<MallTab>(() => route.query.tab === 'limited' || route.query.tab === 'mystery' || route.query.tab === 'svip' || route.query.tab === 'props' ? route.query.tab : 'mall')
const purchasing = computed(() => purchasingGoodsId.value !== null || mysteryPurchasing.value)

function selectTab(tab: MallTab) {
  if (purchasing.value || tab === activeTab.value)
    return
  router.replace({ query: { ...route.query, tab: tab === 'mall' ? undefined : tab }, hash: route.hash })
}
</script>

<template>
  <div class="mall-page page-stack">
    <PageTabs :value="activeTab" @update:value="selectTab">
      <NTab v-for="tab in tabs" :key="tab.key" :name="tab.key" :disabled="purchasing && activeTab !== tab.key">
        <span class="inline-flex items-center gap-2">
          <span :class="tab.icon" />
          {{ tab.label }}
        </span>
      </NTab>
    </PageTabs>

    <MysteryShopPanel v-if="activeTab === 'mystery'" />
    <MallCatalogPanel v-else :slot-type="activeTab === 'svip' ? 4 : activeTab === 'limited' ? 5 : 1" :props-shop="activeTab === 'props'" />
  </div>
</template>

<style scoped>
.mall-page {
  min-height: 100%;
  color: var(--ui-ink);
}
</style>
