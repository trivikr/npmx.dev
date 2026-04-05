import type { ModuleFormat, TypesStatus, CreatePackageInfo } from '#shared/utils/package-analysis'
import type { DevDependencySuggestion } from '#shared/utils/dev-dependency'

export interface PackageAnalysisResponse {
  package: string
  version: string
  moduleFormat: ModuleFormat
  types: TypesStatus
  devDependencySuggestion: DevDependencySuggestion
  engines?: {
    node?: string
    npm?: string
  }
  createPackage?: CreatePackageInfo
}

/**
 * Composable for fetching package analysis data (module format, types info, etc.)
 */
interface UsePackageAnalysisOptions {
  immediate?: boolean
  server?: boolean
  lazy?: boolean
}

export function usePackageAnalysis(
  packageName: MaybeRefOrGetter<string>,
  version?: MaybeRefOrGetter<string | null | undefined>,
  options: UsePackageAnalysisOptions = {},
) {
  return useLazyFetch<PackageAnalysisResponse>(
    () => {
      const name = toValue(packageName)
      const ver = toValue(version)
      const base = `/api/registry/analysis/${name}`
      return ver ? `${base}/v/${ver}` : base
    },
    {
      key: () => `package-analysis:${toValue(packageName)}:${toValue(version) ?? ''}`,
      ...options,
    },
  )
}
