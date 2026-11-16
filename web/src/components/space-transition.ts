import { ref } from 'vue'

export type GameSpace = 'farm' | 'ranch'

export interface SpaceTransitionState {
  target: GameSpace
  phase: 'leave' | 'hold' | 'enter'
}

export const SPACE_LEAVE_MS = 160
export const SPACE_ENTER_MS = 240
export const SPACE_TRANSITION_STYLE = {
  '--space-leave-duration': `${SPACE_LEAVE_MS}ms`,
  '--space-enter-duration': `${SPACE_ENTER_MS}ms`,
}

export const spaceTransition = ref<SpaceTransitionState | null>(null)
