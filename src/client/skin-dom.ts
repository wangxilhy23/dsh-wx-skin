/**
 * dsh-wx-skin — DOM applier: owns the injected global stylesheet, the
 * background layer element, and the projection of skin settings onto the
 * document (attribute + CSS variables). Pure DOM writes; retracts only what
 * it wrote, so the default theme is untouched when the skin is off.
 * @module dsh-wx-skin/client/skin-dom
 */
import type { SkinSettings } from '../core/types.ts'
import { GLOBAL_SKIN_CSS } from './global-skin-css.ts'
import { ACTIVE_ATTR, LAYER_ATTR, SKIN_CSS_VARS, cssVariables } from './skin-store.ts'

/** Identity of the injected global <style> tag (idempotent injection key). */
export const GLOBAL_STYLE_ID = 'dsh-wx-skin/global'

/** Inject the global skin stylesheet once. Safe to call repeatedly. */
export function ensureGlobalCss(): void {
  if (document.querySelector(`style[data-plugin-css="${GLOBAL_STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
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
