/**
 * dsh-wx-skin — host folder scan tests (fake filesystem, no disk access).
 *
 * The scan decides what the slideshow can ever show and which paths the image
 * route may serve, so the bounds under test here are the security boundary:
 * bitmaps only, symlinks never followed, and every returned path below the
 * canonical root.
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IMAGE_EXTENSIONS,
  SCAN_LIMITS,
  imageContentType,
  imageExtension,
  isInsideRoot,
  scanImageFolder,
  type DirEntry,
  type ScanIo,
} from '../src/folder.ts'

type Kind = 'file' | 'dir' | 'link'

/** Build a fake `node:fs` face over `tree` (absolute dir → entries). */
function fakeIo(tree: Record<string, Array<{ name: string, kind: Kind }>>, sizes: Record<string, number> = {}): ScanIo {
  return {
    realpathSync: path => resolve(path),
    readdirSync(dir: string): ReadonlyArray<DirEntry> {
      const entries = tree[resolve(dir)]
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`)
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: () => entry.kind === 'dir',
        isFile: () => entry.kind === 'file',
        isSymbolicLink: () => entry.kind === 'link',
      }))
    },
    statSync: (path: string) => ({ isFile: () => true, size: sizes[resolve(path)] ?? 1, mtimeMs: 1000 }),
  }
}

const root = resolve('wxskin-scan-root')
const at = (name: string): string => join(root, name)

describe('imageExtension / imageContentType', () => {
  it('accepts the bitmap whitelist case-insensitively', () => {
    expect(imageExtension('a.PNG')).toBe('png')
    expect(imageExtension('a.JpEg')).toBe('jpeg')
    for (const extension of IMAGE_EXTENSIONS) {
      expect(imageExtension(`photo.${extension}`)).toBe(extension)
    }
  })

  it('rejects vectors, other media, and extension-less names', () => {
    expect(imageExtension('logo.svg')).toBeUndefined()
    expect(imageExtension('notes.txt')).toBeUndefined()
    expect(imageExtension('README')).toBeUndefined()
    expect(imageExtension('archive.png.zip')).toBeUndefined()
  })

  it('maps every accepted extension to a content type', () => {
    expect(imageContentType('a.png')).toBe('image/png')
    expect(imageContentType('a.jpg')).toBe('image/jpeg')
    expect(imageContentType('a.jpeg')).toBe('image/jpeg')
    expect(imageContentType('a.webp')).toBe('image/webp')
    expect(imageContentType('a.gif')).toBe('image/gif')
    expect(imageContentType('a.bmp')).toBe('image/bmp')
    expect(imageContentType('a.svg')).toBeUndefined()
  })
})

describe('isInsideRoot', () => {
  it('accepts the root itself and descendants', () => {
    const base = resolve('pics')
    expect(isInsideRoot(base, base)).toBe(true)
    expect(isInsideRoot(base, join(base, 'a.png'))).toBe(true)
    expect(isInsideRoot(base, join(base, 'sub', 'a.png'))).toBe(true)
  })

  it('rejects escapes and sibling-prefix lookalikes', () => {
    const base = resolve('pics')
    expect(isInsideRoot(base, resolve('pics2'))).toBe(false)
    expect(isInsideRoot(base, resolve('pics', '..', 'pics2', 'a.png'))).toBe(false)
    expect(isInsideRoot(base, resolve('other'))).toBe(false)
  })

  it('compares case-insensitively only when asked (Windows semantics)', () => {
    const base = resolve('Pics')
    const child = join(resolve('pics'), 'a.png')
    expect(isInsideRoot(base, child, true)).toBe(true)
    expect(isInsideRoot(base, child, false)).toBe(false)
  })
})

describe('scanImageFolder', () => {
  it('collects bitmaps only, sorted naturally', () => {
    const io = fakeIo({
      [root]: [
        { name: 'img10.png', kind: 'file' },
        { name: 'Img2.PNG', kind: 'file' },
        { name: 'img1.jpg', kind: 'file' },
        { name: 'logo.svg', kind: 'file' },
        { name: 'notes.txt', kind: 'file' },
        { name: 'noext', kind: 'file' },
        { name: '.hidden.png', kind: 'file' },
      ],
    })
    const result = scanImageFolder(root, false, io)
    expect(result.root).toBe(root)
    expect(result.images.map(entry => entry.name)).toEqual(['img1.jpg', 'Img2.PNG', 'img10.png'])
    expect(result.images[0]).toMatchObject({ rel: 'img1.jpg', size: 1, mtimeMs: 1000 })
    // `.hidden.png` and the non-bitmaps were never considered.
    expect(result.images.some(entry => entry.name.startsWith('.'))).toBe(false)
    expect(result.truncated).toBe(false)
  })

  it('ignores subdirectories unless asked, and then records a portable rel', () => {
    const tree = {
      [root]: [
        { name: 'top.png', kind: 'file' },
        { name: 'sub', kind: 'dir' },
      ],
      [at('sub')]: [{ name: 'deep.jpg', kind: 'file' }],
    }
    const shallow = scanImageFolder(root, false, fakeIo(tree))
    expect(shallow.images.map(entry => entry.rel)).toEqual(['top.png'])
    const deep = scanImageFolder(root, true, fakeIo(tree))
    expect(deep.images.map(entry => entry.rel)).toEqual(['sub/deep.jpg', 'top.png'])
  })

  it('never follows symlinks', () => {
    const io = fakeIo({
      [root]: [
        { name: 'real.png', kind: 'file' },
        { name: 'linked.png', kind: 'link' },
        { name: 'linked-dir', kind: 'link' },
      ],
      [at('linked-dir')]: [{ name: 'secret.png', kind: 'file' }],
    })
    const result = scanImageFolder(root, true, io)
    expect(result.images.map(entry => entry.name)).toEqual(['real.png'])
  })

  it('stops at the recursion depth bound', () => {
    const tree: Record<string, Array<{ name: string, kind: Kind }>> = {}
    let dir = root
    for (let level = 0; level < SCAN_LIMITS.maxDepth + 3; level += 1) {
      const child = join(dir, `d${level}`)
      tree[dir] = [{ name: `d${level}`, kind: 'dir' }, { name: `level${level}.png`, kind: 'file' }]
      dir = child
    }
    tree[dir] = [{ name: 'bottom.png', kind: 'file' }]
    const result = scanImageFolder(root, true, fakeIo(tree))
    expect(result.images).toHaveLength(SCAN_LIMITS.maxDepth + 1)
    expect(result.images.some(entry => entry.rel.endsWith('bottom.png'))).toBe(false)
  })

  it('truncates at the image bound', () => {
    const io = fakeIo({
      [root]: Array.from({ length: 12 }, (_, index) => ({ name: `p${String(index).padStart(2, '0')}.png`, kind: 'file' as Kind })),
    })
    const result = scanImageFolder(root, false, io, { maxImages: 5, maxScan: 100, maxDepth: 1 })
    expect(result.images).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })

  it('truncates at the scan bound', () => {
    const io = fakeIo({
      [root]: Array.from({ length: 30 }, (_, index) => ({ name: `p${String(index).padStart(2, '0')}.png`, kind: 'file' as Kind })),
    })
    const result = scanImageFolder(root, false, io, { maxImages: 100, maxScan: 4, maxDepth: 1 })
    expect(result.truncated).toBe(true)
    expect(result.images.length).toBeLessThanOrEqual(4)
  })

  it('skips an unreadable subdirectory instead of failing the scan', () => {
    const tree = {
      [root]: [
        { name: 'ok.png', kind: 'file' },
        { name: 'locked', kind: 'dir' },
      ],
      // `locked` is absent from the tree, so readdirSync throws for it.
    }
    const result = scanImageFolder(root, true, fakeIo(tree))
    expect(result.images.map(entry => entry.name)).toEqual(['ok.png'])
  })

  it('canonicalizes the root through realpathSync', () => {
    const linked = resolve('wxskin-linked-root')
    const io: ScanIo = {
      ...fakeIo({ [root]: [{ name: 'a.png', kind: 'file' }] }),
      realpathSync: path => (resolve(path) === linked ? root : resolve(path)),
    }
    const result = scanImageFolder(linked, false, io)
    expect(result.root).toBe(root)
    expect(result.images[0]?.path).toBe(at('a.png'))
  })
})
