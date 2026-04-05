export function useFileTreeState(baseUrl: string) {
  const expanded = useState<Set<string>>(`npmx-file-tree${baseUrl}`, () => new Set<string>())

  function toggleDir(path: string) {
    if (expanded.value.has(path)) {
      expanded.value.delete(path)
    } else {
      expanded.value.add(path)
    }
    expanded.value = new Set(expanded.value)
  }

  function isExpanded(path: string) {
    return expanded.value.has(path)
  }

  function autoExpandAncestors(path: string) {
    if (!path) return
    const parts = path.split('/').filter(Boolean)
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      expanded.value.add(prefix)
    }
    expanded.value = new Set(expanded.value)
  }

  return {
    toggleDir,
    isExpanded,
    autoExpandAncestors,
  }
}
