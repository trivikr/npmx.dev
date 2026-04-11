import type { PackageVersionsInfo } from 'fast-npm-meta'
import { getVersionsBatch } from 'fast-npm-meta'
import { maxSatisfying, prerelease, major, minor, diff, gt } from 'semver'
import { shallowRef, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import {
  type OutdatedDependencyInfo,
  isNonSemverConstraint,
  constraintIncludesPrerelease,
} from '~/utils/npm/outdated-dependencies'

const BATCH_SIZE = 50

function resolveOutdated(
  versions: string[],
  latestTag: string,
  constraint: string,
): OutdatedDependencyInfo | null {
  if (constraint === 'latest') {
    return {
      resolved: latestTag,
      latest: latestTag,
      majorsBehind: 0,
      minorsBehind: 0,
      diffType: null,
    }
  }

  let filteredVersions = versions
  if (!constraintIncludesPrerelease(constraint)) {
    filteredVersions = versions.filter(v => !prerelease(v))
  }

  const resolved = maxSatisfying(filteredVersions, constraint)
  if (!resolved) return null

  if (resolved === latestTag) return null

  // Resolved is newer than latest (e.g. ^2.0.0-rc when latest is 1.x)
  if (gt(resolved, latestTag)) {
    return null
  }

  const diffType = diff(resolved, latestTag)
  const majorsBehind = major(latestTag) - major(resolved)
  const minorsBehind = majorsBehind === 0 ? minor(latestTag) - minor(resolved) : 0

  return {
    resolved,
    latest: latestTag,
    majorsBehind,
    minorsBehind,
    diffType,
  }
}

/**
 * Check for outdated dependencies via fast-npm-meta batch version lookups.
 * Returns a reactive map of dependency name to outdated info.
 */
export function useOutdatedDependencies(
  dependencies: MaybeRefOrGetter<Record<string, string> | undefined>,
) {
  const outdated = shallowRef<Record<string, OutdatedDependencyInfo>>({})
  let activeRequestId = 0

  async function fetchOutdatedInfo(deps: Record<string, string> | undefined) {
    const requestId = ++activeRequestId
    const commit = (results: Record<string, OutdatedDependencyInfo>) => {
      if (requestId === activeRequestId) {
        outdated.value = results
      }
    }

    if (!deps || Object.keys(deps).length === 0) {
      commit({})
      return
    }

    const semverEntries = Object.entries(deps).filter(
      ([, constraint]) => !isNonSemverConstraint(constraint),
    )

    if (semverEntries.length === 0) {
      commit({})
      return
    }

    const packageNames = semverEntries.map(([name]) => name)

    const chunks: string[][] = []
    for (let i = 0; i < packageNames.length; i += BATCH_SIZE) {
      chunks.push(packageNames.slice(i, i + BATCH_SIZE))
    }
    try {
      const batchResults = await Promise.all(
        chunks.map(chunk => getVersionsBatch(chunk, { throw: false })),
      )

      if (requestId !== activeRequestId) {
        return
      }
      const allVersionData = batchResults.flat()

      // Build a lookup map from package name to version data
      const versionMap = new Map<string, PackageVersionsInfo>()
      for (const data of allVersionData) {
        if ('error' in data) continue
        versionMap.set(data.name, data)
      }

      const results: Record<string, OutdatedDependencyInfo> = {}
      for (const [name, constraint] of semverEntries) {
        const data = versionMap.get(name)
        if (!data) continue

        const latestTag = data.distTags.latest
        if (!latestTag) continue

        const info = resolveOutdated(data.versions, latestTag, constraint)
        if (info) {
          results[name] = info
        }
      }

      commit(results)
    } catch {
      commit({})
    }
  }

  watch(
    () => toValue(dependencies),
    deps => {
      void fetchOutdatedInfo(deps)
    },
    { immediate: true },
  )

  return outdated
}
