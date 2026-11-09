import type { ObjectDirective } from 'vue'

// 列表共享一个观察器；图片接近可视区域时才设置 src，避免原生懒加载提前请求多屏图片。
const pending = new Map<HTMLImageElement, string>()
let observer: IntersectionObserver | undefined

function stop(el: HTMLImageElement) {
  observer?.unobserve(el)
  pending.delete(el)
  if (!pending.size) {
    observer?.disconnect()
    observer = undefined
  }
}

function observe(el: HTMLImageElement, src: string | undefined) {
  stop(el)
  el.removeAttribute('src')
  if (!src)
    return
  if (typeof IntersectionObserver === 'undefined') {
    el.src = src
    return
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const image = entry.target as HTMLImageElement
      const source = pending.get(image)
      if (entry.isIntersecting && source) {
        image.src = source
        stop(image)
      }
    }
  }, { rootMargin: '200px 0px' })
  pending.set(el, src)
  observer.observe(el)
}

export const vLazySrc: ObjectDirective<HTMLImageElement, string | undefined> = {
  mounted: (el, { value }) => observe(el, value),
  updated: (el, { value, oldValue }) => {
    if (value !== oldValue)
      observe(el, value)
  },
  beforeUnmount: stop,
}
