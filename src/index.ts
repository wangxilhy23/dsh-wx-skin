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
 *   GET  /dsh-wx-skin/load      → { ok, settings }
 *   POST /dsh-wx-skin/save      → { ok }
 *   POST /dsh-wx-skin/folder    → { ok, root, images, truncated }   (scan a picked folder)
 *   GET  /dsh-wx-skin/image     → image bytes                       (slideshow background)
 *
 * The schema lives in the browser half (sanitizeSettings); the host stores
 * and returns the raw JSON blob it receives. Routes are loopback-only and the
 * file is written atomically (temp + rename) so concurrent clients cannot
 * corrupt it. Image bytes are served only from inside the folder the user
 * picked (the last scan in this process, else `settings.folderPath`), so the
 * route can never be turned into a general file reader. When the webServer
 * service is unavailable the host half stays a no-op and the client falls back
 * to its localStorage behavior.
 * @module dsh-wx-skin
 */
import type { Context } from '@deepseek-ai/cordis'
import { createReadStream, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { imageContentType, isInsideRoot, scanImageFolder, type ScanIo } from './folder.ts'

export const name = 'dsh-wx-skin'

/** Services required before the routes can be registered. */
export const inject = ['webServer']

/** Route paths served by the host half (outside /api, mirrors /dsh-wx-* conventions). */
export const LOAD_ROUTE = '/dsh-wx-skin/load'
export const SAVE_ROUTE = '/dsh-wx-skin/save'
export const FOLDER_ROUTE = '/dsh-wx-skin/folder'
export const IMAGE_ROUTE = '/dsh-wx-skin/image'

/** Upper bound on a settings payload — image data URLs can reach ~MBs. */
const MAX_SAVE_BYTES = 16 * 1024 * 1024

/** The folder-scan request body is a path plus a flag. */
const MAX_FOLDER_BODY_BYTES = 64 * 1024

const LOOPBACK_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'http://[::1]']

/** `node:fs` bound to the scan's injected face. */
const FS_IO: ScanIo = {
  readdirSync: dir => readdirSync(dir, { withFileTypes: true }),
  statSync: path => statSync(path),
  realpathSync: path => realpathSync(path),
}

/** Root of the most recent successful scan in this process (path-confinement anchor). */
let activeRoot: string | undefined

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
  // A cross-site <img>/CSS request carries no Origin, but it does carry
  // Sec-Fetch-Site — the one signal that separates it from a same-page fetch or
  // a direct address-bar visit.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
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

/** Read the durable settings blob written by this plugin, or null when absent/corrupt. */
function readSettingsFile(path: string): unknown {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { settings?: unknown }
    return parsed?.settings ?? null
  } catch {
    return null
  }
}

/**
 * The folder image requests are confined to: the last scan performed by this
 * process, else the folder recorded in the durable settings (so a page reload
 * or a desktop-app restart keeps working). Canonicalized, and undefined when no
 * usable folder is known.
 */
function confinementRoot(settingsFile: string): string | undefined {
  if (activeRoot !== undefined) return activeRoot
  const settings = readSettingsFile(settingsFile)
  if (settings === null || typeof settings !== 'object') return undefined
  const folderPath = (settings as { folderPath?: unknown }).folderPath
  if (typeof folderPath !== 'string' || folderPath.trim() === '') return undefined
  try {
    return realpathSync(resolve(folderPath.trim()))
  } catch {
    return undefined
  }
}

/** Common method + loopback guard for every host route. */
function guard(req: IncomingMessage, res: ServerResponse, method: string | readonly string[]): boolean {
  const accepted = typeof method === 'string' ? [method] : method
  if (req.method === undefined || !accepted.includes(req.method)) {
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
 * Apply the host half: register the skin-settings persistence, folder-scan, and
 * image-serving routes.
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
        // Absent or corrupt → the client falls back to localStorage/defaults.
        sendJson(res, 200, { ok: true, settings: readSettingsFile(path) })
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

    // POST /dsh-wx-skin/folder — scan a user-picked folder into the image cache.
    disposers.push(webServer.register({
      kind: 'exact',
      path: FOLDER_ROUTE,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_FOLDER_BODY_BYTES)
        if (body === null) {
          sendJson(res, 413, { ok: false, error: 'invalid or oversized body' })
          return
        }
        const requested = body.path
        if (typeof requested !== 'string' || requested.trim() === '') {
          sendJson(res, 400, { ok: false, error: '请填写文件夹的绝对路径。' })
          return
        }
        const folder = requested.trim()
        try {
          if (!statSync(folder).isDirectory()) {
            sendJson(res, 400, { ok: false, error: '该路径不是文件夹。' })
            return
          }
        } catch {
          sendJson(res, 400, { ok: false, error: '文件夹不存在或无法访问。' })
          return
        }
        try {
          const scanned = scanImageFolder(folder, body.recursive === true, FS_IO)
          activeRoot = scanned.root
          sendJson(res, 200, {
            ok: true,
            root: scanned.root,
            images: scanned.images,
            truncated: scanned.truncated,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn('[dsh-wx-skin] folder scan failed: %s', message)
          sendJson(res, 400, { ok: false, error: `无法读取文件夹：${message}` })
        }
      },
    }))

    // GET|HEAD /dsh-wx-skin/image — serve one image from inside the picked folder.
    disposers.push(webServer.register({
      kind: 'exact',
      path: IMAGE_ROUTE,
      handler: (req, res) => {
        if (!guard(req, res, ['GET', 'HEAD'])) return
        const root = confinementRoot(path)
        if (root === undefined) {
          sendJson(res, 403, { ok: false, error: 'no folder loaded' })
          return
        }
        const target = new URL(req.url ?? '/', 'http://x').searchParams.get('p')
        if (target === null || target.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'missing p parameter' })
          return
        }
        const contentType = imageContentType(target)
        // Containment first: an accepted extension must not widen the root.
        if (contentType === undefined || !isInsideRoot(root, target, process.platform === 'win32')) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        let stats
        try {
          stats = statSync(target)
        } catch {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        if (!stats.isFile()) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': contentType,
          'content-length': String(stats.size),
          // The URL carries v=<mtimeMs>, so a changed file is a different URL.
          'cache-control': 'private, max-age=31536000, immutable',
          // User-chosen bytes must never be sniffed into an active type.
          'x-content-type-options': 'nosniff',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        const stream = createReadStream(target)
        stream.on('error', (error) => {
          ctx.logger.warn('[dsh-wx-skin] image stream failed: %s', error.message)
          res.destroy()
        })
        res.on('close', () => stream.destroy())
        stream.pipe(res)
      },
    }))

    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'dsh-wx-skin: persistence routes')
}
