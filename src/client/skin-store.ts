/**
 * dsh-wx-skin — pure skin settings state: defaults, sanitization, persistence
 * (localStorage), preset catalog, and the CSS-variable projection consumed by
 * the DOM applier. No DOM access here — tests exercise these functions with a
 * fake storage.
 * @module dsh-wx-skin/client/skin-store
 */
import type { SkinSettings, SkinSource } from '../core/types.ts'

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

const SOURCES: readonly SkinSource[] = ['image', 'url', 'preset', 'none']

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
  url: null,
  preset: null,
  dim: 0.35,
  blur: 0,
  surface: DEFAULT_SURFACE,
})

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
  return {
    enabled: o.enabled === true,
    source,
    imageDataUrl: str(o.imageDataUrl),
    url: str(o.url),
    preset: str(o.preset),
    dim: clamp(num(o.dim, DEFAULT_SETTINGS.dim), 0, MAX_DIM),
    blur: clamp(num(o.blur, DEFAULT_SETTINGS.blur), 0, MAX_BLUR),
    surface: clamp(num(o.surface, DEFAULT_SETTINGS.surface), MIN_SURFACE, MAX_SURFACE),
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
