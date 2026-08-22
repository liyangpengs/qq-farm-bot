<script setup lang="ts">
import { NTab, NTabs } from 'naive-ui'
import { ref, watch } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import IllustratedPanel from '@/components/IllustratedPanel.vue'
import PetPanel from '@/components/PetPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

type PersonalTab = 'farm' | 'illustrated' | 'pet' | 'bag' | 'task'

const currentTab = ref<PersonalTab>('farm')

const tabPanels: Record<PersonalTab, any> = {
  farm: FarmPanel,
  illustrated: IllustratedPanel,
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
  <div class="page-stack h-full flex flex-col">
    <NTabs v-model:value="currentTab" class="mb-4" type="line" animated>
      <NTab name="farm">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-sprout" />我的农场</span>
      </NTab>
      <NTab name="illustrated">
        <span class="inline-flex items-center gap-2"><span class="i-carbon-book" />图鉴</span>
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
    </NTabs>

    <div class="flex-1 overflow-hidden overflow-y-auto">
      <div v-for="tab in visitedTabs" v-show="tab === currentTab" :key="tab">
        <component :is="tabPanels[tab]" />
      </div>
    </div>
  </div>
</template>
