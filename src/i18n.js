/**
 * Thin wrapper over chrome.i18n. The packaged _locales/en catalogue always
 * exists, so getMessage only comes back empty for a typo'd key — in that
 * case the key itself is returned, which makes the mistake visible instead
 * of rendering a blank element. Outside an extension context (unit tests)
 * the key is returned too.
 */
export function t(key, substitutions) {
  const api = globalThis.chrome?.i18n || globalThis.browser?.i18n
  const message = api?.getMessage?.(key, substitutions)
  return message || key
}

/**
 * Localise static markup in place. Elements opt in via data attributes:
 *   data-i18n="key"              → textContent
 *   data-i18n-placeholder="key"  → placeholder attribute
 *   data-i18n-title="key"        → title attribute
 *
 * The HTML keeps its English text as authored, so a missing key (t returns
 * the key, which never equals the message) leaves the fallback intact.
 */
export function localiseDocument(root = globalThis.document) {
  if (!root?.querySelectorAll) return
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const message = t(el.dataset.i18n)
    if (message !== el.dataset.i18n) el.textContent = message
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const message = t(el.dataset.i18nPlaceholder)
    if (message !== el.dataset.i18nPlaceholder) el.placeholder = message
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const message = t(el.dataset.i18nTitle)
    if (message !== el.dataset.i18nTitle) el.title = message
  }
}
