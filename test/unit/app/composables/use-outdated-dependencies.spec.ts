import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackageVersionsInfo } from 'fast-npm-meta'

vi.mock('fast-npm-meta', () => ({
  getVersionsBatch: vi.fn(),
}))

import { getVersionsBatch } from 'fast-npm-meta'
import { useOutdatedDependencies } from '~/composables/npm/useOutdatedDependencies'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void

  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

function createVersionInfo(name: string, versions: string[], latest: string): PackageVersionsInfo {
  return {
    name,
    versions,
    distTags: { latest },
  } as PackageVersionsInfo
}

describe('useOutdatedDependencies', () => {
  beforeEach(() => {
    vi.mocked(getVersionsBatch).mockReset()
  })

  it('ignores results from superseded requests', async () => {
    const firstRequest = deferred<PackageVersionsInfo[]>()
    const secondRequest = deferred<PackageVersionsInfo[]>()

    vi.mocked(getVersionsBatch).mockImplementation(([name]) => {
      if (name === 'left-pad') return firstRequest.promise
      if (name === 'react') return secondRequest.promise
      throw new Error(`Unexpected package lookup: ${name}`)
    })

    const dependencies = ref<Record<string, string> | undefined>({
      'left-pad': '^1.0.0',
    })
    const outdated = useOutdatedDependencies(dependencies)

    await nextTick()

    dependencies.value = {
      react: '^18.0.0',
    }

    await nextTick()

    secondRequest.resolve([createVersionInfo('react', ['18.0.0', '18.3.1', '19.0.0'], '19.0.0')])

    await vi.waitFor(() => {
      expect(outdated.value).toEqual({
        react: {
          resolved: '18.3.1',
          latest: '19.0.0',
          majorsBehind: 1,
          minorsBehind: 0,
          diffType: 'major',
        },
      })
    })

    firstRequest.resolve([createVersionInfo('left-pad', ['1.0.0', '1.3.0', '2.0.0'], '2.0.0')])

    await Promise.resolve()
    await nextTick()

    expect(outdated.value).toEqual({
      react: {
        resolved: '18.3.1',
        latest: '19.0.0',
        majorsBehind: 1,
        minorsBehind: 0,
        diffType: 'major',
      },
    })
  })

  it('clears stale state when the active request fails', async () => {
    const failingRequest = deferred<PackageVersionsInfo[]>()

    vi.mocked(getVersionsBatch).mockImplementation(([name]) => {
      if (name === 'left-pad') {
        return Promise.resolve([
          createVersionInfo('left-pad', ['1.0.0', '1.3.0', '2.0.0'], '2.0.0'),
        ])
      }
      if (name === 'react') return failingRequest.promise
      throw new Error(`Unexpected package lookup: ${name}`)
    })

    const dependencies = ref<Record<string, string> | undefined>({
      'left-pad': '^1.0.0',
    })
    const outdated = useOutdatedDependencies(dependencies)

    await vi.waitFor(() => {
      expect(outdated.value['left-pad']).toBeDefined()
    })

    dependencies.value = {
      react: '^18.0.0',
    }

    await nextTick()

    failingRequest.reject(new Error('fast-npm-meta outage'))

    await vi.waitFor(() => {
      expect(outdated.value).toEqual({})
    })
  })
})
