import { beforeEach, describe, expect, it, vi } from 'vitest'

const { docMock } = vi.hoisted(() => ({
  docMock: vi.fn(),
}))

vi.mock('@deno/doc', () => ({
  doc: docMock,
}))

const fetchRawMock = vi.fn()
const storageMap = new Map<string, unknown>()
const storage = {
  getItem: vi.fn(async (key: string) => storageMap.get(key)),
  setItem: vi.fn(async (key: string, value: unknown) => {
    storageMap.set(key, value)
  }),
  removeItem: vi.fn(async (key: string) => {
    storageMap.delete(key)
  }),
}

describe('docs client caching', () => {
  beforeEach(() => {
    vi.resetModules()
    docMock.mockReset()
    fetchRawMock.mockReset()
    storageMap.clear()
    storage.getItem.mockClear()
    storage.setItem.mockClear()
    storage.removeItem.mockClear()
    vi.stubGlobal('$fetch', { raw: fetchRawMock })
    vi.stubGlobal(
      'useStorage',
      vi.fn(() => storage),
    )
  })

  it('reuses cached esm.sh metadata and module bodies across doc generation calls', async () => {
    fetchRawMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === 'HEAD') {
        return {
          headers: new Headers({
            'x-typescript-types': 'https://esm.sh/pkg@1.0.0/index.d.ts',
          }),
        }
      }

      return {
        status: 200,
        url,
        headers: new Headers({
          'content-type': 'application/typescript',
        }),
        _data: new Blob(['export const value = 1']),
      }
    })

    docMock.mockImplementation(
      async (specifiers: string[], options: { load: (specifier: string) => Promise<unknown> }) => {
        await options.load(specifiers[0]!)
        return { [specifiers[0]!]: [] }
      },
    )

    const { getDocNodes } = await import('#server/utils/docs/client')

    await getDocNodes('pkg', '1.0.0')
    await getDocNodes('pkg', '1.0.0')

    expect(docMock).toHaveBeenCalledTimes(2)
    expect(fetchRawMock).toHaveBeenCalledTimes(2)
    expect(fetchRawMock).toHaveBeenNthCalledWith(
      1,
      'https://esm.sh/pkg@1.0.0',
      expect.objectContaining({ method: 'HEAD' }),
    )
    expect(fetchRawMock).toHaveBeenNthCalledWith(
      2,
      'https://esm.sh/pkg@1.0.0/index.d.ts',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(storage.setItem).toHaveBeenCalledTimes(2)
  })
})
