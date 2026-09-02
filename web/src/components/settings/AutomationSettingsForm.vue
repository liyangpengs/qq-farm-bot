<script setup lang="ts">
import type { SettingsState } from '@/stores/setting'
import { NCheckbox, NCheckboxGroup } from 'naive-ui/es/checkbox'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

export type AutomationSettingsFormModel = Pick<
  SettingsState,
  | 'automation'
  | 'fertilizerBuyOrganicCount'
  | 'fertilizerBuyOrganicThresholdHours'
  | 'fertilizerBuyNormalCount'
  | 'fertilizerBuyNormalThresholdHours'
  | 'fertilizerBuyCheckIntervalMinutes'
  | 'autoAcceptFriendMinLevel'
  | 'autoAcceptRequireOwnLevel'
  | 'autoAcceptHarvestStealEnabled'
  | 'autoAcceptHarvestStealHarvest'
  | 'autoAcceptHarvestStealSteal'
>

defineProps<{
  saving: boolean
  fertilizerLandTypeOptions: Array<{ label: string, value: string }>
  fertilizerOptions: Array<{ label: string, value: string }>
}>()

const emit = defineEmits<{
  save: []
}>()

const settings = defineModel<AutomationSettingsFormModel>({ required: true })
</script>

<template>
  <div class="space-y-4">
    <div class="automation-card-layout">
      <div class="automation-card-column">
        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400">
              <span class="i-carbon-sprout text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                日常农场
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                管理巡田、种植、任务和产出处理
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.farm" label="自动种植收获" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.farm_push" label="推送触发巡田" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.skip_own_weed_bug" label="巡田时跳过一键务农" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.land_upgrade" label="自动升级土地" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.task" label="自动做任务" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.sell" label="自动卖果实" />
            </div>
            <div class="automation-setting-item sm:col-span-2">
              <BaseSwitch v-model="settings.automation.fertilizer_gift" label="自动填充化肥" />
            </div>
          </div>
        </section>

        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
              <span class="i-carbon-chemistry text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                施肥管理
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                设置施肥策略、范围和化肥补充
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_buy_organic" label="自动购买有机化肥" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_buy_normal" label="自动购买无机化肥" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.fertilizer_multi_season" label="多季补肥" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.show_manual_fertilizer" label="显示手动施肥按钮" />
            </div>
          </div>

          <div
            v-if="settings.automation.fertilizer_buy_organic || settings.automation.fertilizer_buy_normal"
            class="mt-3 rounded-lg bg-green-50 p-3 text-sm space-y-3 dark:bg-green-900/20"
          >
            <div v-if="settings.automation.fertilizer_buy_organic" class="space-y-2">
              <div class="text-green-700 font-medium dark:text-green-400">
                有机化肥设置
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BaseInput v-model.number="settings.fertilizerBuyOrganicCount" label="购买数量" type="number" min="1" max="10000" />
                <BaseInput v-model.number="settings.fertilizerBuyOrganicThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
              </div>
            </div>
            <div v-if="settings.automation.fertilizer_buy_normal" class="space-y-2">
              <div class="text-green-700 font-medium dark:text-green-400">
                无机化肥设置
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BaseInput v-model.number="settings.fertilizerBuyNormalCount" label="购买数量" type="number" min="1" max="10000" />
                <BaseInput v-model.number="settings.fertilizerBuyNormalThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
              </div>
            </div>
            <BaseInput v-model.number="settings.fertilizerBuyCheckIntervalMinutes" label="检测间隔 (分钟)" type="number" min="1" max="1440" />
            <p class="text-xs text-gray-500 dark:text-gray-400">
              系统会按检测间隔检查化肥余量，低于阈值时自动购买。两种化肥同时开启时优先购买有机化肥。
            </p>
          </div>

          <div class="mt-3 border border-amber-200 rounded-lg bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-900/10">
            <div class="mb-2 text-sm text-amber-800 font-medium dark:text-amber-300">
              施肥范围
            </div>
            <NCheckboxGroup v-model:value="settings.automation.fertilizer_land_types">
              <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
                <NCheckbox
                  v-for="option in fertilizerLandTypeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </NCheckbox>
              </div>
            </NCheckboxGroup>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              仅对选中土地类型的地块执行施肥策略。
            </p>
          </div>

          <div class="mt-3 space-y-3">
            <BaseSelect v-model="settings.automation.fertilizer" label="施肥策略" :options="fertilizerOptions" />
            <div
              v-if="settings.automation.fertilizer === 'smart'"
              class="flex flex-wrap gap-4 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-900/20"
            >
              <BaseInput
                v-model.number="settings.automation.fertilizer_smart_seconds"
                label="快成熟判定秒数"
                type="number"
                min="30"
                max="3600"
                class="w-40"
              />
              <span class="flex items-end pb-2 text-xs text-gray-500 dark:text-gray-400">
                距离成熟时间 ≤ 此秒数时施有机肥（默认 300 秒）
              </span>
            </div>
          </div>
        </section>
      </div>

      <div class="automation-card-column">
        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
              <span class="i-carbon-user-multiple text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                好友互动
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                管理好友农场互动和好友申请
              </p>
            </div>
          </div>

          <div class="automation-setting-item">
            <BaseSwitch v-model="settings.automation.friend" label="自动好友互动" />
          </div>
          <div v-if="settings.automation.friend" class="mt-3 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
            <div class="mb-2 text-xs text-blue-700 font-medium dark:text-blue-300">
              互动行为
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_steal" label="自动偷菜" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_help" label="自动帮忙" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_bad" label="自动捣乱" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_help_exp_limit" label="经验满不帮忙" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.friend_help_protect_dog_ignore_exp_limit" label="护主犬经验满仍帮忙" />
              </div>
            </div>
          </div>

          <div class="mt-3 rounded-lg bg-blue-50 p-3 space-y-3 dark:bg-blue-900/20">
            <BaseSwitch v-model="settings.automation.friend_auto_accept" label="自动通过好友申请" />
            <template v-if="settings.automation.friend_auto_accept">
              <div class="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                <BaseInput v-model.number="settings.autoAcceptFriendMinLevel" label="最低等级" type="number" min="0" max="200" />
                <BaseSwitch v-model="settings.autoAcceptRequireOwnLevel" label="不低于自己等级" />
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                最低等级设为 0 表示不限制固定等级；开启等级条件时需同时满足所有条件。
              </p>
              <div class="flex flex-wrap items-end gap-3">
                <BaseSwitch v-model="settings.autoAcceptHarvestStealEnabled" label="收偷比过滤" />
                <BaseInput
                  v-model.number="settings.autoAcceptHarvestStealHarvest"
                  label="收获"
                  type="number"
                  min="0"
                  max="9999"
                  class="w-28"
                  :disabled="!settings.autoAcceptHarvestStealEnabled"
                />
                <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">:</span>
                <BaseInput
                  v-model.number="settings.autoAcceptHarvestStealSteal"
                  label="偷菜"
                  type="number"
                  min="1"
                  max="9999"
                  class="w-28"
                  :disabled="!settings.autoAcceptHarvestStealEnabled"
                />
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                默认按 8:1 比较收获/偷菜数量，不合格的申请会直接拒绝。
              </p>
            </template>
          </div>
        </section>

        <section class="farm-card rounded-2xl p-4">
          <div class="mb-4 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-900/25 dark:text-violet-400">
              <span class="i-carbon-store text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                神秘商人
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                自动购买商品并接收相关提醒
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.mystery_shop_auto_buy" label="自动购买" />
            </div>
            <div class="automation-setting-item">
              <BaseSwitch v-model="settings.automation.mystery_shop_arrival_notify" label="到货提醒" />
            </div>
            <div class="automation-setting-item sm:col-span-2">
              <BaseSwitch
                v-model="settings.automation.mystery_shop_purchase_notify"
                label="购买提醒"
                :disabled="!settings.automation.mystery_shop_auto_buy"
              />
            </div>
          </div>

          <div v-if="settings.automation.mystery_shop_auto_buy" class="mt-3 rounded-lg bg-gray-50 p-3 space-y-3 dark:bg-gray-800/60">
            <div class="text-sm text-gray-800 font-medium dark:text-gray-200">
              允许使用的货币
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold" label="金币" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_coupon" label="点券" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold_bean" label="金豆豆" />
              </div>
              <div class="automation-setting-item">
                <BaseSwitch v-model="settings.automation.mystery_shop_allow_diamond" label="钻石" />
              </div>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              自动购买会先按标价币种筛选，再检查余额是否足够；提醒使用「用户设置 → 下线提醒」的推送渠道。
            </p>
          </div>
          <p v-else class="mt-3 text-xs text-gray-500 dark:text-gray-400">
            到货提醒可单独开启；购买提醒需先打开自动购买。
          </p>
        </section>
      </div>
    </div>

    <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
      <BaseButton variant="primary" size="sm" :loading="saving" @click="emit('save')">
        保存自动控制
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.automation-card-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 1rem;
}

.automation-card-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1rem;
}

.automation-setting-item {
  display: flex;
  min-height: 42px;
  align-items: center;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}

@media (max-width: 1279px) {
  .automation-card-layout {
    display: block;
  }

  .automation-card-column {
    display: contents;
  }

  .automation-card-layout section {
    margin-bottom: 1rem;
  }
}
</style>
