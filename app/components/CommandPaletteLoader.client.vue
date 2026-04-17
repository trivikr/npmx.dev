<script setup lang="ts">
const { isOpen, toggle } = useCommandPalette()
const keyboardShortcuts = useKeyboardShortcuts()
const shouldMount = shallowRef(false)

const CommandPalette = defineAsyncComponent(() => import('~/components/CommandPalette.client.vue'))

let idleCallbackId: number | null = null
let idleTimeoutId: number | null = null

function mountPalette() {
  if (shouldMount.value) return

  shouldMount.value = true

  if (idleCallbackId != null && 'cancelIdleCallback' in window) {
    window.cancelIdleCallback(idleCallbackId)
  }

  if (idleTimeoutId != null) {
    window.clearTimeout(idleTimeoutId)
  }

  idleCallbackId = null
  idleTimeoutId = null
}

function handleToggleShortcut(event: KeyboardEvent) {
  if (event.isComposing) return

  const isToggleShortcut =
    event.key.toLowerCase() === 'k' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey

  if (!isToggleShortcut || !keyboardShortcuts.value) return

  event.preventDefault()
  mountPalette()
  toggle()
}

watch(
  isOpen,
  open => {
    if (open) {
      mountPalette()
    }
  },
  { immediate: true },
)

useEventListener(document, 'keydown', handleToggleShortcut)

onMounted(() => {
  if (shouldMount.value) return

  if ('requestIdleCallback' in window) {
    idleCallbackId = window.requestIdleCallback(mountPalette, { timeout: 2000 })
    return
  }

  idleTimeoutId = window.setTimeout(mountPalette, 1500)
})

onUnmounted(() => {
  if (idleCallbackId != null && 'cancelIdleCallback' in window) {
    window.cancelIdleCallback(idleCallbackId)
  }

  if (idleTimeoutId != null) {
    window.clearTimeout(idleTimeoutId)
  }
})
</script>

<template>
  <component :is="CommandPalette" v-if="shouldMount" />
</template>
