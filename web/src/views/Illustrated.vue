<script setup lang="ts">
import { NTab } from 'naive-ui/es/tabs'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CollectionsPanel from '@/components/CollectionsPanel.vue'
import IllustratedPanel from '@/components/IllustratedPanel.vue'
import MutationCatalogPanel from '@/components/MutationCatalogPanel.vue'
import PageTabs from '@/components/PageTabs.vue'

type BookTab = 'crop' | 'mutant' | 'collection' | 'catalog'
const route = useRoute()
const router = useRouter()
const currentTab = computed<BookTab>({
  get: () => route.query.tab === 'mutant' || route.query.tab === 'collection' || route.query.tab === 'catalog' ? route.query.tab : 'crop',
  set: tab => void router.replace({ query: { ...route.query, tab: tab === 'crop' ? undefined : tab } }),
})
</script>

<template>
  <div class="page-stack">
    <PageTabs v-model:value="currentTab">
      <NTab name="crop">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-sprout" />作物图鉴</span>
      </NTab>
      <NTab name="mutant">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-gem" />超变图鉴</span>
      </NTab>
      <NTab name="collection">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-trophy" />藏品</span>
      </NTab>
      <NTab name="catalog">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-catalog" />变异宝典</span>
      </NTab>
    </PageTabs>
    <CollectionsPanel v-if="currentTab === 'collection'" />
    <MutationCatalogPanel v-else-if="currentTab === 'catalog'" />
    <IllustratedPanel v-else :book-type="currentTab" />
  </div>
</template>
