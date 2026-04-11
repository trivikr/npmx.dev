let vueDataUiStylePromise: Promise<unknown> | null = null

export async function ensureVueDataUiStyle() {
  if (import.meta.server) return

  vueDataUiStylePromise ??= import('vue-data-ui/style.css')
  await vueDataUiStylePromise
}
