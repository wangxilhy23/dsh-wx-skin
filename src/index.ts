/**
 * dsh-wx-skin — host half: server-side persistence for the skin settings.
 *
 * The browser half keeps a copy of the settings in localStorage, which is
 * scoped to the page origin. The desktop app (dsh-wx-desktop) launches
 * `dsh web --port 0`, so the OS assigns a fresh port — and therefore a fresh
 * origin and an empty localStorage bucket — on every launch, which used to
 * wipe the background image. These two webServer routes move the durable copy
 * of the settings into the DSH home directory, where it survives any origin
 * change and is shared by every client on this machine (browser GUI at :3080
 * and the desktop app alike):
 *
 *   GET  /dsh-wx-skin/load → { ok, settings }
 *   POST /dsh-wx-skin/save → { ok }
 *
 * The schema lives in the browser half (sanitizeSettings); the host stores
 * and returns the raw JSON blob it receives. Routes are loopback-only and the
 * file is written atomically (temp + rename) so concurrent clients cannot
 * corrupt it. When the webServer service is unavailable the host half stays a
 * no-op and the client falls back to its localStorage behavior.
 * @module dsh-wx-skin
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-wx-skin'

/** Services required before the routes can be registered. */
export const inject = ['webServer']

/** Route paths served by the host half (outside /api, mirrors /dsh-wx-* conventions). */
export const LOAD_ROUTE = '/dsh-wx-skin/load'
export const SAVE_ROUTE = '/dsh-wx-skin/save'

/** Upper bound on a settings payload — image data URLs can reach ~MBs. */
const MAX_SAVE_BYTES = 16 * 1024 * 1024

const LOOPBACK_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'http://[::1]']

/** The dsh home directory ($DSH_HOME, else ~/.dsh). */
function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

/** Durable settings file path — one shared copy per machine. */
function settingsPath(): string {
  return join(resolveDshHome(), 'dsh-wx-skin.settings.json')
}

/** Whether a request may reach the host routes: loopback origin only. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true // same-origin fetch omits Origin
  return LOOPBACK_ORIGINS.some((base) => origin === base || origin.startsWith(`${base}:`))
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Read a bounded JSON body to a plain object, or null when absent/invalid/oversized. */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > maxBytes) return null
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Common method + loopback guard for every host route. */
function guard(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method !== method) {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  return true
}

/** Minimal shape of the webServer route-registration service. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Apply the host half: register the skin-settings persistence routes.
 * @param ctx - the Cordis context.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn('[dsh-wx-skin] webServer service unavailable; host persistence disabled (localStorage fallback)')
    return
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const path = settingsPath()

    // GET /dsh-wx-skin/load — read the durable copy (raw; client sanitizes).
    disposers.push(webServer.register({
      kind: 'exact',
      path: LOAD_ROUTE,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        let settings: unknown = null
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as { settings?: unknown }
          settings = parsed?.settings ?? null
        } catch {
          settings = null // absent or corrupt → client falls back to localStorage/defaults
        }
        sendJson(res, 200, { ok: true, settings })
      },
    }))

    // POST /dsh-wx-skin/save — atomically persist the settings blob.
    disposers.push(webServer.register({
      kind: 'exact',
      path: SAVE_ROUTE,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_SAVE_BYTES)
        if (body === null) {
          sendJson(res, 413, { ok: false, error: 'invalid or oversized body' })
          return
        }
        const settings = body.settings
        if (typeof settings !== 'object' || settings === null) {
          sendJson(res, 400, { ok: false, error: 'missing settings payload' })
          return
        }
        try {
          mkdirSync(dirname(path), { recursive: true })
          const tmp = `${path}.${process.pid}.tmp`
          writeFileSync(tmp, JSON.stringify({ settings }), 'utf8')
          renameSync(tmp, path)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn('[dsh-wx-skin] save failed: %s', message)
          sendJson(res, 500, { ok: false, error: message })
        }
      },
    }))

    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'dsh-wx-skin: persistence routes')
}
