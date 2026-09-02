import type { ActivityGameplayModule } from '../types'

export { default as WeatherActivityView } from './WeatherActivityView.vue'

export const weatherGameplay: ActivityGameplayModule = {
  key: 'weather',
  defaultTab: 'weather',
  tabs: ['weather'],
}
