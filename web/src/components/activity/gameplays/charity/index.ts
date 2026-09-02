import type { ActivityGameplayModule } from '../types'

export { default as CharityRedFlowerView } from './CharityRedFlowerView.vue'

export const charityGameplay: ActivityGameplayModule = {
  key: 'charity',
  defaultTab: 'charity',
  tabs: ['charity'],
}
