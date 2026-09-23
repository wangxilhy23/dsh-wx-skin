/**
 * dsh-wx-skin — global skin stylesheet guard.
 *
 * The translucent-surface palette is a promise: every `--dsw-*` surface token
 * the shell paints with follows the user's 透出 slider, in both themes. Two
 * regressions this suite catches:
 *
 * 1. A token covered in one palette but not the other (the dark block drifting
 *    behind the light one).
 * 2. A hard-coded surface value instead of `rgb(<hue> / var(--wx-skin-surface))`.
 *    DSH 0.1.7 made exactly that change to `--dsw-specific-menu` — it stopped
 *    being an alias of a token this sheet already took over and became a literal
 *    rgba, so the shell's menus left the slider's control.
 */
import { describe, expect, it } from 'vitest'
import { GLOBAL_SKIN_CSS } from '../src/client/global-skin-css.ts'

const LIGHT_MARKER = 'html[data-wx-skin-active] body {'
const DARK_MARKER = 'html[data-wx-skin-active] body[data-ds-dark-theme] {'

/** Surface tokens the skin promises to keep translucent, in either palette. */
const REQUIRED_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-menu',
  '--dsw-specific-input-major',
  '--dsw-specific-selector',
  '--dsw-specific-tip',
  '--dsw-specific-bubble',
  '--dsw-specific-bubble-highlight',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-markdown-placeholder',
  '--dsw-alias-markdown-tag',
  '--dsw-alias-markdown-citation',
] as const

const lightAt = GLOBAL_SKIN_CSS.indexOf(LIGHT_MARKER)
const darkAt = GLOBAL_SKIN_CSS.indexOf(DARK_MARKER)
const lightBlock = GLOBAL_SKIN_CSS.slice(lightAt, darkAt)
const darkBlock = GLOBAL_SKIN_CSS.slice(darkAt, GLOBAL_SKIN_CSS.indexOf('}', darkAt) + 1)

/** `--dsw-*` declarations of one palette block, name → whole declaration. */
function palette(block: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of block.matchAll(/^\s*(--dsw-[a-z0-9-]+):\s*([^;]+);/gm)) {
    found.set(match[1] as string, (match[2] as string).trim())
  }
  return found
}

describe('global skin stylesheet', () => {
  it('splits the sheet into the light and dark palettes', () => {
    expect(lightAt, 'light palette selector is required').toBeGreaterThan(0)
    expect(darkAt, 'dark palette selector is required').toBeGreaterThan(lightAt)
    expect(palette(lightBlock).size).toBeGreaterThan(0)
    expect(palette(darkBlock).size).toBeGreaterThan(0)
  })

  it('covers the same surface tokens in both palettes', () => {
    const light = palette(lightBlock)
    const dark = palette(darkBlock)
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort())
    for (const token of REQUIRED_TOKENS) {
      expect(light.has(token), `light palette: missing ${token}`).toBe(true)
      expect(dark.has(token), `dark palette: missing ${token}`).toBe(true)
    }
  })

  it('routes every surface through the 透出 variable instead of a literal', () => {
    for (const [where, block] of [['light', lightBlock], ['dark', darkBlock]] as const) {
      const tokens = palette(block)
      expect(tokens.size, `${where} palette: no --dsw-* declaration parsed`).toBeGreaterThan(0)
      for (const [token, value] of tokens) {
        expect(value, `${where} palette: ${token} ignores --wx-skin-surface`).toContain('var(--wx-skin-surface')
      }
      // The `!important` is what outranks the shell's own declaration (and the
      // darwin near-opaque menu override in its base.css).
      expect(block).toContain('var(--wx-skin-surface, 0.72)) !important;')
    }
  })

  it('lets the 适合度 (fit mode) drive the layer longhands', () => {
    // The applier writes these three from the chosen mode; hard-coding them in
    // the layer again would silently pin the wallpaper to 填充.
    const layerAt = GLOBAL_SKIN_CSS.indexOf('div[data-wx-skin-layer] {')
    const layerRule = GLOBAL_SKIN_CSS.slice(layerAt, GLOBAL_SKIN_CSS.indexOf('}', layerAt))
    expect(layerAt).toBeGreaterThan(0)
    expect(layerRule).toContain('background-size: var(--wx-skin-bg-size, cover);')
    expect(layerRule).toContain('background-repeat: var(--wx-skin-bg-repeat, no-repeat);')
    expect(layerRule).toContain('background-position: var(--wx-skin-bg-position, center);')
  })
})
