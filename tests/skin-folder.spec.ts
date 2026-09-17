/**
 * dsh-wx-skin — folder slideshow logic tests (pure; no DOM, no host).
 *
 * The contract under test is the one the UI promises: a pass over the folder,
 * ordered by filename in sequential mode or drawn uniformly in random mode, in
 * which an image already shown is never picked again until every image has been
 * shown — and the pass boundary does not repeat the image on screen.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/client/skin-store.ts'
import { advanceFolder, folderStatus, imageUrl, loadFolderState, sortFolderImages } from '../src/client/skin-folder.ts'
import type { SkinFolderImage, SkinSettings } from '../src/core/types.ts'

function image(name: string, mtimeMs = 1000): SkinFolderImage {
  return { path: `D:\\pics\\${name}`, name, rel: name, size: 10, mtimeMs }
}

function folderSettings(images: readonly SkinFolderImage[], extra: Partial<SkinSettings> = {}): SkinSettings {
  return { ...DEFAULT_SETTINGS, enabled: true, source: 'folder', folderPath: 'D:\\pics', folderImages: [...images], ...extra }
}

const names = (settings: SkinSettings): string[] =>
  settings.usedPaths.map(path => path.replace('D:\\pics\\', ''))

/** A deterministic rng cycling through the given values. */
function rngOf(...values: number[]): () => number {
  let index = 0
  return () => values[index++ % values.length] as number
}

describe('sortFolderImages', () => {
  it('orders by name naturally, ignoring case', () => {
    const sorted = sortFolderImages([image('img10.png'), image('Img2.png'), image('img1.png')])
    expect(sorted.map(entry => entry.name)).toEqual(['img1.png', 'Img2.png', 'img10.png'])
  })

  it('leaves the input untouched', () => {
    const input = [image('b.png'), image('a.png')]
    sortFolderImages(input)
    expect(input.map(entry => entry.name)).toEqual(['b.png', 'a.png'])
  })
})

describe('imageUrl', () => {
  it('encodes the path and carries the mtime as the cache token', () => {
    expect(imageUrl(image('a b.png', 42))).toBe('/dsh-wx-skin/image?p=D%3A%5Cpics%5Ca%20b.png&v=42')
  })
})

describe('advanceFolder — sequential', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('starts at the first image and walks in filename order', () => {
    const first = advanceFolder(folderSettings(images))
    expect(first.currentIndex).toBe(0)
    expect(names(first)).toEqual(['a.png'])
    const second = advanceFolder(first)
    expect(second.currentIndex).toBe(1)
    const third = advanceFolder(second)
    expect(third.currentIndex).toBe(2)
    expect(names(third)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('skips images already shown inside the pass', () => {
    const settings = folderSettings(images, { currentIndex: 0, usedPaths: ['D:\\pics\\b.png'] })
    // b is used, so the pass continues at c.
    expect(advanceFolder(settings).currentIndex).toBe(2)
  })

  it('starts a new pass once every image has been shown, without repeating the current one', () => {
    const settings = folderSettings(images, { currentIndex: 2, usedPaths: images.map(entry => entry.path) })
    const next = advanceFolder(settings)
    expect(next.currentIndex).toBe(0)
    expect(names(next)).toEqual(['a.png'])
    // The completed pass is discarded, not merged into the new one.
    expect(next.usedPaths).not.toContain('D:\\pics\\c.png')
  })

  it('keeps a one-image folder on that image across the pass boundary', () => {
    const settings = folderSettings([image('only.png')], { currentIndex: 0, usedPaths: ['D:\\pics\\only.png'] })
    const next = advanceFolder(settings)
    expect(next.currentIndex).toBe(0)
    expect(names(next)).toEqual(['only.png'])
  })

  it('drops used paths that no longer exist in the cached list', () => {
    const settings = folderSettings(images, { currentIndex: 0, usedPaths: ['D:\\pics\\gone.png'] })
    const next = advanceFolder(settings)
    expect(next.currentIndex).toBe(1)
    expect(names(next)).toEqual(['b.png'])
  })

  it('is a no-op for an empty folder', () => {
    const empty = folderSettings([], { currentIndex: 3, usedPaths: ['D:\\pics\\a.png'] })
    const next = advanceFolder(empty)
    expect(next.currentIndex).toBe(-1)
    expect(next.usedPaths).toEqual([])
    expect(empty.currentIndex).toBe(3)
  })

  it('enables the skin and switches the source to folder', () => {
    const next = advanceFolder({ ...folderSettings(images), enabled: false, source: 'preset', preset: '#000' })
    expect(next.enabled).toBe(true)
    expect(next.source).toBe('folder')
    // The preset value is left alone; only the active source changes.
    expect(next.preset).toBe('#000')
  })
})

describe('advanceFolder — random', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('never draws an image already shown in the pass', () => {
    const settings = folderSettings(images, { orderMode: 'random', currentIndex: 0, usedPaths: ['D:\\pics\\a.png'] })
    for (const roll of [0, 0.5, 0.999]) {
      const next = advanceFolder(settings, () => roll)
      expect([1, 2]).toContain(next.currentIndex)
    }
  })

  it('restarts the pass when the unused set is empty', () => {
    const settings = folderSettings(images, {
      orderMode: 'random',
      currentIndex: 1,
      usedPaths: images.map(entry => entry.path),
    })
    // rng 0 selects the first candidate; the current image is excluded from the new pass.
    const next = advanceFolder(settings, rngOf(0))
    expect(next.currentIndex).toBe(0)
    expect(names(next)).toEqual(['a.png'])
  })

  it('tolerates an rng at the top of its range', () => {
    const settings = folderSettings(images, { orderMode: 'random' })
    expect(advanceFolder(settings, () => 1).currentIndex).toBe(2)
  })
})

describe('loadFolderState', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('picks the first image of a fresh folder and clears other sources', () => {
    const settings: SkinSettings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'image',
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      preset: '#123456',
    }
    const next = loadFolderState(settings, 'D:\\pics', false, images)
    expect(next.source).toBe('folder')
    expect(next.folderPath).toBe('D:\\pics')
    expect(next.currentIndex).toBe(0)
    expect(next.usedPaths).toEqual(['D:\\pics\\a.png'])
    expect(next.imageDataUrl).toBeNull()
    expect(next.preset).toBeNull()
  })

  it('keeps the current image and the pass record when the list is unchanged', () => {
    const settings = folderSettings(images, { currentIndex: 1, usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\b.png'] })
    const next = loadFolderState(settings, 'D:\\pics', false, images)
    expect(next.currentIndex).toBe(1)
    expect(next.usedPaths).toEqual(['D:\\pics\\a.png', 'D:\\pics\\b.png'])
  })

  it('starts a fresh pass when the list changed', () => {
    const settings = folderSettings(images, { currentIndex: 1, usedPaths: ['D:\\pics\\a.png'] })
    const next = loadFolderState(settings, 'D:\\pics', false, [...images, image('d.png')])
    expect(next.currentIndex).toBe(0)
    expect(next.usedPaths).toEqual(['D:\\pics\\a.png'])
    expect(next.folderImages).toHaveLength(4)
  })

  it('sorts whatever the host returned', () => {
    const next = loadFolderState({ ...DEFAULT_SETTINGS }, 'D:\\pics', true, [image('b.png'), image('a.png')])
    expect(next.folderImages.map(entry => entry.name)).toEqual(['a.png', 'b.png'])
    expect(next.folderRecursive).toBe(true)
  })

  it('leaves the folder empty and nothing shown', () => {
    const next = loadFolderState({ ...DEFAULT_SETTINGS }, 'D:\\empty', false, [])
    expect(next.folderImages).toEqual([])
    expect(next.currentIndex).toBe(-1)
    expect(next.usedPaths).toEqual([])
  })
})

describe('folderStatus', () => {
  it('reports the 1-based position and the pass record size', () => {
    const settings = folderSettings([image('a.png'), image('b.png'), image('c.png')], {
      currentIndex: 1,
      usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\b.png'],
    })
    expect(folderStatus(settings)).toEqual({ position: 2, total: 3, usedThisPass: 2 })
  })

  it('ignores stale used paths and an out-of-range index', () => {
    const settings = folderSettings([image('a.png')], { currentIndex: -1, usedPaths: ['D:\\pics\\gone.png'] })
    expect(folderStatus(settings)).toEqual({ position: 0, total: 1, usedThisPass: 0 })
  })
})
