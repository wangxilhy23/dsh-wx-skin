/**
 * dsh-wx-skin — local-path / URL vocabulary shared by the settings page and the
 * folder state machine. Pure string work, no DOM and no `node:path`: the value
 * travels between a Windows host and the page, so both separator styles must be
 * understood on either side.
 *
 * Why this exists: the skin now describes its background by PATH — the folder
 * row shows the folder, the local-file row shows the image's absolute path (or
 * its URL) — and a pasted file path has to be split into the folder the host may
 * scan.
 * @module dsh-wx-skin/client/skin-path
 */

/** Whether the value is a remote image URL the browser can paint directly. */
export function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

/**
 * Whether the value looks like an absolute local path: a Windows drive
 * (`C:\…`, `C:/…`), a UNC share (`\\server\share\…`), or a POSIX root (`/…`).
 * Relative paths are rejected — the host resolves against its own process cwd,
 * which the user cannot see.
 */
export function isAbsolutePath(value: string): boolean {
  const path = value.trim()
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  if (path.startsWith('\\\\') || path.startsWith('//')) return true
  return path.startsWith('/')
}

/** Last segment of a path or URL, separators and query stripped. */
export function pathBasename(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value
  const segments = withoutQuery.split(/[/\\]/).filter(segment => segment !== '')
  return segments[segments.length - 1] ?? ''
}

/**
 * Parent directory of an absolute path, in the path's own style.
 *
 * `D:\pics\a\b.png` → `D:\pics\a`; `/pics/b.png` → `/pics`; `C:\b.png` →
 * `C:\`; `\\server\share\b.png` → `\\server\share`. Returns null when the value
 * is not an absolute path or has no parent to scan (a bare volume root).
 * @param value - absolute path.
 * @returns the parent directory, or null when there is none.
 */
export function parentDirectory(value: string): string | null {
  const path = value.trim().replace(/[/\\]+$/, '')
  if (!isAbsolutePath(path)) return null
  const separator = path.includes('\\') ? '\\' : '/'
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  // A POSIX root (`/b.png`) has its separator at index 0; anything else without
  // a separator is not absolute.
  if (cut < 0 || (cut === 0 && !path.startsWith('/'))) return null
  const parent = path.slice(0, cut)
  if (parent === '') return separator
  // `D:\b.png` → `D:\`; an UNC share (`\\server\share\b.png`) needs no suffix.
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separator}`
  return parent
}

/**
 * Whether two absolute paths name the same file. Windows paths compare
 * case-insensitively and tolerate either separator; the host returns
 * canonicalized paths, the user types whatever Explorer showed.
 * @param left - first path.
 * @param right - second path.
 * @returns true when they may be the same file.
 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const unified = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:/.test(unified) || unified.startsWith('//') ? unified.toLowerCase() : unified
  }
  return normalize(left) === normalize(right)
}
