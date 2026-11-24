<script setup lang="ts">
import RunLogPanel from '@/components/RunLogPanel.vue'
</script>

<template>
  <!-- 牧场面板的日志卡片：复用统一日志视图，默认筛选牧场模块 -->
  <div class="dash-logs flex flex-1 flex-col gap-6 md:w-3/4">
    <div class="dash-logs__card flex flex-1 flex-col farm-card rounded-2xl bg-white p-5 shadow-md md:overflow-hidden dark:bg-gray-800">
      <RunLogPanel
        default-module="ranch"
        :level-in-signature="true"
        list-class="max-h-[60vh] min-h-0 flex-1 md:max-h-none"
      />
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 768px) {
  .dash-logs {
    position: relative;
    min-height: 480px;
  }

  .dash-logs__card {
    position: absolute;
    inset: 0;
  }
}
</style>
