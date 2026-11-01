import { onBeforeUnmount, ref } from 'vue'

/** 复制成功后的对勾反馈在 2.5 秒后自动熄灭；连续复制会重新计时。 */
export const COPY_FEEDBACK_MS = 2500

export function useCopyFeedback(duration = COPY_FEEDBACK_MS) {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function reset() {
    clearTimeout(timer)
    timer = undefined
    copied.value = false
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    clearTimeout(timer)
    copied.value = true
    timer = setTimeout(() => {
      copied.value = false
      timer = undefined
    }, duration)
  }

  onBeforeUnmount(() => clearTimeout(timer))
  return { copied, copy, reset }
}
