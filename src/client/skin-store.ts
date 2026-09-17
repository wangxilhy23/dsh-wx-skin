/**
 * dsh-wx-skin — pure skin settings state: defaults, sanitization, persistence
 * (localStorage), preset catalog, and the CSS-variable projection consumed by
 * the DOM applier. No DOM access here — tests exercise these functions with a
 * fake storage.
 * @module dsh-wx-skin/client/skin-store
 */
import type { SkinFolderImage, SkinOrderMode, SkinSettings, SkinSource } from '../core/types.ts'
import { MAX_CACHED_IMAGES, imageUrl } from './skin-folder.ts'

/** localStorage key holding the durable settings JSON. */
export const STORAGE_KEY = 'dsh-wx-skin.settings'

/** Document attribute that gates the global skin CSS (set on documentElement). */
export const ACTIVE_ATTR = 'data-wx-skin-active'

/** Attribute on the injected background layer div. */
export const LAYER_ATTR = 'data-wx-skin-layer'

/** Attribute on the injected sidebar entry button. */
export const ENTRY_ATTR = 'data-wx-skin-entry'

/** CSS custom properties the applier writes on documentElement. */
export const SKIN_CSS_VARS = [
  '--wx-skin-bg-image',
  '--wx-skin-bg-color',
  '--wx-skin-scrim',
  '--wx-skin-blur',
  '--wx-skin-surface',
] as const

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const SOURCES: readonly SkinSource[] = ['image', 'url', 'preset', 'folder', 'none']

const ORDER_MODES: readonly SkinOrderMode[] = ['sequential', 'random']

const MAX_DIM = 0.8
const MAX_BLUR = 24
/** Surface opacity bounds (0..1 — fully adjustable; readability is handled by the dim slider). */
export const MIN_SURFACE = 0
export const MAX_SURFACE = 1
export const DEFAULT_SURFACE = 0.72

/** Fresh defaults for a clean install. */
export const DEFAULT_SETTINGS: SkinSettings = Object.freeze({
  enabled: false,
  source: 'none',
  imageDataUrl: null,
  imageName: null,
  url: null,
  preset: null,
  dim: 0.35,
  blur: 0,
  surface: DEFAULT_SURFACE,
  folderPath: null,
  folderImages: [],
  folderRecursive: false,
  orderMode: 'sequential',
  currentIndex: -1,
  usedPaths: [],
})

/**
 * Coerce an unknown persisted value into a valid folder image list: entries
 * must carry a usable path/name/rel and finite numbers, duplicates collapse on
 * the path (the slideshow identity), and the list is capped like the host scan.
 */
export function sanitizeFolderImages(raw: unknown): SkinFolderImage[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const images: SkinFolderImage[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const path = typeof record.path === 'string' && record.path !== '' ? record.path : null
    if (path === null || seen.has(path)) continue
    seen.add(path)
    images.push({
      path,
      name: typeof record.name === 'string' && record.name !== '' ? record.name : path,
      rel: typeof record.rel === 'string' && record.rel !== '' ? record.rel : path,
      size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0,
      mtimeMs: typeof record.mtimeMs === 'number' && Number.isFinite(record.mtimeMs) ? record.mtimeMs : 0,
    })
    if (images.length >= MAX_CACHED_IMAGES) break
  }
  return images
}

/** A selectable preset skin: solid color or gradient CSS value. */
export interface SkinPreset {
  id: string
  label: string
  /** CSS background value (solid color or linear-gradient). */
  value: string
}

/** Built-in presets — immediate effect without picking an image. */
export const PRESETS: readonly SkinPreset[] = Object.freeze([
  { id: 'color-ink', label: '墨蓝', value: '#1f2a44' },
  { id: 'color-slate', label: '石板', value: '#3b4252' },
  { id: 'color-sand', label: '暖沙', value: '#e9e2d0' },
  { id: 'grad-sunset', label: '落日渐变', value: 'linear-gradient(135deg, #ff9a8b, #ff6a88 45%, #ff99ac)' },
  { id: 'grad-ocean', label: '深海渐变', value: 'linear-gradient(135deg, #0f2027, #203a43 55%, #2c5364)' },
  { id: 'grad-aurora', label: '极光渐变', value: 'linear-gradient(135deg, #43cea2, #185a9d 60%, #9cecfb)' },
])

/** Coerce an unknown persisted value into a valid SkinSettings. */
export function sanitizeSettings(raw: unknown): SkinSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return n
  }
  const source: SkinSource = SOURCES.includes(o.source as SkinSource) ? (o.source as SkinSource) : 'none'
  const folderImages = sanitizeFolderImages(o.folderImages)
  const indexed = typeof o.currentIndex === 'number' && Number.isFinite(o.currentIndex) ? Math.trunc(o.currentIndex) : -1
  const keptPaths = new Set(folderImages.map(image => image.path))
  return {
    enabled: o.enabled === true,
    source,
    imageDataUrl: str(o.imageDataUrl),
    imageName: str(o.imageName),
    url: str(o.url),
    preset: str(o.preset),
    dim: clamp(num(o.dim, DEFAULT_SETTINGS.dim), 0, MAX_DIM),
    blur: clamp(num(o.blur, DEFAULT_SETTINGS.blur), 0, MAX_BLUR),
    surface: clamp(num(o.surface, DEFAULT_SETTINGS.surface), MIN_SURFACE, MAX_SURFACE),
    folderPath: str(o.folderPath),
    folderImages,
    folderRecursive: o.folderRecursive === true,
    orderMode: ORDER_MODES.includes(o.orderMode as SkinOrderMode) ? (o.orderMode as SkinOrderMode) : 'sequential',
    // A stale index (or one pointing past a shrunk list) reads as "nothing shown".
    currentIndex: indexed >= 0 && indexed < folderImages.length ? indexed : -1,
    // Only paths that still exist in the cached list count as already shown.
    usedPaths: Array.isArray(o.usedPaths)
      ? o.usedPaths.filter((path): path is string => typeof path === 'string' && keptPaths.has(path))
      : [],
  }
}

/** Read + sanitize the persisted settings, or the defaults. */
export function loadSettings(storage: Pick<Storage, 'getItem'> = globalThis.localStorage): SkinSettings {
  try {
    const text = storage.getItem(STORAGE_KEY)
    if (text === null) return { ...DEFAULT_SETTINGS }
    return sanitizeSettings(JSON.parse(text))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Persist settings; quota errors are swallowed (the caller surfaces a message). */
export function saveSettings(settings: SkinSettings, storage: Pick<Storage, 'setItem'> = globalThis.localStorage): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

/** Remove the persisted settings (restores defaults on next boot). */
export function clearSettings(storage: Pick<Storage, 'removeItem'> = globalThis.localStorage): void {
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}

/** Whether the settings equal the pristine defaults (used to skip seeding the
 * host copy from localStorage on the first run after upgrade). */
export function isDefaultSettings(settings: SkinSettings): boolean {
  return settings.enabled === DEFAULT_SETTINGS.enabled
    && settings.source === DEFAULT_SETTINGS.source
    && settings.imageDataUrl === DEFAULT_SETTINGS.imageDataUrl
    && settings.imageName === DEFAULT_SETTINGS.imageName
    && settings.url === DEFAULT_SETTINGS.url
    && settings.preset === DEFAULT_SETTINGS.preset
    && settings.dim === DEFAULT_SETTINGS.dim
    && settings.blur === DEFAULT_SETTINGS.blur
    && settings.surface === DEFAULT_SETTINGS.surface
    && settings.folderPath === DEFAULT_SETTINGS.folderPath
    && settings.folderImages.length === 0
    && settings.folderRecursive === DEFAULT_SETTINGS.folderRecursive
    && settings.orderMode === DEFAULT_SETTINGS.orderMode
    && settings.currentIndex === DEFAULT_SETTINGS.currentIndex
    && settings.usedPaths.length === 0
}

/**
 * The name of the image currently on screen: a short label for the panel plus
 * the full reference for its hover title.
 */
export interface CurrentImageLabel {
  /** Name shown in the panel (may be ellipsized by CSS). */
  label: string
  /** Full path / URL / preset value behind the hover title. */
  detail: string
}

/**
 * Last path segment of a URL, decoded. Never throws: a value that is not an
 * absolute URL falls back to splitting on `/`, `\`, `?`, and `#` (a pasted
 * Windows path is a realistic mistake in the URL box), and a malformed
 * percent-escape is returned as written.
 */
export function urlBasename(url: string): string {
  const lastSegment = (value: string): string => {
    const path = value.split(/[?#]/)[0] ?? value
    const segments = path.split(/[/\\]/).filter(segment => segment !== '')
    return segments[segments.length - 1] ?? ''
  }
  let last = ''
  try {
    const parsed = new URL(url)
    last = lastSegment(parsed.pathname) === '' ? parsed.host : lastSegment(parsed.pathname)
  } catch {
    last = lastSegment(url)
  }
  if (last === '') return url
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * Resolve what the panel should call the current background.
 *
 * A disabled skin has nothing on screen, so it reports no name. Folder mode
 * uses the cached file name of the shown image — an index that no longer
 * matches the list reports nothing rather than the wrong name.
 * @param settings - current settings.
 * @returns the label/detail pair, or null when there is nothing to name.
 */
export function currentImageLabel(settings: SkinSettings): CurrentImageLabel | null {
  if (!settings.enabled) return null
  if (settings.source === 'folder') {
    const image = settings.folderImages[settings.currentIndex]
    if (image === undefined) return null
    return { label: image.name, detail: image.path }
  }
  if (settings.source === 'image') {
    // The data URL itself is useless as a tooltip; only the picked file name is.
    const name = settings.imageName ?? '本地图片'
    return { label: name, detail: name }
  }
  if (settings.source === 'url') {
    if (settings.url === null) return null
    return { label: urlBasename(settings.url), detail: settings.url }
  }
  if (settings.source === 'preset') {
    if (settings.preset === null) return null
    const preset = PRESETS.find(candidate => candidate.value === settings.preset)
    return { label: preset?.label ?? settings.preset, detail: settings.preset }
  }
  return null
}

/**
 * Project the settings onto the CSS custom properties the skin layer reads.
 * Returns an empty map when the skin is disabled (the applier then retracts
 * every variable).
 */
export function cssVariables(settings: SkinSettings): Partial<Record<(typeof SKIN_CSS_VARS)[number], string>> {
  if (!settings.enabled) return {}
  const vars: Partial<Record<(typeof SKIN_CSS_VARS)[number], string>> = {}
  if (settings.source === 'image' && settings.imageDataUrl !== null) {
    vars['--wx-skin-bg-image'] = `url("${settings.imageDataUrl}")`
  } else if (settings.source === 'url' && settings.url !== null) {
    vars['--wx-skin-bg-image'] = `url("${escapeCssUrl(settings.url)}")`
  } else if (settings.source === 'preset' && settings.preset !== null) {
    // A gradient goes to background-image; a solid color to background-color.
    if (settings.preset.includes('gradient')) vars['--wx-skin-bg-image'] = settings.preset
    else vars['--wx-skin-bg-color'] = settings.preset
  } else if (settings.source === 'folder') {
    // Served by the host from inside the picked folder; the URL changes with the
    // file's mtime, so the browser cache never shows a stale image.
    const image = settings.folderImages[settings.currentIndex]
    if (image !== undefined) vars['--wx-skin-bg-image'] = `url("${escapeCssUrl(imageUrl(image))}")`
  }
  vars['--wx-skin-scrim'] = `rgba(0, 0, 0, ${settings.dim.toFixed(3)})`
  vars['--wx-skin-blur'] = `${Math.round(settings.blur)}px`
  vars['--wx-skin-surface'] = settings.surface.toFixed(3)
  return vars
}

/** Escape quotes so a user-supplied URL cannot break out of `url("...")`. */
export function escapeCssUrl(url: string): string {
  return url.replace(/["\\\n\r]/g, char => `\\${char}`)
}
