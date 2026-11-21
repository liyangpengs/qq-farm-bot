<script setup lang="ts">
import CareerHarvestSteal from '@/components/CareerHarvestSteal.vue'

defineProps<{
  career: { harvest: number, mature: number, steal: number }
}>()
</script>

<template>
  <section class="ov-card">
    <h3 class="ov-card__title">
      牧场生涯
    </h3>
    <CareerHarvestSteal :career="career" variant="tiles" />
  </section>
</template>

<style scoped src="@/styles/overview.css"></style>
