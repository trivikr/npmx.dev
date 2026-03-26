import { getLatestVersion } from 'fast-npm-meta'
import { flattenFileTree } from '#server/utils/import-resolver'
import {
  CACHE_MAX_AGE_FIVE_MINUTES,
  CACHE_MAX_AGE_ONE_DAY,
  CACHE_MAX_AGE_ONE_YEAR,
  NPM_REGISTRY,
} from '#shared/utils/constants'
import type { ExtendedPackageJson, TypesPackageInfo } from '#shared/utils/package-analysis'

/**
 * Fetch the file tree from jsDelivr API.
 * Returns a nested tree structure of all files in the package.
 */
async function fetchFileTreeRaw(
  packageName: string,
  version: string,
  signal?: AbortSignal,
): Promise<JsDelivrPackageResponse> {
  const url = `https://data.jsdelivr.com/v1/packages/npm/${packageName}@${version}`
  const response = await fetch(url, { signal })

  if (!response.ok) {
    if (response.status === 404) {
      throw createError({ statusCode: 404, message: 'Package or version not found' })
    }
    throw createError({ statusCode: 502, message: 'Failed to fetch file list from jsDelivr' })
  }

  return response.json()
}

const fetchFileTreeCached = defineCachedFunction(
  async (packageName: string, version: string): Promise<JsDelivrPackageResponse> =>
    fetchFileTreeRaw(packageName, version),
  {
    maxAge: CACHE_MAX_AGE_ONE_YEAR,
    swr: true,
    name: 'package-file-tree',
    getKey: (packageName: string, version: string) => `${packageName}@${version}`,
  },
)

export async function fetchFileTree(
  packageName: string,
  version: string,
  signal?: AbortSignal,
): Promise<JsDelivrPackageResponse> {
  if (signal) {
    return fetchFileTreeRaw(packageName, version, signal)
  }

  return fetchFileTreeCached(packageName, version)
}

/**
 * Convert jsDelivr nested structure to our PackageFileTree format
 */
export function convertToFileTree(
  nodes: JsDelivrFileNode[],
  parentPath: string = '',
): PackageFileTree[] {
  const result: PackageFileTree[] = []

  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name

    if (node.type === 'directory') {
      const children = node.files ? convertToFileTree(node.files, path) : []

      result.push({
        name: node.name,
        path,
        type: 'directory',
        size: children.reduce((total, child) => total + (child.size ?? 0), 0),
        children,
      })
    } else {
      result.push({
        name: node.name,
        path,
        type: 'file',
        hash: node.hash,
        size: node.size,
      })
    }
  }

  // Sort: directories first, then files, alphabetically within each group
  result.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  return result
}

/**
 * Fetch and convert file tree for a package version.
 * Returns the full response including tree and metadata.
 */
export async function getPackageFileTree(
  packageName: string,
  version: string,
  signal?: AbortSignal,
): Promise<PackageFileTreeResponse> {
  const jsDelivrData = await fetchFileTree(packageName, version, signal)
  const tree = convertToFileTree(jsDelivrData.files)

  return {
    package: packageName,
    version,
    default: jsDelivrData.default ?? undefined,
    tree,
  }
}

/**
 * Fetch @types package info including deprecation status using fast-npm-meta.
 * Returns undefined if the package doesn't exist.
 */
const fetchTypesPackageInfo = defineCachedFunction(
  async (packageName: string): Promise<TypesPackageInfo | undefined> => {
    const result = await getLatestVersion(packageName, { metadata: true, throw: false })
    if ('error' in result) {
      return undefined
    }
    return {
      packageName,
      deprecated: result.deprecated,
    }
  },
  {
    maxAge: CACHE_MAX_AGE_ONE_DAY,
    swr: true,
    name: 'types-package-info',
    getKey: (packageName: string) => packageName,
  },
)

interface AnalysisPackageJson extends ExtendedPackageJson {
  readme?: string
}

async function fetchPackageVersionRaw(
  packageName: string,
  version?: string,
): Promise<AnalysisPackageJson> {
  const encodedName = encodePackageName(packageName)
  const versionSuffix = version ? `/${version}` : '/latest'
  return $fetch<AnalysisPackageJson>(`${NPM_REGISTRY}/${encodedName}${versionSuffix}`)
}

const fetchLatestPackageVersion = defineCachedFunction(
  async (packageName: string): Promise<AnalysisPackageJson> => fetchPackageVersionRaw(packageName),
  {
    maxAge: CACHE_MAX_AGE_FIVE_MINUTES,
    swr: true,
    name: 'package-version-latest',
    getKey: (packageName: string) => packageName,
  },
)

const fetchSpecificPackageVersion = defineCachedFunction(
  async (packageName: string, version: string): Promise<AnalysisPackageJson> =>
    fetchPackageVersionRaw(packageName, version),
  {
    maxAge: CACHE_MAX_AGE_ONE_YEAR,
    swr: true,
    name: 'package-version',
    getKey: (packageName: string, version: string) => `${packageName}@${version}`,
  },
)

async function fetchPackageVersion(
  packageName: string,
  version?: string,
): Promise<AnalysisPackageJson> {
  if (version) {
    return fetchSpecificPackageVersion(packageName, version)
  }

  return fetchLatestPackageVersion(packageName)
}

interface PackageWithTypesAndFilesCached {
  pkg: AnalysisPackageJson
  typesPackage?: TypesPackageInfo
  files?: string[]
}

async function fetchPackageWithTypesAndFilesRaw(
  packageName: string,
  version?: string,
): Promise<PackageWithTypesAndFilesCached> {
  const pkg = await fetchPackageVersion(packageName, version)
  let typesPackage: TypesPackageInfo | undefined
  let files: string[] | undefined

  // Only attempt to fetch @types + file tree when the package doesn't ship its own types
  if (!hasBuiltInTypes(pkg)) {
    const typesPkgName = getTypesPackageName(packageName)
    const resolvedVersion = pkg.version ?? version ?? 'latest'

    // Fetch both in parallel — they're independent
    const [typesResult, fileTreeResult] = await Promise.allSettled([
      fetchTypesPackageInfo(typesPkgName),
      getPackageFileTree(packageName, resolvedVersion),
    ])

    if (typesResult.status === 'fulfilled') {
      typesPackage = typesResult.value
    }

    if (fileTreeResult.status === 'fulfilled') {
      files = [...flattenFileTree(fileTreeResult.value.tree)]
    }
  }

  return { pkg, typesPackage, files }
}

const fetchPackageWithTypesAndFilesLatestCached = defineCachedFunction(
  async (packageName: string): Promise<PackageWithTypesAndFilesCached> =>
    fetchPackageWithTypesAndFilesRaw(packageName),
  {
    maxAge: CACHE_MAX_AGE_FIVE_MINUTES,
    swr: true,
    name: 'package-types-and-files-latest',
    getKey: (packageName: string) => packageName,
  },
)

const fetchPackageWithTypesAndFilesVersionCached = defineCachedFunction(
  async (packageName: string, version: string): Promise<PackageWithTypesAndFilesCached> =>
    fetchPackageWithTypesAndFilesRaw(packageName, version),
  {
    maxAge: CACHE_MAX_AGE_ONE_YEAR,
    swr: true,
    name: 'package-types-and-files',
    getKey: (packageName: string, version: string) => `${packageName}@${version}`,
  },
)

export async function fetchPackageWithTypesAndFiles(
  packageName: string,
  version?: string,
): Promise<{
  pkg: AnalysisPackageJson
  typesPackage?: TypesPackageInfo
  files?: Set<string>
}> {
  const result = version
    ? await fetchPackageWithTypesAndFilesVersionCached(packageName, version)
    : await fetchPackageWithTypesAndFilesLatestCached(packageName)

  return {
    pkg: result.pkg,
    typesPackage: result.typesPackage,
    files: result.files ? new Set(result.files) : undefined,
  }
}
