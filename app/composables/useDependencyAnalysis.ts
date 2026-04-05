/**
 * Shared composable for dependency analysis data (vulnerabilities, deprecated packages).
 * Fetches once and caches the result so multiple components can use it.
 * Before: useVulnerabilityTree - but now we use this for both vulnerabilities and deprecated packages.
 */
interface UseDependencyAnalysisOptions {
  immediate?: boolean
  server?: boolean
  lazy?: boolean
}

export function useDependencyAnalysis(
  packageName: MaybeRefOrGetter<string>,
  version: MaybeRefOrGetter<string>,
  options: UseDependencyAnalysisOptions = {},
) {
  return useFetch<VulnerabilityTreeResult>(
    () =>
      `/api/registry/vulnerabilities/${encodePackageName(toValue(packageName))}/v/${toValue(version)}`,
    {
      key: () => `dependency-analysis:${toValue(packageName)}:${toValue(version)}`,
      ...options,
    },
  )
}
