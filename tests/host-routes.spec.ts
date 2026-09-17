/**
 * dsh-wx-skin — host route integration tests.
 *
 * The folder and image routes are the only part of the plugin that touches the
 * local filesystem, so they are exercised against a real loopback HTTP server
 * and a throwaway `$DSH_HOME` (never the machine's own settings file).
 * Covered here: the scan contract, the path confinement that keeps the image
 * route from becoming a general file reader, the cache token, and the guards.
 */
import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

/** One byte of a recognizable PNG-ish payload; the route never parses images. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

let server: Server | undefined
let base = ''
let home = ''
let folder = ''
let outside = ''
let disposers: Array<() => void> = []
const routes = new Map<string, Handler>()

/** A Cordis stand-in exposing exactly what the host half consumes. */
function stubContext(): Context {
  return {
    get: (name: string): unknown => (name === 'webServer'
      ? {
          register: (route: { path: string, handler: Handler }): (() => void) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      : undefined),
    effect: (execute: () => unknown): unknown => {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
    logger: { warn: (): void => {}, error: (): void => {}, info: (): void => {}, debug: (): void => {} },
  } as unknown as Context
}

async function listen(): Promise<number> {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolveListen => server?.listen(0, '127.0.0.1', resolveListen))
  return (server.address() as AddressInfo).port
}

const url = (path: string): string => `${base}${path}`

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'wxskin-home-'))
  folder = mkdtempSync(join(tmpdir(), 'wxskin-pics-'))
  outside = mkdtempSync(join(tmpdir(), 'wxskin-other-'))
  writeFileSync(join(folder, 'b.jpg'), 'jpg')
  writeFileSync(join(folder, 'a.png'), PNG_BYTES)
  writeFileSync(join(folder, 'notes.txt'), 'text')
  writeFileSync(join(folder, 'logo.svg'), '<svg/>')
  writeFileSync(join(outside, 'secret.png'), PNG_BYTES)
  mkdirSync(join(folder, 'sub'), { recursive: true })
  writeFileSync(join(folder, 'sub', 'deep.png'), PNG_BYTES)

  // `settingsPath()` resolves the home at apply time, so the real ~/.dsh is never touched.
  process.env.DSH_HOME = home
  routes.clear()
  disposers = []
  apply(stubContext())
  base = `http://127.0.0.1:${await listen()}`
})

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  delete process.env.DSH_HOME
  if (server !== undefined) {
    const closing = server
    server = undefined
    await new Promise<void>((resolveClose) => {
      // fetch keeps its sockets alive, and close() alone would wait them out.
      closing.close(() => { resolveClose() })
      closing.closeAllConnections()
    })
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(folder, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('settings routes', () => {
  it('round-trips the blob through the durable file', async () => {
    const initial = await (await fetch(url('/dsh-wx-skin/load'))).json() as { ok: boolean, settings: unknown }
    expect(initial).toEqual({ ok: true, settings: null })

    const saved = await fetch(url('/dsh-wx-skin/save'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { enabled: true, source: 'folder' } }),
    })
    expect(saved.status).toBe(200)

    const loaded = await (await fetch(url('/dsh-wx-skin/load'))).json() as { settings: unknown }
    expect(loaded.settings).toEqual({ enabled: true, source: 'folder' })
    // Written atomically under the (temporary) harness home.
    expect(JSON.parse(readFileSync(join(home, 'dsh-wx-skin.settings.json'), 'utf8')))
      .toEqual({ settings: { enabled: true, source: 'folder' } })
  })

  it('rejects wrong methods', async () => {
    expect((await fetch(url('/dsh-wx-skin/save'))).status).toBe(405)
    expect((await fetch(url('/dsh-wx-skin/load'), { method: 'POST', body: '{}' })).status).toBe(405)
  })

  it('refuses a cross-site request', async () => {
    const response = await fetch(url('/dsh-wx-skin/load'), { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(response.status).toBe(403)
  })
})

describe('folder route', () => {
  it('scans a folder into the sorted bitmap list', async () => {
    const response = await fetch(url('/dsh-wx-skin/folder'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean, root: string, images: Array<{ name: string }>, truncated: boolean }
    expect(body.ok).toBe(true)
    expect(body.root).toBe(resolve(folder))
    // Subdirectories are skipped unless asked; non-bitmaps never appear.
    expect(body.images.map(image => image.name)).toEqual(['a.png', 'b.jpg'])
    expect(body.truncated).toBe(false)

    const recursive = await fetch(url('/dsh-wx-skin/folder'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder, recursive: true }),
    })
    const deep = await recursive.json() as { images: Array<{ rel: string }> }
    expect(deep.images.map(image => image.rel)).toEqual(['a.png', 'b.jpg', 'sub/deep.png'])
  })

  it('rejects a missing, non-directory, or empty path', async () => {
    const post = (path: unknown): Promise<Response> => fetch(url('/dsh-wx-skin/folder'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    expect((await post(join(folder, 'a.png'))).status).toBe(400)
    expect((await post(join(home, 'nope'))).status).toBe(400)
    expect((await post('   ')).status).toBe(400)
    expect((await post(undefined)).status).toBe(400)
  })
})

describe('image route', () => {
  /** Scan `folder` so the image route has a confinement root. */
  async function loadFolder(): Promise<void> {
    await fetch(url('/dsh-wx-skin/folder'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    })
  }

  it('serves an image from inside the loaded folder', async () => {
    const blocked = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, 'a.png'))))
    expect(blocked.status).toBe(403) // no folder loaded yet

    await loadFolder()
    const response = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, 'a.png'))))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_BYTES)).toBe(true)
  })

  it('answers HEAD with headers and no body', async () => {
    await loadFolder()
    const response = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, 'a.png'))), { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it('refuses paths outside the loaded folder and non-bitmap files', async () => {
    await loadFolder()
    const outsideRequest = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(outside, 'secret.png'))))
    expect(outsideRequest.status).toBe(403)
    const traversal = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, '..', 'wxskin-escape.png'))))
    expect(traversal.status).toBe(403)
    const text = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, 'notes.txt'))))
    expect(text.status).toBe(403)
    const svg = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, 'logo.svg'))))
    expect(svg.status).toBe(403)
  })

  it('reports a missing parameter and a missing file', async () => {
    await loadFolder()
    expect((await fetch(url('/dsh-wx-skin/image'))).status).toBe(400)
    const gone = await fetch(url('/dsh-wx-skin/image?p=' + encodeURIComponent(join(folder, 'gone.png'))))
    expect(gone.status).toBe(404)
  })
})
