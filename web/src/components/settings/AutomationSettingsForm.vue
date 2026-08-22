<script setup lang="ts">
import type { SettingsState } from '@/stores/setting'
import { NCheckbox, NCheckboxGroup } from 'naive-ui'
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
  <div class="space-y-3">
    <section>
      <h4 class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
        日常农场
      </h4>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
        <BaseSwitch v-model="settings.automation.farm" label="自动种植收获" />
        <BaseSwitch v-model="settings.automation.farm_push" label="推送触发巡田" />
        <BaseSwitch v-model="settings.automation.skip_own_weed_bug" label="巡田时跳过一键务农" />
        <BaseSwitch v-model="settings.automation.land_upgrade" label="自动升级土地" />
        <BaseSwitch v-model="settings.automation.task" label="自动做任务" />
        <BaseSwitch v-model="settings.automation.sell" label="自动卖果实" />
        <BaseSwitch v-model="settings.automation.fertilizer_gift" label="自动填充化肥" />
      </div>
    </section>

    <section>
      <h4 class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
        施肥
      </h4>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
        <BaseSwitch v-model="settings.automation.fertilizer_buy_organic" label="自动购买有机化肥" />
        <BaseSwitch v-model="settings.automation.fertilizer_buy_normal" label="自动购买无机化肥" />
        <BaseSwitch v-model="settings.automation.fertilizer_multi_season" label="多季补肥" />
      </div>

      <div v-if="settings.automation.fertilizer_buy_organic || settings.automation.fertilizer_buy_normal" class="mt-3 rounded bg-green-50 p-3 text-sm space-y-3 dark:bg-green-900/20">
        <div v-if="settings.automation.fertilizer_buy_organic" class="space-y-2">
          <div class="text-green-700 font-medium dark:text-green-400">
            有机化肥设置
          </div>
          <div class="flex flex-wrap gap-4">
            <BaseInput v-model.number="settings.fertilizerBuyOrganicCount" label="购买数量" type="number" min="1" max="10000" />
            <BaseInput v-model.number="settings.fertilizerBuyOrganicThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
          </div>
        </div>
        <div v-if="settings.automation.fertilizer_buy_normal" class="space-y-2">
          <div class="text-green-700 font-medium dark:text-green-400">
            无机化肥设置
          </div>
          <div class="flex flex-wrap gap-4">
            <BaseInput v-model.number="settings.fertilizerBuyNormalCount" label="购买数量" type="number" min="1" max="10000" />
            <BaseInput v-model.number="settings.fertilizerBuyNormalThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
          </div>
        </div>
        <BaseInput v-model.number="settings.fertilizerBuyCheckIntervalMinutes" label="检测间隔 (分钟)" type="number" min="1" max="1440" />
        <p class="text-xs text-gray-500 dark:text-gray-400">
          系统会按照设定的检测间隔定时检测化肥容器剩余量，当低于触发阈值时自动购买。保存设置后会立即检测一次。同时开启两种化肥购买时，优先购买有机化肥。
        </p>
      </div>

      <div class="mt-3 border border-amber-200 rounded bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-900/10">
        <div class="mb-2 text-sm text-amber-800 font-medium dark:text-amber-300">
          施肥范围
        </div>
        <NCheckboxGroup v-model:value="settings.automation.fertilizer_land_types">
          <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
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
          施肥前会优先按土地类型过滤，仅对命中范围的地块执行施肥策略。
        </p>
      </div>

      <div class="mt-3 space-y-3">
        <BaseSelect v-model="settings.automation.fertilizer" label="施肥策略" :options="fertilizerOptions" />
        <div v-if="settings.automation.fertilizer === 'smart'" class="flex flex-wrap gap-4 rounded bg-amber-50 p-3 text-sm dark:bg-amber-900/20">
          <BaseInput
            v-model.number="settings.automation.fertilizer_smart_seconds"
            label="快成熟判定秒数"
            type="number"
            min="30"
            max="3600"
            class="w-40"
          />
          <span class="flex items-end pb-2 text-xs text-gray-500 dark:text-gray-400">
            距离成熟时间 ≤ 此秒数时施有机肥（默认300秒=5分钟）
          </span>
        </div>
      </div>
    </section>

    <section>
      <h4 class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
        好友
      </h4>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
        <BaseSwitch v-model="settings.automation.friend" label="自动好友互动" />
      </div>
      <div v-if="settings.automation.friend" class="mt-3 flex flex-wrap gap-4 rounded bg-blue-50 p-3 text-sm dark:bg-blue-900/20">
        <BaseSwitch v-model="settings.automation.friend_steal" label="自动偷菜" />
        <BaseSwitch v-model="settings.automation.friend_help" label="自动帮忙" />
        <BaseSwitch v-model="settings.automation.friend_bad" label="自动捣乱" />
        <BaseSwitch v-model="settings.automation.friend_help_exp_limit" label="经验满不帮忙" />
      </div>
    </section>

    <section>
      <h4 class="mb-2 text-sm text-gray-800 font-medium dark:text-gray-200">
        神秘商人
      </h4>
      <div class="flex flex-wrap gap-4 rounded bg-gray-50 p-3 text-sm dark:bg-gray-800/40">
        <BaseSwitch v-model="settings.automation.mystery_shop_auto_buy" label="自动购买" />
        <BaseSwitch v-model="settings.automation.mystery_shop_arrival_notify" label="到货提醒" />
        <BaseSwitch
          v-model="settings.automation.mystery_shop_purchase_notify"
          label="购买提醒"
          :disabled="!settings.automation.mystery_shop_auto_buy"
        />
      </div>
      <div v-if="settings.automation.mystery_shop_auto_buy" class="mt-3 flex flex-wrap gap-4 rounded bg-gray-50 p-3 text-sm dark:bg-gray-800/40">
        <span class="w-full text-gray-800 font-medium dark:text-gray-200">允许使用的货币</span>
        <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold" label="金币" />
        <BaseSwitch v-model="settings.automation.mystery_shop_allow_coupon" label="点券" />
        <BaseSwitch v-model="settings.automation.mystery_shop_allow_gold_bean" label="金豆豆" />
        <BaseSwitch v-model="settings.automation.mystery_shop_allow_diamond" label="钻石" />
        <p class="w-full text-xs text-gray-500 dark:text-gray-400">
          自动购买会先按标价币种筛选，再检查余额是否足够；余额读不到时不买。到货提醒和购买提醒使用「用户设置 → 下线提醒」的同一推送渠道。自动购买关闭时不会发送购买提醒。
        </p>
      </div>
      <p v-else class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        到货提醒可单独开启。购买提醒需先打开自动购买。推送渠道与「用户设置 → 下线提醒」相同。
      </p>
    </section>

    <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
      <BaseButton variant="primary" size="sm" :loading="saving" @click="emit('save')">
        保存自动控制
      </BaseButton>
    </div>
  </div>
</template>
