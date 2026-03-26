import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsDelivrFileNode, PackageFileTree } from '#shared/types'

const getLatestVersionMock = vi.hoisted(() => vi.fn())

vi.mock('fast-npm-meta', () => ({
  getLatestVersion: getLatestVersionMock,
}))

vi.stubGlobal('defineCachedFunction', (fn: Function) => fn)

const $fetchMock = vi.fn()
vi.stubGlobal('$fetch', $fetchMock)
vi.stubGlobal('encodePackageName', (packageName: string) => packageName)
vi.stubGlobal(
  'hasBuiltInTypes',
  (pkg: { types?: string; typings?: string }) => !!pkg.types || !!pkg.typings,
)
vi.stubGlobal('getTypesPackageName', (packageName: string) => `@types/${packageName}`)

const { convertToFileTree, fetchFileTree, getPackageFileTree, fetchPackageWithTypesAndFiles } =
  await import('#server/utils/file-tree')

const getChildren = (node?: PackageFileTree): PackageFileTree[] => node?.children ?? []

const mockFetchOk = <T>(body: T) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const mockFetchError = (status: number) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const mockCreateError = () => {
  const createErrorMock = vi.fn((opts: { statusCode: number; message: string }) => opts)
  vi.stubGlobal('createError', createErrorMock)
  return createErrorMock
}

beforeEach(() => {
  $fetchMock.mockReset()
  getLatestVersionMock.mockReset()
  vi.stubGlobal('fetch', vi.fn())
})

describe('convertToFileTree', () => {
  it('converts jsDelivr nodes to a sorted tree with directories first', () => {
    const input: JsDelivrFileNode[] = [
      { type: 'file', name: 'zeta.txt', size: 120 },
      {
        type: 'directory',
        name: 'src',
        files: [
          { type: 'file', name: 'b.ts', size: 5 },
          { type: 'file', name: 'a.ts', size: 3 },
        ],
      },
      { type: 'file', name: 'alpha.txt', size: 10 },
      {
        type: 'directory',
        name: 'assets',
        files: [{ type: 'file', name: 'logo-icon.svg', size: 42 }],
      },
    ]

    const tree = convertToFileTree(input)

    const names = tree.map(node => node.name)
    expect(names).toEqual(['assets', 'src', 'alpha.txt', 'zeta.txt'])

    const srcNode = tree.find(node => node.name === 'src')
    expect(srcNode?.type).toBe('directory')
    expect(getChildren(srcNode).map(child => child.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('builds correct paths and preserves file sizes', () => {
    const input: JsDelivrFileNode[] = [
      {
        type: 'directory',
        name: 'src',
        files: [
          { type: 'file', name: 'index.ts', size: 100 },
          {
            type: 'directory',
            name: 'utils',
            files: [{ type: 'file', name: 'format.ts', size: 22 }],
          },
        ],
      },
    ]

    const tree = convertToFileTree(input)

    const src = tree[0]
    expect(src?.path).toBe('src')

    const indexFile = getChildren(src).find(child => child.name === 'index.ts')
    expect(indexFile?.path).toBe('src/index.ts')
    expect(indexFile?.size).toBe(100)

    const utilsDir = getChildren(src).find(child => child.name === 'utils')
    expect(utilsDir?.type).toBe('directory')

    const formatFile = getChildren(utilsDir).find(child => child.name === 'format.ts')
    expect(formatFile?.path).toBe('src/utils/format.ts')
    expect(formatFile?.size).toBe(22)
    expect(utilsDir?.size).toBe(22)
    expect(src?.size).toBe(122)
  })

  it('returns an empty tree for empty input', () => {
    const tree = convertToFileTree([])
    const empty: PackageFileTree[] = []
    expect(tree).toEqual(empty)
  })

  it('handles directories without a files property', () => {
    const input: JsDelivrFileNode[] = [
      {
        type: 'directory',
        name: 'src',
      },
    ]

    const tree = convertToFileTree(input)

    expect(tree[0]?.type).toBe('directory')
    expect(tree[0]?.size).toBe(0)
    expect(tree[0]?.children).toEqual([])
  })
})

describe('fetchFileTree', () => {
  it('returns parsed json when response is ok', async () => {
    const body = {
      type: 'npm',
      name: 'pkg',
      version: '1.0.0',
      default: 'index.js',
      files: [],
    }

    mockFetchOk(body)

    const result = await fetchFileTree('pkg', '1.0.0')
    expect(result).toEqual(body)
  })

  it('throws a 404 error when package is not found', async () => {
    mockFetchError(404)
    mockCreateError()

    await expect(fetchFileTree('pkg', '1.0.0')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws a 502 error for non-404 failures', async () => {
    mockFetchError(500)
    mockCreateError()

    await expect(fetchFileTree('pkg', '1.0.0')).rejects.toMatchObject({ statusCode: 502 })
  })
})

describe('getPackageFileTree', () => {
  it('returns metadata and a converted tree', async () => {
    const body = {
      type: 'npm',
      name: 'pkg',
      version: '1.0.0',
      default: 'index.js',
      files: [
        {
          type: 'directory',
          name: 'src',
          files: [{ type: 'file', name: 'index.js', size: 5 }],
        },
      ],
    }

    mockFetchOk(body)

    const result = await getPackageFileTree('pkg', '1.0.0')
    expect(result.package).toBe('pkg')
    expect(result.version).toBe('1.0.0')
    expect(result.default).toBe('index.js')
    expect(result.tree[0]?.path).toBe('src')
    expect(result.tree[0]?.children?.[0]?.path).toBe('src/index.js')
  })

  it('returns undefined when default is missing', async () => {
    const body = {
      type: 'npm',
      name: 'pkg',
      version: '1.0.0',
      files: [],
    }

    mockFetchOk(body)

    const result = await getPackageFileTree('pkg', '1.0.0')
    expect(result.default).toBeUndefined()
  })
})

describe('fetchPackageWithTypesAndFiles', () => {
  it('returns package metadata and flattened files when types are external', async () => {
    $fetchMock.mockResolvedValue({
      name: 'pkg',
      version: '1.0.0',
      readme: '# docs',
    })
    getLatestVersionMock.mockResolvedValue({
      version: '2.0.0',
      deprecated: 'use bundled types',
    })

    mockFetchOk({
      type: 'npm',
      name: 'pkg',
      version: '1.0.0',
      files: [
        {
          type: 'directory',
          name: 'src',
          files: [{ type: 'file', name: 'index.ts', size: 5 }],
        },
      ],
    })

    const result = await fetchPackageWithTypesAndFiles('pkg', '1.0.0')

    expect($fetchMock).toHaveBeenCalledWith('https://registry.npmjs.org/pkg/1.0.0')
    expect(result.pkg.version).toBe('1.0.0')
    expect(result.typesPackage).toEqual({
      packageName: '@types/pkg',
      deprecated: 'use bundled types',
    })
    expect(result.files).toEqual(new Set(['src/index.ts']))
  })

  it('skips types and file tree lookups when package ships built-in types', async () => {
    $fetchMock.mockResolvedValue({
      name: 'pkg',
      version: '1.0.0',
      types: './index.d.ts',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchPackageWithTypesAndFiles('pkg', '1.0.0')

    expect(result.typesPackage).toBeUndefined()
    expect(result.files).toBeUndefined()
    expect(getLatestVersionMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
