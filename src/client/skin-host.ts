/**
 * dsh-wx-skin — host persistence client: loads/saves the durable settings
 * through the host half's loopback routes (/dsh-wx-skin/load,
 * /dsh-wx-skin/save), which store the copy in the DSH home directory —
 * independent of the current origin, so the background image survives the
 * desktop app's per-launch port changes.
 *
 * Module is kept free of DOM access and takes an injectable fetch so unit
 * tests exercise it without a page. Every function degrades to a safe result
 * (null / false) and never throws; the caller keeps its localStorage
 * fallback.
 * @module dsh-wx-skin/client/skin-host
 */
import type { SkinFolderImage, SkinSettings } from '../core/types.ts'
import { sanitizeFolderImages, sanitizeSettings } from './skin-store.ts'

/** HTTP route names served by the host half. */
export const LOAD_PATH = '/dsh-wx-skin/load'
export const SAVE_PATH = '/dsh-wx-skin/save'
export const FOLDER_PATH = '/dsh-wx-skin/folder'

/** Read the durable settings from the host, or null when unavailable. */
export async function hostLoad(fetchImpl: typeof fetch = globalThis.fetch): Promise<SkinSettings | null> {
  try {
    const res = await fetchImpl(LOAD_PATH)
    if (!res.ok) return null
    const body = await res.json() as { ok?: unknown; settings?: unknown }
    // The host only ever writes an object; any other shape means no usable
    // durable copy → the caller falls back to localStorage/defaults.
    if (body?.ok !== true
      || body.settings === null
      || body.settings === undefined
      || typeof body.settings !== 'object') return null
    return sanitizeSettings(body.settings)
  } catch {
    return null
  }
}

/** Persist the settings to the host; false when it could not (never throws). */
export async function hostSave(settings: SkinSettings, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(SAVE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** One successful folder scan. */
export interface FolderScanSuccess {
  ok: true
  /** Canonical folder the host will serve images from. */
  root: string
  images: SkinFolderImage[]
  truncated: boolean
}

/** A rejected folder scan, already phrased for the panel. */
export interface FolderScanFailure {
  ok: false
  error: string
}

/** Result of asking the host to scan a folder. */
export type FolderScanResult = FolderScanSuccess | FolderScanFailure

/** Message shown when the host process predates the folder route. */
const STALE_HOST = '宿主未加载文件夹接口，请重启 dsh web 后再试。'
const UNREACHABLE = '无法连接宿主接口（回环请求失败）。'

/**
 * Ask the host to scan `path` and return its images in slideshow order.
 *
 * The host is authoritative: the folder route validates that the path is a
 * readable directory and applies the path-confinement and count bounds. A
 * response that is not the expected JSON means the route is missing — an older
 * host would answer with the SPA index through its fallback — so that case
 * reports the restart hint instead of a generic failure.
 * @param path - absolute folder path typed or picked by the user.
 * @param recursive - descend into subdirectories.
 * @param fetchImpl - injectable fetch (tests).
 * @returns the scanned list, or a failure carrying a display message.
 */
export async function hostListFolder(
  path: string,
  recursive: boolean,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FolderScanResult> {
  let response: Response
  try {
    response = await fetchImpl(FOLDER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, recursive }),
    })
  } catch {
    return { ok: false, error: UNREACHABLE }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: STALE_HOST }
  }
  if (typeof body !== 'object' || body === null) return { ok: false, error: STALE_HOST }

  const record = body as Record<string, unknown>
  if (record.ok !== true) {
    const error = typeof record.error === 'string' && record.error !== '' ? record.error : '读取文件夹失败。'
    return { ok: false, error }
  }
  const images = sanitizeFolderImages(record.images)
  if (!Array.isArray(record.images) || (record.images.length > 0 && images.length === 0)) {
    return { ok: false, error: STALE_HOST }
  }
  return {
    ok: true,
    root: typeof record.root === 'string' ? record.root : path,
    images,
    truncated: record.truncated === true,
  }
}
