/**
 * Filter pipeline and sorting logic for package lists
 */
import type { NpmSearchResult } from '#shared/types/npm-registry'
import type {
  DownloadRange,
  FilterChip,
  SearchScope,
  SecurityFilter,
  SortOption,
  StructuredFilters,
  UpdatedWithin,
} from '#shared/types/preferences'
import {
  DEFAULT_FILTERS,
  DOWNLOAD_RANGES,
  parseSortOption,
  UPDATED_WITHIN_OPTIONS,
} from '#shared/types/preferences'

/**
 * Parsed search operators from text input
 */
export interface ParsedSearchOperators {
  name?: string[]
  description?: string[]
  keywords?: string[]
  text?: string // Remaining text without operators
}

/**
 * Parse search operators from text input.
 * Supports: name:, desc:/description:, kw:/keyword:
 * Multiple values can be comma-separated: kw:foo,bar
 * Remaining text is treated as a general search term.
 *
 * Example: "name:react kw:typescript,hooks some text"
 * Returns: { name: ['react'], keywords: ['typescript', 'hooks'], text: 'some text' }
 */
export function parseSearchOperators(input: string): ParsedSearchOperators {
  const result: ParsedSearchOperators = {}

  // Regex to match operators: name:value, desc:value, description:value, kw:value, keyword:value
  // Value continues until whitespace or next operator
  const operatorRegex = /\b(name|desc|description|kw|keyword):(\S+)/gi

  let remaining = input
  let match

  while ((match = operatorRegex.exec(input)) !== null) {
    const [fullMatch, operator, value] = match
    if (!operator || !value) continue

    const values = value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)

    const normalizedOp = operator.toLowerCase()
    if (normalizedOp === 'name') {
      result.name = [...(result.name ?? []), ...values]
    } else if (normalizedOp === 'desc' || normalizedOp === 'description') {
      result.description = [...(result.description ?? []), ...values]
    } else if (normalizedOp === 'kw' || normalizedOp === 'keyword') {
      result.keywords = [...(result.keywords ?? []), ...values]
    }

    // Remove matched operator from remaining text
    remaining = remaining.replace(fullMatch, '')
  }

  // Clean up remaining text
  const cleanedText = remaining.trim().replace(/\s+/g, ' ')
  if (cleanedText) {
    result.text = cleanedText
  }

  // Deduplicate keywords (case-insensitive)
  if (result.keywords) {
    const seen = new Set<string>()
    result.keywords = result.keywords.filter(kw => {
      const lower = kw.toLowerCase()
      if (seen.has(lower)) return false
      seen.add(lower)
      return true
    })
  }

  return result
}

/**
 * Check if parsed operators has any content
 */
export function hasSearchOperators(parsed: ParsedSearchOperators): boolean {
  return !!(parsed.name?.length || parsed.description?.length || parsed.keywords?.length)
}

/**
 * Remove a keyword from a search query string.
 * Handles kw:xxx and keyword:xxx formats, including comma-separated values.
 */
export function removeKeywordFromQuery(query: string, keyword: string): string {
  const operatorRegex = /\b((?:kw|keyword):)(\S+)/gi
  const lowerKeyword = keyword.toLowerCase()

  let result = query.replace(operatorRegex, (match, prefix: string, value: string) => {
    const values = value.split(',').filter(Boolean)
    const filtered = values.filter(v => v.toLowerCase() !== lowerKeyword)

    if (filtered.length === 0) {
      // All values removed — drop the entire operator
      return ''
    }
    if (filtered.length === values.length) {
      // Nothing was removed — keep original
      return match
    }
    return `${prefix}${filtered.join(',')}`
  })

  // Clean up double spaces and trim
  result = result.replace(/\s+/g, ' ').trim()
  return result
}

interface UseStructuredFiltersOptions {
  packages: Ref<NpmSearchResult[]>
  searchQueryModel?: Ref<string>
  initialFilters?: Partial<StructuredFilters>
  initialSort?: SortOption
}

interface NormalizedTextFilter {
  rawText: string
  scope: SearchScope
  lowerText: string
  hasOperators: boolean
  nameTerms: string[]
  descriptionTerms: string[]
  keywordTerms: string[]
  remainingText: string
}

// Pure filter predicates (no closure dependencies)
function matchesKeywords(pkg: NpmSearchResult, keywords: ReadonlySet<string>): boolean {
  if (keywords.size === 0) return true
  const pkgKeywords = new Set((pkg.package.keywords ?? []).map(k => k.toLowerCase()))
  // AND logic: package must have ALL selected keywords (case-insensitive)
  for (const keyword of keywords) {
    if (!pkgKeywords.has(keyword)) return false
  }
  return true
}

function matchesSecurity(pkg: NpmSearchResult, security: SecurityFilter): boolean {
  if (security === 'all') return true
  const hasWarnings = (pkg.flags?.insecure ?? 0) > 0
  if (security === 'secure') return !hasWarnings
  if (security === 'warnings') return hasWarnings
  return true
}

function normalizeTextFilter(text: string, scope: SearchScope): NormalizedTextFilter {
  const rawText = text.trim()
  const lowerText = rawText.toLowerCase()

  if (!rawText || scope !== 'all') {
    return {
      rawText,
      scope,
      lowerText,
      hasOperators: false,
      nameTerms: [],
      descriptionTerms: [],
      keywordTerms: [],
      remainingText: '',
    }
  }

  const parsed = parseSearchOperators(rawText)

  return {
    rawText,
    scope,
    lowerText,
    hasOperators: hasSearchOperators(parsed),
    nameTerms: parsed.name?.map(term => term.toLowerCase()) ?? [],
    descriptionTerms: parsed.description?.map(term => term.toLowerCase()) ?? [],
    keywordTerms: parsed.keywords?.map(term => term.toLowerCase()) ?? [],
    remainingText: parsed.text?.toLowerCase() ?? '',
  }
}

/**
 * Composable for structured filtering and sorting of package lists
 *
 */
export function useStructuredFilters(options: UseStructuredFiltersOptions) {
  const route = useRoute()
  const router = useRouter()
  const { packages, initialFilters, initialSort, searchQueryModel } = options
  const { t } = useI18n()

  const searchQuery = shallowRef(normalizeSearchParam(route.query.q))

  // Filter state - must be declared before the watcher that uses it
  const filters = ref<StructuredFilters>({
    ...DEFAULT_FILTERS,
    ...initialFilters,
  })

  // Watch route query changes and sync filter state
  watch(
    () => route.query.q,
    urlQuery => {
      const value = normalizeSearchParam(urlQuery)
      if (searchQuery.value !== value) {
        searchQuery.value = value
      }

      // Sync filters with URL
      // When URL changes (e.g. from search input or navigation),
      // we need to update our local filter state to match
      const parsed = parseSearchOperators(value)

      filters.value.text = parsed.text ?? ''
      // Deduplicate keywords (in case of both kw: and keyword: for same value)
      filters.value.keywords = parsed.keywords ?? []

      // Note: We intentionally don't reset other filters (security, downloadRange, etc.)
      // as those are not typically driven by the search query string structure
    },
    { immediate: true },
  )

  // Sort state
  const sortOption = shallowRef<SortOption>(initialSort ?? 'updated-desc')

  // Available keywords extracted from all packages
  const availableKeywords = computed(() => {
    const keywordCounts = new Map<string, number>()
    for (const pkg of packages.value) {
      const keywords = pkg.package.keywords ?? []
      for (const keyword of keywords) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1)
      }
    }
    // Sort by count descending
    return Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([keyword]) => keyword)
  })

  const normalizedTextFilter = computed(() =>
    normalizeTextFilter(filters.value.text, filters.value.searchScope),
  )

  const selectedKeywords = computed(
    () => new Set(filters.value.keywords.map(keyword => keyword.toLowerCase())),
  )

  const selectedDownloadRange = computed(() =>
    DOWNLOAD_RANGES.find(range => range.value === filters.value.downloadRange),
  )

  const updatedWithinCutoff = computed(() => {
    const config = UPDATED_WITHIN_OPTIONS.find(option => option.value === filters.value.updatedWithin)
    if (!config?.days) return null

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - config.days)
    return cutoff.getTime()
  })

  // Filter predicates
  function matchesTextFilter(pkg: NpmSearchResult, filter: NormalizedTextFilter): boolean {
    if (!filter.rawText) return true

    const pkgName = pkg.package.name.toLowerCase()
    const pkgDescription = (pkg.package.description ?? '').toLowerCase()
    const pkgKeywords = (pkg.package.keywords ?? []).map(k => k.toLowerCase())

    // When scope is 'all', parse and handle operators
    if (filter.scope === 'all') {
      // If operators are present, use structured matching
      if (filter.hasOperators) {
        // All specified operators must match (AND logic between operator types)
        // Within each operator, any value can match (OR logic within operator)

        if (filter.nameTerms.length) {
          const nameMatches = filter.nameTerms.some(term => pkgName.includes(term))
          if (!nameMatches) return false
        }

        if (filter.descriptionTerms.length) {
          const descMatches = filter.descriptionTerms.some(term => pkgDescription.includes(term))
          if (!descMatches) return false
        }

        if (filter.keywordTerms.length) {
          const kwMatches = filter.keywordTerms.some(term =>
            pkgKeywords.some(keyword => keyword.includes(term)),
          )
          if (!kwMatches) return false
        }

        // If there's remaining text, it must match somewhere
        if (filter.remainingText) {
          const textMatches =
            pkgName.includes(filter.remainingText) ||
            pkgDescription.includes(filter.remainingText) ||
            pkgKeywords.some(keyword => keyword.includes(filter.remainingText))
          if (!textMatches) return false
        }

        return true
      }

      // No operators - fall through to standard 'all' search
      return (
        pkgName.includes(filter.lowerText) ||
        pkgDescription.includes(filter.lowerText) ||
        pkgKeywords.some(keyword => keyword.includes(filter.lowerText))
      )
    }

    // Non-'all' scopes - simple matching
    switch (filter.scope) {
      case 'name':
        return pkgName.includes(filter.lowerText)
      case 'description':
        return pkgDescription.includes(filter.lowerText)
      case 'keywords':
        return pkgKeywords.some(keyword => keyword.includes(filter.lowerText))
      default:
        return pkgName.includes(filter.lowerText)
    }
  }

  function matchesDownloadRange(
    pkg: NpmSearchResult,
    range: (typeof DOWNLOAD_RANGES)[number] | undefined,
  ): boolean {
    if (!range || range.value === 'any') return true
    const downloads = pkg.downloads?.weekly ?? 0
    if (range.min !== undefined && downloads < range.min) return false
    if (range.max !== undefined && downloads >= range.max) return false
    return true
  }

  function matchesUpdatedWithin(pkg: NpmSearchResult, cutoffTime: number | null): boolean {
    if (cutoffTime === null) return true
    return Date.parse(pkg.package.date) >= cutoffTime
  }

  // Apply all filters
  const filteredPackages = computed(() => {
    const textFilter = normalizedTextFilter.value
    const keywords = selectedKeywords.value
    const downloadRange = selectedDownloadRange.value
    const cutoffTime = updatedWithinCutoff.value
    const security = filters.value.security

    return packages.value.filter(pkg => {
      if (!matchesTextFilter(pkg, textFilter)) return false
      if (!matchesDownloadRange(pkg, downloadRange)) return false
      if (!matchesKeywords(pkg, keywords)) return false
      if (!matchesSecurity(pkg, security)) return false
      if (!matchesUpdatedWithin(pkg, cutoffTime)) return false
      return true
    })
  })

  // Sort comparators
  function comparePackages(a: NpmSearchResult, b: NpmSearchResult, option: SortOption): number {
    const { key, direction } = parseSortOption(option)
    const multiplier = direction === 'asc' ? 1 : -1

    let diff: number
    switch (key) {
      case 'downloads-week':
        diff = (a.downloads?.weekly ?? 0) - (b.downloads?.weekly ?? 0)
        break
      case 'downloads-day':
      case 'downloads-month':
      case 'downloads-year':
        // Not yet implemented - fall back to weekly
        diff = (a.downloads?.weekly ?? 0) - (b.downloads?.weekly ?? 0)
        break
      case 'updated':
        diff = Date.parse(a.package.date) - Date.parse(b.package.date)
        break
      case 'name':
        diff = a.package.name.localeCompare(b.package.name)
        break
      case 'relevance':
        // Relevance preserves server order (already sorted by search relevance)
        diff = 0
        break
      default:
        diff = 0
    }

    return diff * multiplier
  }

  // Apply sorting to filtered results
  const sortedPackages = computed(() => {
    return [...filteredPackages.value].sort((a, b) => comparePackages(a, b, sortOption.value))
  })

  // i18n key mappings for filter chip values
  const downloadRangeLabels = computed<Record<DownloadRange, string>>(() => ({
    'any': t('filters.download_range.any'),
    'lt100': t('filters.download_range.lt100'),
    '100-1k': t('filters.download_range.100_1k'),
    '1k-10k': t('filters.download_range.1k_10k'),
    '10k-100k': t('filters.download_range.10k_100k'),
    'gt100k': t('filters.download_range.gt100k'),
  }))

  const securityLabels = computed<Record<SecurityFilter, string>>(() => ({
    all: t('filters.security_options.all'),
    secure: t('filters.security_options.secure'),
    warnings: t('filters.security_options.insecure'),
  }))

  const updatedWithinLabels = computed<Record<UpdatedWithin, string>>(() => ({
    any: t('filters.updated.any'),
    week: t('filters.updated.week'),
    month: t('filters.updated.month'),
    quarter: t('filters.updated.quarter'),
    year: t('filters.updated.year'),
  }))

  // Active filter chips for display
  const activeFilters = computed<FilterChip[]>(() => {
    const chips: FilterChip[] = []

    if (filters.value.text) {
      chips.push({
        id: 'text',
        type: 'text',
        label: t('filters.chips.search'),
        value: filters.value.text,
      })
    }

    if (filters.value.downloadRange !== 'any') {
      chips.push({
        id: 'downloadRange',
        type: 'downloadRange',
        label: t('filters.chips.downloads'),
        value: downloadRangeLabels.value[filters.value.downloadRange],
      })
    }

    for (const keyword of filters.value.keywords) {
      chips.push({
        id: `keyword-${keyword}`,
        type: 'keywords',
        label: t('filters.chips.keyword'),
        value: keyword,
      })
    }

    if (filters.value.security !== 'all') {
      chips.push({
        id: 'security',
        type: 'security',
        label: t('filters.chips.security'),
        value: securityLabels.value[filters.value.security],
      })
    }

    if (filters.value.updatedWithin !== 'any') {
      chips.push({
        id: 'updatedWithin',
        type: 'updatedWithin',
        label: t('filters.chips.updated'),
        value: updatedWithinLabels.value[filters.value.updatedWithin],
      })
    }

    return chips
  })

  // Check if any filters are active
  const hasActiveFilters = computed(() => activeFilters.value.length > 0)

  // Filter update helpers
  function setTextFilter(text: string) {
    filters.value.text = text
  }

  function setSearchScope(scope: SearchScope) {
    filters.value.searchScope = scope
  }

  function setDownloadRange(range: DownloadRange) {
    filters.value.downloadRange = range
  }

  function addKeyword(keyword: string) {
    const lowerKeyword = keyword.toLowerCase()
    const alreadyExists = filters.value.keywords.some(k => k.toLowerCase() === lowerKeyword)
    if (!alreadyExists) {
      filters.value.keywords = [...filters.value.keywords, keyword]
      const newQ = searchQuery.value
        ? `${searchQuery.value.trim()} keyword:${keyword}`
        : `keyword:${keyword}`
      router.replace({ query: { ...route.query, q: newQ } })

      if (searchQueryModel) searchQueryModel.value = newQ
    }
  }

  function removeKeyword(keyword: string) {
    const lowerKeyword = keyword.toLowerCase()
    filters.value.keywords = filters.value.keywords.filter(k => k.toLowerCase() !== lowerKeyword)

    // Remove the keyword from the search query string.
    // Handles both kw:xxx and keyword:xxx formats, including comma-separated values.
    const newQ = removeKeywordFromQuery(searchQuery.value, keyword)

    router.replace({ query: { ...route.query, q: newQ || undefined } })
    if (searchQueryModel) searchQueryModel.value = newQ
  }

  function toggleKeyword(keyword: string) {
    const lowerKeyword = keyword.toLowerCase()
    const exists = filters.value.keywords.some(k => k.toLowerCase() === lowerKeyword)
    if (exists) {
      removeKeyword(keyword)
    } else {
      addKeyword(keyword)
    }
  }

  function setSecurity(security: SecurityFilter) {
    filters.value.security = security
  }

  function setUpdatedWithin(within: UpdatedWithin) {
    filters.value.updatedWithin = within
  }

  function clearFilter(chip: FilterChip) {
    switch (chip.type) {
      case 'text':
        filters.value.text = ''
        break
      case 'downloadRange':
        filters.value.downloadRange = 'any'
        break
      case 'keywords':
        removeKeyword(chip.value as string)
        break
      case 'security':
        filters.value.security = 'all'
        break
      case 'updatedWithin':
        filters.value.updatedWithin = 'any'
        break
    }
  }

  function clearAllFilters() {
    filters.value = { ...DEFAULT_FILTERS }
  }

  function setSort(option: SortOption) {
    sortOption.value = option
  }

  return {
    // State
    filters,
    sortOption,

    // Derived
    filteredPackages,
    sortedPackages,
    availableKeywords,
    activeFilters,
    hasActiveFilters,

    // Filter setters
    setTextFilter,
    setSearchScope,
    setDownloadRange,
    addKeyword,
    removeKeyword,
    toggleKeyword,
    setSecurity,
    setUpdatedWithin,
    clearFilter,
    clearAllFilters,

    // Sort setter
    setSort,
  }
}
