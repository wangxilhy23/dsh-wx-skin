/**
 * dsh-wx-skin — skin-store unit tests (pure logic, fake storage, no DOM).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  PRESETS,
  STORAGE_KEY,
  clamp,
  cssVariables,
  escapeCssUrl,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  type SkinPreset,
} from '../src/client/skin-store.ts'
import type { SkinSettings } from '../src/core/types.ts'

function fakeStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
} {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value },
    removeItem: (key) => { delete store[key] },
  }
}

const enabledImage: SkinSettings = {
  enabled: true,
  source: 'image',
  imageDataUrl: 'data:image/jpeg;base64,AAAA',
  url: null,
  preset: null,
  dim: 0.35,
  blur: 0,
  surface: 0.72,
}

describe('sanitizeSettings', () => {
  it('returns defaults for junk input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('preserves valid fields and drops invalid ones', () => {
    const out = sanitizeSettings({
      enabled: true,
      source: 'image',
      imageDataUrl: 'data:image/png;base64,AAA',
      url: 123,
      preset: '',
      dim: 0.5,
      blur: 6,
    })
    expect(out.enabled).toBe(true)
    expect(out.source).toBe('image')
    expect(out.imageDataUrl).toBe('data:image/png;base64,AAA')
    expect(out.url).toBeNull()
    expect(out.preset).toBeNull()
    expect(out.dim).toBe(0.5)
    expect(out.blur).toBe(6)
    expect(out.surface).toBe(0.72)
  })

  it('rejects unknown sources', () => {
    expect(sanitizeSettings({ source: 'video' }).source).toBe('none')
  })

  it('clamps dim, blur, and surface', () => {
    expect(sanitizeSettings({ dim: 9, blur: 999, surface: 2 }).dim).toBe(0.8)
    expect(sanitizeSettings({ dim: 9, blur: 999, surface: 2 }).blur).toBe(24)
    expect(sanitizeSettings({ dim: 9, blur: 999, surface: 2 }).surface).toBe(1)
    expect(sanitizeSettings({ dim: -1, blur: -5, surface: 0 }).dim).toBe(0)
    expect(sanitizeSettings({ dim: -1, blur: -5, surface: 0 }).blur).toBe(0)
    expect(sanitizeSettings({ dim: -1, blur: -5, surface: 0 }).surface).toBe(0)
  })
})

describe('loadSettings / saveSettings', () => {
  it('defaults when nothing is stored', () => {
    expect(loadSettings(fakeStorage())).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips a stored value', () => {
    const storage = fakeStorage()
    expect(saveSettings(enabledImage, storage)).toBe(true)
    expect(storage.store[STORAGE_KEY]).toBe(JSON.stringify(enabledImage))
    expect(loadSettings(storage)).toEqual(enabledImage)
  })

  it('falls back to defaults on corrupt JSON', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '{not json' })
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS)
  })

  it('reports quota failures without throwing', () => {
    const storage = {
      getItem: (): string | null => null,
      setItem: (): void => { throw new DOMException('quota', 'QuotaExceededError') },
    }
    expect(saveSettings(enabledImage, storage)).toBe(false)
  })
})

describe('cssVariables', () => {
  it('returns nothing while disabled', () => {
    expect(cssVariables({ ...DEFAULT_SETTINGS })).toEqual({})
  })

  it('projects a local image into --wx-skin-bg-image', () => {
    const vars = cssVariables(enabledImage)
    expect(vars['--wx-skin-bg-image']).toBe('url("data:image/jpeg;base64,AAAA")')
    expect(vars['--wx-skin-scrim']).toBe('rgba(0, 0, 0, 0.350)')
    expect(vars['--wx-skin-blur']).toBe('0px')
    expect(vars['--wx-skin-surface']).toBe('0.720')
  })

  it('escapes quotes in a user URL', () => {
    const vars = cssVariables({ ...enabledImage, source: 'url', url: 'a"b\\c' })
    expect(vars['--wx-skin-bg-image']).toBe('url("a\\"b\\\\c")')
  })

  it('routes gradients to background-image and solids to background-color', () => {
    const gradient = cssVariables({ ...enabledImage, source: 'preset', preset: 'linear-gradient(135deg, #000, #fff)' })
    expect(gradient['--wx-skin-bg-image']).toBe('linear-gradient(135deg, #000, #fff)')
    expect(gradient['--wx-skin-bg-color']).toBeUndefined()
    const solid = cssVariables({ ...enabledImage, source: 'preset', preset: '#1f2a44' })
    expect(solid['--wx-skin-bg-color']).toBe('#1f2a44')
    expect(solid['--wx-skin-bg-image']).toBeUndefined()
  })
})

describe('helpers', () => {
  it('clamps numbers', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })

  it('escapeCssUrl escapes dangerous characters', () => {
    expect(escapeCssUrl('plain')).toBe('plain')
    expect(escapeCssUrl('a"b')).toBe('a\\"b')
  })

  it('preset catalog has labels and usable values', () => {
    expect(PRESETS.length).toBeGreaterThan(0)
    for (const preset of PRESETS as readonly SkinPreset[]) {
      expect(preset.id).not.toBe('')
      expect(preset.label).not.toBe('')
      expect(preset.value).not.toBe('')
    }
  })
})
