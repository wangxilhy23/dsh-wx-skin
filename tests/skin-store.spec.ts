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
  currentImageLabel,
  escapeCssUrl,
  isDefaultSettings,
  loadSettings,
  sanitizeFolderImages,
  sanitizeSettings,
  saveSettings,
  urlBasename,
  type SkinPreset,
} from '../src/client/skin-store.ts'
import type { SkinFolderImage, SkinSettings } from '../src/core/types.ts'

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
  ...DEFAULT_SETTINGS,
  enabled: true,
  source: 'image',
  imageDataUrl: 'data:image/jpeg;base64,AAAA',
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

describe('isDefaultSettings', () => {
  it('true for the pristine defaults', () => {
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS })).toBe(true)
  })

  it('false when any field deviates', () => {
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, enabled: true })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, source: 'preset', preset: '#000' })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, dim: 0.4 })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, imageName: 'wall.png' })).toBe(false)
    expect(isDefaultSettings(enabledImage)).toBe(false)
  })
})

describe('currentImageLabel', () => {
  const folderImage = (name: string): SkinFolderImage => ({
    path: `D:\\pics\\${name}`,
    name,
    rel: name,
    size: 1,
    mtimeMs: 2,
  })

  it('names the shown folder image and offers the full path as detail', () => {
    const settings: SkinSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [folderImage('a.png'), folderImage('demo1.png')],
      currentIndex: 1,
    }
    expect(currentImageLabel(settings)).toEqual({ label: 'demo1.png', detail: 'D:\\pics\\demo1.png' })
  })

  it('reports nothing for a folder index that matches no image', () => {
    const settings: SkinSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderImages: [folderImage('a.png')],
      currentIndex: -1,
    }
    expect(currentImageLabel(settings)).toBeNull()
  })

  it('names a picked local image by its file name', () => {
    const named: SkinSettings = { ...DEFAULT_SETTINGS, enabled: true, source: 'image', imageName: 'my wallpaper.jpg' }
    expect(currentImageLabel(named)).toEqual({ label: 'my wallpaper.jpg', detail: 'my wallpaper.jpg' })
    // Older settings carry no name; the source is still labelled.
    const anonymous: SkinSettings = { ...DEFAULT_SETTINGS, enabled: true, source: 'image', imageDataUrl: 'data:image/png;base64,AA' }
    expect(currentImageLabel(anonymous)).toEqual({ label: '本地图片', detail: '本地图片' })
  })

  it('names a URL by its last path segment, with the URL as detail', () => {
    const settings: SkinSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'url',
      url: 'https://example.com/walls/%E6%B7%B1%E6%B5%B7.jpg?w=1920#top',
    }
    expect(currentImageLabel(settings)).toEqual({
      label: '深海.jpg',
      detail: 'https://example.com/walls/%E6%B7%B1%E6%B5%B7.jpg?w=1920#top',
    })
  })

  it('names a preset by its catalog label', () => {
    const settings: SkinSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'preset',
      preset: PRESETS[0]?.value ?? '',
    }
    expect(currentImageLabel(settings)).toEqual({ label: PRESETS[0]?.label, detail: PRESETS[0]?.value })
  })

  it('reports nothing while the skin is off or no source is set', () => {
    expect(currentImageLabel({ ...DEFAULT_SETTINGS })).toBeNull()
    expect(currentImageLabel({ ...DEFAULT_SETTINGS, enabled: false, source: 'folder', folderImages: [folderImage('a.png')], currentIndex: 0 })).toBeNull()
    expect(currentImageLabel({ ...DEFAULT_SETTINGS, enabled: true, source: 'url', url: null })).toBeNull()
  })
})

describe('urlBasename', () => {
  it('keeps the last segment and drops query/hash', () => {
    expect(urlBasename('https://host/a/b/photo.png?x=1#y')).toBe('photo.png')
  })

  it('falls back to the host for a bare origin', () => {
    expect(urlBasename('https://host/')).toBe('host')
  })

  it('never throws on malformed or relative input', () => {
    // A pasted Windows path is a realistic mistake in the URL box.
    expect(urlBasename('C:\\walls\\deep sea.png')).toBe('deep sea.png')
    expect(urlBasename('not a url/')).toBe('not a url')
    expect(urlBasename('https://host/%E0%A4%A')).toBe('%E0%A4%A')
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

describe('folder settings', () => {
  const image = (name: string, mtimeMs = 1000): SkinFolderImage => ({
    path: `D:\\pics\\${name}`,
    name,
    rel: name,
    size: 10,
    mtimeMs,
  })

  it('sanitizes the cached list: shape, dedupe, cap', () => {
    const out = sanitizeFolderImages([
      image('a.png'),
      { path: '', name: 'x' },
      { path: 'D:\\pics\\a.png', name: 'dup' },
      null,
      { path: 'D:\\pics\\b.jpg', name: 'b.jpg', rel: 'b.jpg', size: 'big', mtimeMs: Number.NaN },
    ])
    expect(out).toHaveLength(2)
    expect(out.map(entry => entry.path)).toEqual(['D:\\pics\\a.png', 'D:\\pics\\b.jpg'])
    // Non-numeric metadata degrades to zero instead of poisoning the entry.
    expect(out[1]).toMatchObject({ size: 0, mtimeMs: 0 })
    expect(sanitizeFolderImages('nope')).toEqual([])
  })

  it('keeps folder fields and aligns the index and used record with the list', () => {
    const out = sanitizeSettings({
      source: 'folder',
      enabled: true,
      folderPath: 'D:\\pics',
      folderImages: [image('a.png'), image('b.png')],
      orderMode: 'random',
      currentIndex: 7,
      usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\gone.png', 42],
    })
    expect(out.source).toBe('folder')
    expect(out.folderPath).toBe('D:\\pics')
    expect(out.orderMode).toBe('random')
    // Out-of-range index reads as "nothing shown" rather than throwing later.
    expect(out.currentIndex).toBe(-1)
    // Only paths still present in the cached list survive.
    expect(out.usedPaths).toEqual(['D:\\pics\\a.png'])
  })

  it('falls back to sequential and clears folder state from junk', () => {
    const out = sanitizeSettings({ orderMode: 'shuffle', folderPath: 5, folderImages: {} })
    expect(out.orderMode).toBe('sequential')
    expect(out.folderPath).toBeNull()
    expect(out.folderImages).toEqual([])
    expect(out.currentIndex).toBe(-1)
    expect(out.usedPaths).toEqual([])
  })

  it('treats any folder state as non-default', () => {
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, folderPath: 'D:\\pics' })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, folderImages: [image('a.png')] })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, usedPaths: ['D:\\pics\\a.png'] })).toBe(false)
    expect(isDefaultSettings({ ...DEFAULT_SETTINGS, orderMode: 'random' })).toBe(false)
  })

  it('projects the current folder image through the host route', () => {
    const settings: SkinSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [image('a b.png', 42), image('c.png', 43)],
      currentIndex: 1,
    }
    const vars = cssVariables(settings)
    expect(vars['--wx-skin-bg-image']).toBe('url("/dsh-wx-skin/image?p=D%3A%5Cpics%5Cc.png&v=43")')
    // No image picked (empty folder) leaves the background unset.
    expect(cssVariables({ ...settings, folderImages: [], currentIndex: -1 })['--wx-skin-bg-image']).toBeUndefined()
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
