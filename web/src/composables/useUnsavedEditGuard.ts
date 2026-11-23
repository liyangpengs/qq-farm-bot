import type { ComputedRef, Ref } from 'vue'
import { onBeforeUnmount, watch } from 'vue'
import { useAppUpdateStore } from '@/stores/app-update'

export function useUnsavedEditGuard(isDirty: Ref<boolean> | ComputedRef<boolean>): void {
  const appUpdateStore = useAppUpdateStore()
  const guardId = Symbol('unsaved-edit-guard')

  watch(isDirty, (dirty) => {
    appUpdateStore.setEditGuard(guardId, Boolean(dirty))
  }, { immediate: true })

  onBeforeUnmount(() => {
    appUpdateStore.removeEditGuard(guardId)
  })
}
