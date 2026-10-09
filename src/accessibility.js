// Keep keyboard users on the same control when a policy/list is rebuilt.
export function rememberFocus(container, fallback) {
  const focused = container.ownerDocument.activeElement
  if (!container.contains(focused)) return () => {}
  const key = focused.dataset.focusKey
  const controls = [...container.querySelectorAll('button, input, select')]
  const index = controls.indexOf(focused)
  return () => {
    const next = [...container.querySelectorAll('button, input, select')]
      .filter(element => element.getClientRects().length && !element.disabled)
    const target = next.find(element => key && element.dataset.focusKey === key)
      || next[Math.min(Math.max(index, 0), next.length - 1)]
    ;(target || fallback)?.focus()
  }
}
