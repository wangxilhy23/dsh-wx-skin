/**
 * dsh-wx-skin — local-path vocabulary tests (pure; no DOM, no host).
 *
 * This is the logic behind the 本地文件 row: deciding whether a value is a URL or
 * an absolute path, which folder that path lives in (the folder the host is asked
 * to scan), and whether two paths name the same file (the host returns
 * canonicalized paths while the user types whatever Explorer showed).
 */
import { describe, expect, it } from 'vitest'
import { isAbsolutePath, isRemoteImageUrl, parentDirectory, pathBasename, samePath } from '../src/client/skin-path.ts'

describe('isRemoteImageUrl', () => {
  it('accepts http(s) addresses only', () => {
    expect(isRemoteImageUrl('https://host/a.png')).toBe(true)
    expect(isRemoteImageUrl('HTTP://host/a.png')).toBe(true)
    expect(isRemoteImageUrl('  https://host/a.png  ')).toBe(true)
    expect(isRemoteImageUrl('file:///a.png')).toBe(false)
    expect(isRemoteImageUrl('D:\\pics\\a.png')).toBe(false)
    expect(isRemoteImageUrl('https://host')).toBe(true)
    expect(isRemoteImageUrl('https:// host/a.png')).toBe(false)
  })
})

describe('isAbsolutePath', () => {
  it('accepts drive, UNC, and POSIX roots', () => {
    expect(isAbsolutePath('D:\\pics\\a.png')).toBe(true)
    expect(isAbsolutePath('d:/pics/a.png')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.png')).toBe(true)
    expect(isAbsolutePath('/pics/a.png')).toBe(true)
  })

  it('rejects relative values and URLs', () => {
    expect(isAbsolutePath('pics/a.png')).toBe(false)
    expect(isAbsolutePath('..\\a.png')).toBe(false)
    expect(isAbsolutePath('https://host/a.png')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})

describe('parentDirectory', () => {
  it('splits a file path into the folder the host may scan', () => {
    expect(parentDirectory('D:\\pics\\walls\\a.png')).toBe('D:\\pics\\walls')
    expect(parentDirectory('D:/pics/a.png')).toBe('D:/pics')
    expect(parentDirectory('\\\\server\\share\\pics\\a.png')).toBe('\\\\server\\share\\pics')
    expect(parentDirectory('/pics/a.png')).toBe('/pics')
  })

  it('keeps a volume root usable', () => {
    expect(parentDirectory('D:\\a.png')).toBe('D:\\')
    expect(parentDirectory('/a.png')).toBe('/')
  })

  it('tolerates a trailing separator and rejects unusable values', () => {
    expect(parentDirectory('D:\\pics\\a.png\\')).toBe('D:\\pics')
    expect(parentDirectory('D:\\')).toBeNull()
    expect(parentDirectory('relative\\a.png')).toBeNull()
    expect(parentDirectory('')).toBeNull()
  })
})

describe('pathBasename', () => {
  it('takes the last segment of a path or URL', () => {
    expect(pathBasename('D:\\pics\\deep sea.png')).toBe('deep sea.png')
    expect(pathBasename('/pics/a.png')).toBe('a.png')
    expect(pathBasename('https://host/walls/a.jpg?w=1#top')).toBe('a.jpg')
    expect(pathBasename('')).toBe('')
  })
})

describe('samePath', () => {
  it('ignores case and separator style on Windows-style paths', () => {
    expect(samePath('D:\\pics\\B.PNG', 'd:/PICS/b.png')).toBe(true)
    expect(samePath('D:\\pics\\a.png', 'D:\\pics\\b.png')).toBe(false)
    expect(samePath('D:\\pics\\a.png\\', 'D:\\pics\\a.png')).toBe(true)
  })

  it('compares other paths literally', () => {
    expect(samePath('/pics/A.png', '/pics/a.png')).toBe(false)
    expect(samePath('/pics/a.png', '/pics/a.png')).toBe(true)
  })
})
