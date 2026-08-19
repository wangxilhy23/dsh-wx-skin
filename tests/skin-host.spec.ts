/**
 * dsh-wx-skin — host-persistence client unit tests (fake fetch, no DOM).
 */
import { describe, expect, it } from 'vitest'
import { hostLoad, hostSave, LOAD_PATH, SAVE_PATH } from '../src/client/skin-host.ts'
import type { SkinSettings } from '../src/core/types.ts'

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
