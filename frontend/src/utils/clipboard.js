// frontend/src/utils/clipboard.js
// 兼容剪贴板复制：优先使用 Clipboard API，失败则降级到 execCommand

function legacyCopy(text) {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')

    // 避免页面滚动/闪烁
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'

    const activeEl = document.activeElement

    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)

    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')

    document.body.removeChild(textarea)
    if (activeEl && typeof activeEl.focus === 'function') activeEl.focus()

    return !!ok
  } catch {
    return false
  }
}

export async function copyToClipboard(input) {
  const text = typeof input === 'string' ? input : String(input ?? '')
  if (!text) return { ok: false, reason: 'empty' }

  // 现代 Clipboard API（通常要求 HTTPS；localhost 例外）
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return { ok: true, method: 'clipboard' }
    } catch {
      // 继续走降级
    }
  }

  // 降级：execCommand(copy)
  const ok = legacyCopy(text)
  if (ok) return { ok: true, method: 'execCommand' }

  return { ok: false, reason: 'not_supported' }
}
