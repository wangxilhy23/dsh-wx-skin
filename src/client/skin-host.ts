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
import type { SkinSettings } from '../core/types.ts'
import { sanitizeSettings } from './skin-store.ts'

/** HTTP route names served by the host half. */
export const LOAD_PATH = '/dsh-wx-skin/load'
export const SAVE_PATH = '/dsh-wx-skin/save'

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
