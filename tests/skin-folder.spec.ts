/**
 * dsh-wx-skin — folder slideshow logic tests (pure; no DOM, no host).
 *
 * The contract under test is the one the UI promises:
 *
 * - SEQUENTIAL walks the folder in filename order, wrapping at the ends, so a
 *   chosen image continues from where the user picked it (10 → 11 → 12, and 10
 *   → 9 backwards). A walk in index order never repeats until it wraps, so this
 *   mode keeps no pass record.
 * - RANDOM draws uniformly from the images not yet shown in this pass; a full
 *   pass restarts without repeating the image on screen.
 * - Loading a folder can FOCUS one named file (the 本地文件 row), which is what
 *   makes "pick this file, then walk its folder" work.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/client/skin-store.ts'
import { advanceFolder, canGoPrevious, focusFolderImage, folderSignature, folderStatus, imageUrl, loadFolderState, matchFolderImageByName, MAX_HISTORY, previousFolder, refreshFolderState, sortFolderImages } from '../src/client/skin-folder.ts'
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
    expect(imageUrl(image('a b.png', 42))).toBe('dsh-wx-skin/image?p=D%3A%5Cpics%5Ca%20b.png&v=42')
  })
})

describe('advanceFolder — sequential', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('starts at the first image and walks the folder order, wrapping at the end', () => {
    const first = advanceFolder(folderSettings(images))
    expect(first.currentIndex).toBe(0)
    // Index order never repeats until it wraps, so no pass record is kept.
    expect(first.usedPaths).toEqual([])
    const second = advanceFolder(first)
    expect(second.currentIndex).toBe(1)
    const third = advanceFolder(second)
    expect(third.currentIndex).toBe(2)
    expect(advanceFolder(third).currentIndex).toBe(0)
  })

  it('continues from the image the user picked (10 → 11, and 9 backwards)', () => {
    // 12 images: index 9 is img10.png, the one the user picks.
    const many = Array.from({ length: 12 }, (_, index) => image(`img${index + 1}.png`))
    const picked = folderSettings(many, { currentIndex: 9 })
    const next = advanceFolder(picked)
    expect(next.folderImages[next.currentIndex]?.name).toBe('img11.png')
    const previous = previousFolder(picked)
    expect(previous.folderImages[previous.currentIndex]?.name).toBe('img9.png')
  })

  it('ignores a stale pass record instead of jumping to an unused image', () => {
    // The old "unused first" rule would have skipped to c.png here.
    const settings = folderSettings(images, { currentIndex: 0, usedPaths: ['D:\\pics\\b.png'] })
    expect(advanceFolder(settings).currentIndex).toBe(1)
  })

  it('keeps a one-image folder on that image', () => {
    const settings = folderSettings([image('only.png')], { currentIndex: 0 })
    expect(advanceFolder(settings).currentIndex).toBe(0)
    expect(previousFolder(settings)).toBe(settings)
  })

  it('is a no-op for an empty folder', () => {
    const empty = folderSettings([], { currentIndex: 3, usedPaths: ['D:\\pics\\a.png'] })
    const next = advanceFolder(empty)
    expect(next.currentIndex).toBe(-1)
    expect(next.usedPaths).toEqual([])
    expect(empty.currentIndex).toBe(3)
  })

  it('enables the skin and switches the source to folder', () => {
    const next = advanceFolder({ ...folderSettings(images), enabled: false, source: 'none' })
    expect(next.enabled).toBe(true)
    expect(next.source).toBe('folder')
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

describe('previousFolder', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('returns to the recorded previous image and pops it (random)', () => {
    const settings = folderSettings(images, {
      orderMode: 'random',
      currentIndex: 2,
      usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\b.png', 'D:\\pics\\c.png'],
      history: ['D:\\pics\\a.png', 'D:\\pics\\b.png'],
    })
    const back = previousFolder(settings)
    expect(back.currentIndex).toBe(1)
    expect(back.history).toEqual(['D:\\pics\\a.png'])
    const twice = previousFolder(back)
    expect(twice.currentIndex).toBe(0)
    expect(previousFolder(twice).history).toEqual([])
  })

  it('steps one index back in sequential mode, wrapping at the first image', () => {
    expect(previousFolder(folderSettings(images, { currentIndex: 2, history: [] })).currentIndex).toBe(1)
    // From the first image the wrap lands on the last one.
    expect(previousFolder(folderSettings(images, { currentIndex: 0, history: [] })).currentIndex).toBe(2)
    // With nothing shown yet the wrap lands on the last one too.
    expect(previousFolder(folderSettings(images, { currentIndex: -1, history: [] })).currentIndex).toBe(2)
    // Sequential keeps no pass record or history.
    expect(previousFolder(folderSettings(images, { currentIndex: 2, history: ['D:\\pics\\a.png'] })).history).toEqual([])
  })

  it('marks the image it returns to as shown in this pass (random)', () => {
    const settings = folderSettings(images, {
      orderMode: 'random',
      currentIndex: 2,
      usedPaths: ['D:\\pics\\c.png'],
      history: ['D:\\pics\\b.png'],
    })
    const back = previousFolder(settings)
    expect(back.currentIndex).toBe(1)
    expect(back.usedPaths).toEqual(['D:\\pics\\b.png', 'D:\\pics\\c.png'])
  })

  it('skips a recorded path that no longer exists in the list (random)', () => {
    const settings = folderSettings(images, { orderMode: 'random', currentIndex: 2, history: ['D:\\pics\\gone.png'] })
    const back = previousFolder(settings)
    expect(back.currentIndex).toBe(1)
    expect(back.history).toEqual([])
  })

  it('does nothing in random mode without a recorded previous image', () => {
    const settings = folderSettings(images, { orderMode: 'random', currentIndex: 1, history: [] })
    expect(previousFolder(settings)).toBe(settings)
  })

  it('does nothing with no folder loaded', () => {
    const empty = folderSettings([], { currentIndex: -1, history: [] })
    expect(previousFolder(empty)).toBe(empty)
  })
})

describe('canGoPrevious', () => {
  const images = [image('a.png'), image('b.png')]

  it('needs more than one image in sequential mode and a history entry in random mode', () => {
    expect(canGoPrevious(folderSettings([]))).toBe(false)
    expect(canGoPrevious(folderSettings(images))).toBe(true)
    expect(canGoPrevious(folderSettings([image('a.png')]))).toBe(false)
    expect(canGoPrevious(folderSettings(images, { orderMode: 'random', history: ['D:\\pics\\a.png'] }))).toBe(true)
    expect(canGoPrevious(folderSettings(images, { orderMode: 'random', history: [] }))).toBe(false)
  })
})

describe('history bookkeeping', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('records the image left behind on every random 下一张', () => {
    const first = advanceFolder(folderSettings(images, { orderMode: 'random' }), rngOf(0))
    expect(first.history).toEqual([])
    const second = advanceFolder(first, rngOf(0))
    expect(second.history).toEqual(['D:\\pics\\a.png'])
    const third = advanceFolder(second, rngOf(0))
    expect(third.history).toEqual(['D:\\pics\\a.png', 'D:\\pics\\b.png'])
  })

  it('caps the history so the persisted blob cannot grow forever', () => {
    let settings = folderSettings(images, { orderMode: 'random' })
    for (let step = 0; step < MAX_HISTORY + 10; step += 1) settings = advanceFolder(settings, rngOf(0))
    expect(settings.history.length).toBe(MAX_HISTORY)
  })

  it('keeps the history for a sequential walk empty', () => {
    let settings = folderSettings(images)
    for (let step = 0; step < MAX_HISTORY + 10; step += 1) settings = advanceFolder(settings)
    expect(settings.history).toEqual([])
  })

  it('filters history for the same folder and clears it for a different one', () => {
    // Same folder, list changed (a file was added): the record is kept, aligned by path.
    const kept = loadFolderState(
      folderSettings(images, { currentIndex: 0, history: ['D:\\pics\\a.png', 'D:\\pics\\gone.png'] }),
      'D:\\pics',
      false,
      images,
    )
    expect(kept.history).toEqual(['D:\\pics\\a.png'])

    // A different folder starts over.
    const other = loadFolderState(
      folderSettings(images, { currentIndex: 0, history: ['D:\\pics\\a.png'] }),
      'D:\\other',
      false,
      [image('a.png'), image('b.png')],
    )
    expect(other.history).toEqual([])
  })

  it('drops the history when the folder empties out', () => {
    expect(advanceFolder(folderSettings([])).history).toEqual([])
  })
})

describe('refreshFolderState (automatic rescan)', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('keeps the shown image, its slot, and the records when files are added', () => {
    const settings = folderSettings(images, {
      currentIndex: 1,
      usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\b.png'],
      history: ['D:\\pics\\a.png'],
    })
    const next = refreshFolderState(settings, [...images, image('d.png')])
    expect(next.currentIndex).toBe(1)
    expect(next.folderImages.map(image => image.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    expect(next.usedPaths).toEqual(['D:\\pics\\a.png', 'D:\\pics\\b.png'])
    expect(next.history).toEqual(['D:\\pics\\a.png'])
    // The new file is NOT marked as shown, so the pass reaches it in order.
    expect(next.usedPaths).not.toContain('D:\\pics\\d.png')
    const first = advanceFolder(next)
    expect(first.folderImages[first.currentIndex]?.name).toBe('c.png')
    const second = advanceFolder(first)
    expect(second.folderImages[second.currentIndex]?.name).toBe('d.png')
  })

  it('falls back to the slot the shown image occupied when its file disappears', () => {
    const settings = folderSettings(images, { currentIndex: 1, usedPaths: ['D:\\pics\\b.png'] })
    const next = refreshFolderState(settings, [image('a.png'), image('c.png')])
    expect(next.currentIndex).toBe(1)
    expect(next.folderImages[1]?.name).toBe('c.png')
    // Records referring to the removed file are dropped.
    expect(next.usedPaths).toEqual([])
  })

  it('drops every record when the folder empties out', () => {
    const settings = folderSettings(images, {
      currentIndex: 2,
      usedPaths: images.map(image => image.path),
      history: ['D:\\pics\\a.png'],
    })
    const next = refreshFolderState(settings, [])
    expect(next.folderImages).toEqual([])
    expect(next.currentIndex).toBe(-1)
    expect(next.usedPaths).toEqual([])
    expect(next.history).toEqual([])
  })

  it('never touches the active source (a rescan must not switch the background)', () => {
    const settings = {
      ...folderSettings(images, { currentIndex: 0 }),
      source: 'url' as const,
      url: 'https://example.test/a.png',
    }
    const next = refreshFolderState(settings, [...images, image('d.png')])
    expect(next.source).toBe('url')
    expect(next.url).toBe('https://example.test/a.png')
  })

  it('detects list changes through the signature', () => {
    expect(folderSignature(images)).toBe(folderSignature([...images]))
    expect(folderSignature(images)).not.toBe(folderSignature([...images, image('d.png')]))
    expect(folderSignature(images)).not.toBe(folderSignature([image('a.png', 999), image('b.png'), image('c.png')]))
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
    }
    const next = loadFolderState(settings, 'D:\\pics', false, images)
    expect(next.source).toBe('folder')
    expect(next.folderPath).toBe('D:\\pics')
    expect(next.currentIndex).toBe(0)
    expect(next.usedPaths).toEqual([])
    expect(next.imageDataUrl).toBeNull()
  })

  it('focuses the named file and walks its folder from there', () => {
    const settings: SkinSettings = { ...DEFAULT_SETTINGS, enabled: true, source: 'url', url: 'https://example.test/a.png' }
    const next = loadFolderState(settings, 'D:\\pics', false, images, 'D:\\pics\\b.png')
    expect(next.source).toBe('folder')
    expect(next.folderPath).toBe('D:\\pics')
    expect(next.currentIndex).toBe(1)
    expect(next.folderImages[next.currentIndex]?.name).toBe('b.png')
    expect(next.url).toBeNull()
    // The focused file is where 下一张/上一张 walk from.
    expect(next.folderImages[advanceFolder(next).currentIndex]?.name).toBe('c.png')
    expect(next.folderImages[previousFolder(next).currentIndex]?.name).toBe('a.png')
  })

  it('tolerates a case- and separator-different path when focusing', () => {
    const next = loadFolderState({ ...DEFAULT_SETTINGS }, 'D:\\pics', false, images, 'd:/PICS/B.PNG')
    expect(next.currentIndex).toBe(1)
  })

  it('falls back to the first image when the named file is not in the scan', () => {
    const next = loadFolderState({ ...DEFAULT_SETTINGS }, 'D:\\pics', false, images, 'D:\\pics\\gone.png')
    expect(next.currentIndex).toBe(0)
  })

  it('keeps the current image and the pass record when the list is unchanged', () => {
    const settings = folderSettings(images, {
      orderMode: 'random',
      currentIndex: 1,
      usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\b.png'],
    })
    const next = loadFolderState(settings, 'D:\\pics', false, images)
    expect(next.currentIndex).toBe(1)
    expect(next.usedPaths).toEqual(['D:\\pics\\a.png', 'D:\\pics\\b.png'])
  })

  it('keeps the current image and the pass record when the list gains files', () => {
    const settings = folderSettings(images, {
      orderMode: 'random',
      currentIndex: 1,
      usedPaths: ['D:\\pics\\a.png'],
    })
    const next = loadFolderState(settings, 'D:\\pics', false, [...images, image('d.png')])
    // Reloading the same folder merges: nothing jumps, the new file just waits its turn.
    expect(next.currentIndex).toBe(1)
    expect(next.usedPaths).toEqual(['D:\\pics\\a.png'])
    expect(next.folderImages).toHaveLength(4)
  })

  it('starts fresh for a different folder', () => {
    const settings = folderSettings(images, { currentIndex: 2, usedPaths: ['D:\\pics\\a.png'] })
    const next = loadFolderState(settings, 'D:\\elsewhere', false, images)
    expect(next.folderPath).toBe('D:\\elsewhere')
    expect(next.currentIndex).toBe(0)
    expect(next.usedPaths).toEqual([])
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

describe('matchFolderImageByName', () => {
  const images = [image('bg128.png'), image('bg129.png'), image('bg130.png')]

  it('finds the one image with that name, ignoring case', () => {
    expect(matchFolderImageByName(images, 'bg129.png')).toBe(1)
    expect(matchFolderImageByName(images, 'BG129.PNG')).toBe(1)
    expect(matchFolderImageByName(images, '  bg130.png  ')).toBe(2)
  })

  it('returns -1 for an absent or empty name', () => {
    expect(matchFolderImageByName(images, 'bg131.png')).toBe(-1)
    expect(matchFolderImageByName(images, '')).toBe(-1)
    expect(matchFolderImageByName([], 'bg129.png')).toBe(-1)
  })

  it('refuses an ambiguous name instead of guessing', () => {
    // A recursive scan can hold two files with the same name in different folders.
    const ambiguous = [image('a.png'), { ...image('a.png'), path: 'D:\\pics\\sub\\a.png', rel: 'sub/a.png' }]
    expect(matchFolderImageByName(ambiguous, 'a.png')).toBe(-1)
  })
})

describe('focusFolderImage', () => {
  const images = [image('a.png'), image('b.png'), image('c.png')]

  it('shows that image, clears the other background kinds, and walks from it', () => {
    const settings = folderSettings(images, {
      source: 'url',
      url: 'https://example.test/a.png',
      imageName: 'a.png',
      currentIndex: 0,
    })
    const focused = focusFolderImage(settings, 1)
    expect(focused.source).toBe('folder')
    expect(focused.currentIndex).toBe(1)
    expect(focused.url).toBeNull()
    expect(focused.imageDataUrl).toBeNull()
    expect(focused.imageName).toBeNull()
    // 下一张 continues in folder order from the focused image.
    expect(advanceFolder(focused).currentIndex).toBe(2)
    expect(previousFolder(focused).currentIndex).toBe(0)
  })

  it('is a no-op for a stale index', () => {
    const settings = folderSettings(images)
    expect(focusFolderImage(settings, 3)).toBe(settings)
    expect(focusFolderImage(settings, -1)).toBe(settings)
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
