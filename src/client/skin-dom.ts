/**
 * dsh-wx-skin — DOM applier: owns the injected global stylesheet, the
 * background layer element, and the projection of skin settings onto the
 * document (attribute + CSS variables). Pure DOM writes; retracts only what
 * it wrote, so the default theme is untouched when the skin is off.
 * @module dsh-wx-skin/client/skin-dom
 */
import type { SkinSettings } from '../core/types.ts'
import { GLOBAL_SKIN_CSS } from './global-skin-css.ts'
import { ACTIVE_ATTR, ENTRY_ATTR, LAYER_ATTR, SKIN_CSS_VARS, cssVariables } from './skin-store.ts'

/** Identity of the injected global <style> tag (idempotent injection key). */
export const GLOBAL_STYLE_ID = 'dsh-wx-skin/global'

/**
 * Plugin id stamped on the skin's own DOM. Must equal the package name (the
 * module graph's row id): the harness's client-hmr removes a plugin's owned
 * `<style data-plugin>` tags on reload, and claimStyles attributes an untagged
 * tag to whichever plugin materializes next — so the skin's stylesheet has to
 * carry its own owner.
 */
export const PLUGIN_ID = 'dsh-wx-skin'

/** Inject the global skin stylesheet once. Safe to call repeatedly. */
export function ensureGlobalCss(): void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${GLOBAL_STYLE_ID}"]`)
  if (existing !== null) {
    // A tag injected before ownership stamping (or by the module loader) is adopted here.
    if (!existing.hasAttribute('data-plugin')) existing.dataset.plugin = PLUGIN_ID
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = GLOBAL_STYLE_ID
  tag.textContent = GLOBAL_SKIN_CSS
  document.head.appendChild(tag)
}

/** Ensure the full-viewport background layer exists and return it. */
export function ensureLayer(): HTMLDivElement {
  let layer = document.querySelector<HTMLDivElement>(`div[${LAYER_ATTR}]`)
  if (layer === null) {
    layer = document.createElement('div')
    layer.setAttribute(LAYER_ATTR, '')
    document.body.appendChild(layer)
  }
  return layer
}

/**
 * Apply skin settings to the document: toggle the gating attribute on
 * documentElement and write/retract the four CSS variables every time (so a
 * disabled skin leaves no residue).
 */
export class SkinApplier {
  apply(settings: SkinSettings): void {
    const root = document.documentElement
    if (settings.enabled) root.setAttribute(ACTIVE_ATTR, '')
    else root.removeAttribute(ACTIVE_ATTR)
    const vars = cssVariables(settings)
    for (const name of SKIN_CSS_VARS) {
      const value = vars[name]
      if (value === undefined) root.style.removeProperty(name)
      else root.style.setProperty(name, value)
    }
  }
}

/**
 * Remove everything the skin mounted: sidebar entries, the background layer,
 * the global stylesheet, and the document-level attributes/variables. Every
 * step is a query-then-remove, so this is idempotent and safe to call from a
 * fiber disposer, a failed mount, or both.
 */
export function teardownSkinDom(): void {
  for (const entry of document.querySelectorAll(`[${ENTRY_ATTR}]`)) entry.remove()
  document.querySelector<HTMLElement>(`div[${LAYER_ATTR}]`)?.remove()
  document.querySelector<HTMLElement>(`style[data-plugin-css="${GLOBAL_STYLE_ID}"]`)?.remove()
  const root = document.documentElement
  root.removeAttribute(ACTIVE_ATTR)
  for (const name of SKIN_CSS_VARS) root.style.removeProperty(name)
}
