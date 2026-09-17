/**
 * dsh-wx-skin — host-persistence client unit tests (fake fetch, no DOM).
 */
import { describe, expect, it } from 'vitest'
import { hostListFolder, hostLoad, hostSave, FOLDER_PATH, LOAD_PATH, SAVE_PATH } from '../src/client/skin-host.ts'
import { DEFAULT_SETTINGS } from '../src/client/skin-store.ts'
import type { SkinSettings } from '../src/core/types.ts'

const enabledImage: SkinSettings = {
  ...DEFAULT_SETTINGS,
  enabled: true,
  source: 'image',
  imageDataUrl: 'data:image/jpeg;base64,AAAA',
}

/** A fetch impl that answers one canned response. */
function respondWith(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('hostLoad', () => {
  it('loads and sanitizes a valid settings payload', async () => {
    const settings = await hostLoad(respondWith({ ok: true, settings: enabledImage }))
    expect(settings).toEqual(enabledImage)
  })

  it('returns null when the route is missing (non-ok status)', async () => {
    expect(await hostLoad(respondWith({ ok: false }, 404))).toBeNull()
  })

  it('returns null when the payload is empty or malformed', async () => {
    expect(await hostLoad(respondWith({ ok: true }))).toBeNull()
    expect(await hostLoad(respondWith({ ok: true, settings: null }))).toBeNull()
    expect(await hostLoad(respondWith({ ok: true, settings: 'nope' }))).toBeNull()
    expect(await hostLoad(respondWith({ ok: true, settings: 42 }))).toBeNull()
  })

  it('sanitizes a junk settings object instead of throwing', async () => {
    const junk = await hostLoad(respondWith({ ok: true, settings: { enabled: true, source: 'nope' } }))
    expect(junk?.enabled).toBe(true)
    expect(junk?.source).toBe('none')
  })

  it('returns null when fetch itself throws', async () => {
    const throwing = (async () => { throw new Error('network down') }) as typeof fetch
    expect(await hostLoad(throwing)).toBeNull()
  })

  it('requests the load route', async () => {
    let requested = ''
    const spy = (async (input: RequestInfo | URL) => {
      requested = String(input)
      return new Response(JSON.stringify({ ok: true, settings: null }), { status: 200 })
    }) as typeof fetch
    await hostLoad(spy)
    expect(requested).toBe(LOAD_PATH)
  })
})

describe('hostSave', () => {
  it('POSTs the settings wrapper and reports success', async () => {
    let requested = ''
    let posted: unknown
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input)
      posted = init?.body
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    expect(await hostSave(enabledImage, spy)).toBe(true)
    expect(requested).toBe(SAVE_PATH)
    expect(posted).toBe(JSON.stringify({ settings: enabledImage }))
  })

  it('returns false on a non-ok response', async () => {
    expect(await hostSave(enabledImage, respondWith({ ok: false }, 500))).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    const throwing = (async () => { throw new Error('network down') }) as typeof fetch
    expect(await hostSave(enabledImage, throwing)).toBe(false)
  })
})

describe('hostListFolder', () => {
  const scanned = {
    ok: true,
    root: 'D:\\pics',
    truncated: false,
    images: [
      { path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 10, mtimeMs: 1 },
      { path: 'D:\\pics\\b.png', name: 'b.png', rel: 'b.png', size: 11, mtimeMs: 2 },
    ],
  }

  it('posts the request and returns the sanitized list', async () => {
    let requested = ''
    let posted: unknown
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input)
      posted = init?.body
      return new Response(JSON.stringify(scanned), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await hostListFolder('D:\\pics', true, spy)
    expect(requested).toBe(FOLDER_PATH)
    expect(posted).toBe(JSON.stringify({ path: 'D:\\pics', recursive: true }))
    expect(result).toEqual({ ok: true, root: 'D:\\pics', truncated: false, images: scanned.images })
  })

  it('accepts an empty folder as a successful scan', async () => {
    const empty = await hostListFolder('D:\\empty', false, respondWith({ ok: true, root: 'D:\\empty', images: [] }))
    expect(empty).toEqual({ ok: true, root: 'D:\\empty', truncated: false, images: [] })
  })

  it('surfaces the host message for a rejected path', async () => {
    const rejected = await hostListFolder('D:\\nope', false, respondWith({ ok: false, error: '文件夹不存在或无法访问。' }))
    expect(rejected).toEqual({ ok: false, error: '文件夹不存在或无法访问。' })
  })

  it('reports a stale host when the route answers with the SPA fallback', async () => {
    const html = (async () => new Response('<!doctype html><div id="root"></div>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch
    const result = await hostListFolder('D:\\pics', false, html)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('重启 dsh web') })
  })

  it('reports a stale host when the payload is not a scan result', async () => {
    const result = await hostListFolder('D:\\pics', false, respondWith({ ok: true, images: 'nope' }))
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('重启 dsh web') })
  })

  it('reports an unreachable host when fetch throws', async () => {
    const throwing = (async () => { throw new Error('network down') }) as typeof fetch
    const result = await hostListFolder('D:\\pics', false, throwing)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('无法连接宿主接口') })
  })
})
