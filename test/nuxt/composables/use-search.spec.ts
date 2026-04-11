import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, watchEffect, type Ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'

const searchNpmMock = vi.fn()
const checkOrgExistsMock = vi.fn()
const checkUserExistsMock = vi.fn()
const searchAlgoliaMock = vi.fn()
const searchWithSuggestionsMock = vi.fn()

mockNuxtImport('useNpmSearch', () => {
  return () => ({
    search: searchNpmMock,
    checkOrgExists: checkOrgExistsMock,
    checkUserExists: checkUserExistsMock,
  })
})

mockNuxtImport('useAlgoliaSearch', () => {
  return () => ({
    search: searchAlgoliaMock,
    searchWithSuggestions: searchWithSuggestionsMock,
  })
})

async function mountUseSearchHarness(initialQuery: string) {
  const query = ref(initialQuery)
  const provider = ref<'npm'>('npm')
  const packageAvailability = ref<{ name: string; available: boolean } | null>(null) as Ref<{
    name: string
    available: boolean
  } | null>
  const status = ref<'idle' | 'pending' | 'success' | 'error'>('idle')

  const { useSearch } = await import('~/composables/npm/useSearch')

  const Wrapper = defineComponent({
    setup() {
      const search = useSearch(query, provider, {}, { suggestions: true })

      watchEffect(() => {
        packageAvailability.value = search.packageAvailability.value
        status.value = search.status.value
      })

      return () => h('div')
    },
  })

  const wrapper = await mountSuspended(Wrapper)

  return {
    wrapper,
    query,
    packageAvailability,
    status,
  }
}

describe('useSearch package availability', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    searchNpmMock.mockResolvedValue({
      objects: [],
      total: 0,
      isStale: false,
      time: '2026-04-10T00:00:00.000Z',
    })
    checkOrgExistsMock.mockResolvedValue(false)
    checkUserExistsMock.mockResolvedValue(false)
    searchAlgoliaMock.mockReset()
    searchWithSuggestionsMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('clears package availability when the registry check fails', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 404 })

    const { wrapper, query, packageAvailability, status } =
      await mountUseSearchHarness('available-package')

    await vi.waitFor(() => {
      expect(status.value).toBe('success')
      expect(packageAvailability.value).toEqual({
        name: 'available-package',
        available: true,
      })
    })

    fetchMock.mockRejectedValueOnce(new Error('Network error'))
    query.value = 'uncertain-package'

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(packageAvailability.value).toBeNull()
    })

    wrapper.unmount()
  })
})
