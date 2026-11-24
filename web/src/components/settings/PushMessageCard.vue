<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  content: string
  mediaMap?: Record<string, string>
}>()

interface Segment {
  type: 'text' | 'img'
  text: string
  name: string
  url: string
}
type EventRow = { label: string; icons: Segment[]; friend: string }

function makeText(text: string): Segment { return { type: 'text', text, name: '', url: '' } }
function makeImg(name: string, url: string): Segment { return { type: 'img', text: '', name, url } }

function parseSegments(text: string): Segment[] {
  const out: Segment[] = []
  const re = /!\[([^\]]*?)\s*#\d+px\s*#\d+px\]\(([^)]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(makeText(text.slice(last, m.index)))
    out.push(makeImg((m[1] || '').trim(), (m[2] || '').trim()))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(makeText(text.slice(last)))
  return out
}

function imgSrc(seg: Segment): string {
  if (/^https?:\/\//i.test(seg.url)) return seg.url
  const local = props.mediaMap?.[seg.name]
  if (local?.startsWith('/game-config/')) return local
  if (/^\d+$/.test(seg.name)) return `/game-config/seed_images_named/seed_images/${seg.name}.png`
  return ''
}

const parsed = computed(() => {
  const lines = String(props.content || '').split('\n')
  let title = ''
  let subtitle = ''
  const events: Array<EventRow & { body: Segment[]; count: string }> = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('## ')) { title = line.slice(3).trim(); continue }
    if (line.startsWith('> ')) { subtitle = line.slice(2).trim(); continue }
    if (line.startsWith('- ')) {
      const rest = line.slice(2)
      const labelMatch = /^\*\*([^*]+)\*\*/.exec(rest)
      const plainHead = (rest.split('![')[0] || '').trim()
      const label = labelMatch ? (labelMatch[1] || plainHead) : plainHead
      const afterLabel = labelMatch ? rest.slice((labelMatch[0] || '').length) : rest
      const countMatch = /\s*×(\d+)/.exec(afterLabel)
      const count = countMatch ? `×${countMatch[1] || ''}` : ''
      const withoutCount = afterLabel.replace(/\s*×\d+/, '')
      const friend = withoutCount.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/·/g, '').trim()
      const icons = parseSegments(afterLabel).filter(s => s.type === 'img')
      events.push({ label, icons, friend, body: [], count })
      continue
    }
    if (line.trim() && events.length) {
      const lastEvent = events[events.length - 1]
      if (lastEvent) lastEvent.body.push(...parseSegments(line.trim()))
    }
  }
  return { title, subtitle, events }
})
</script>

<template>
  <div class="push-msg-card rounded-xl border border-gray-200 bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-900/60">
    <div class="mb-1 flex items-baseline justify-between gap-2">
      <span class="font-semibold text-gray-900 dark:text-gray-100">{{ parsed.title || '农场动态' }}</span>
    </div>
    <div class="mb-2 text-xs text-gray-400 dark:text-gray-500">{{ parsed.subtitle }}</div>
    <div class="space-y-2">
      <div v-for="(ev, i) in parsed.events" :key="i">
        <div class="flex flex-wrap items-center gap-1">
          <span class="font-medium text-gray-800 dark:text-gray-200">{{ ev.label }}</span>
          <template v-for="(seg, j) in ev.icons" :key="`i${j}`">
            <img v-if="imgSrc(seg)" :src="imgSrc(seg)" :alt="seg.name" class="inline-block h-4 w-4 align-middle" loading="lazy">
          </template>
          <span v-if="ev.count" class="text-gray-500 dark:text-gray-400">{{ ev.count }}</span>
          <span v-if="ev.friend" class="text-gray-500 dark:text-gray-400">· {{ ev.friend }}</span>
        </div>
        <div v-if="ev.body.length" class="mt-0.5 flex flex-wrap items-center gap-0.5 text-xs leading-5 text-gray-600 dark:text-gray-300">
          <template v-for="(seg, j) in ev.body" :key="`b${j}`">
            <img v-if="seg.type === 'img' && imgSrc(seg)" :src="imgSrc(seg)" :alt="seg.name" class="inline-block h-4 w-4 align-middle" loading="lazy">
            <span v-else-if="seg.type === 'text'">{{ seg.text }}</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
