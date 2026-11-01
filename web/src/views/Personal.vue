<script setup lang="ts">
import { NTab } from 'naive-ui/es/tabs'
import { ref, watch } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import PageTabs from '@/components/PageTabs.vue'
import PetPanel from '@/components/PetPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

type PersonalTab = 'farm' | 'pet' | 'bag' | 'task'

const currentTab = ref<PersonalTab>('farm')

const tabPanels: Record<PersonalTab, any> = {
  farm: FarmPanel,
  pet: PetPanel,
  bag: BagPanel,
  task: TaskPanel,
}

const visitedTabs = ref<PersonalTab[]>(['farm'])

watch(currentTab, (tab) => {
  if (!visitedTabs.value.includes(tab))
    visitedTabs.value.push(tab)
})
</script>

<template>
  <div class="page-stack flex flex-col">
    <PageTabs v-model:value="currentTab" animated>
      <NTab name="farm">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-sprout" />我的农场</span>
      </NTab>
      <NTab name="pet">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-dog-walker" />宠物</span>
      </NTab>
      <NTab name="bag">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-box" />我的背包</span>
      </NTab>
      <NTab name="task">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-task" />我的任务</span>
      </NTab>
    </PageTabs>

    <div class="min-w-0">
      <div v-for="tab in visitedTabs" v-show="tab === currentTab" :key="tab">
        <component :is="tabPanels[tab]" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 个人页的面板随页面整体滚动：Tab 吸顶，面板工具栏在桌面端吸在 Tab 下方（.panel-sticky），
   手机端随内容滚走，列表获得接近整屏的阅读区域。 */
:deep(.personal-panel) {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

:deep(.personal-panel__card) {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

:deep(.personal-panel__scroll) {
  min-width: 0;
}

@media (max-width: 640px) {
  :deep(.personal-panel) {
    gap: 12px;
  }
}
</style>
