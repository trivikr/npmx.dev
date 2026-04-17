import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { CommandPaletteLoader } from '#components'

let commandPalette: ReturnType<typeof useCommandPalette> | null = null
let currentWrapper: Awaited<ReturnType<typeof mountSuspended>> | null = null

const CommandPaletteLoaderHarness = defineComponent({
  name: 'CommandPaletteLoaderHarness',
  setup() {
    commandPalette = useCommandPalette()
    return () => h(CommandPaletteLoader)
  },
})

async function flushLoader() {
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  vi.stubGlobal(
    'requestIdleCallback',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelIdleCallback', vi.fn())
})

afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null

  if (commandPalette) {
    commandPalette.announcement.value = ''
    commandPalette.close()
    commandPalette.clearPackageContext()
  }

  useSettings().settings.value.keyboardShortcuts = true
  commandPalette = null
  vi.unstubAllGlobals()
})

describe('CommandPaletteLoader', () => {
  it('mounts and toggles the palette with the global keyboard shortcut', async () => {
    currentWrapper = await mountSuspended(CommandPaletteLoaderHarness)
    await flushLoader()

    expect(document.getElementById('command-palette-modal-input')).toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'k' }))

    await vi.waitFor(() => {
      expect(commandPalette?.isOpen.value).toBe(true)
      expect(document.getElementById('command-palette-modal-input')).not.toBeNull()
    })

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'k' }))
    await flushLoader()

    expect(commandPalette?.isOpen.value).toBe(false)
  })

  it('ignores the global keyboard shortcut when shortcuts are disabled', async () => {
    currentWrapper = await mountSuspended(CommandPaletteLoaderHarness)
    await flushLoader()

    useSettings().settings.value.keyboardShortcuts = false

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'k' }))
    await flushLoader()

    expect(commandPalette?.isOpen.value).toBe(false)
    expect(document.getElementById('command-palette-modal-input')).toBeNull()
  })
})
