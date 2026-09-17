/**
 * dsh-wx-skin — panel palette guard.
 *
 * The settings panel keeps its own OPAQUE surface, while `--dsw-alias-*` tokens
 * invert with the document theme. Reading an alias token inside the panel is
 * therefore the defect this suite prevents: in the dark theme
 * `--dsw-alias-label-primary` is near-white, which rendered light text on the
 * panel's light surface. The panel declares its own `--wx-panel-*` set for both
 * palettes instead, and this file checks that structure plus the contrast of
 * every pair that carries text.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/skin.module.css', import.meta.url), 'utf8')

/** Comment separating the shell-side entry rules from the panel palette. */
const PANEL_MARKER = '/* ---- popover panel ---- */'
/** Selector opening the dark palette override. */
const DARK_SELECTOR = 'body[data-ds-dark-theme] .panel {'

/** Semantic names every palette must define as colors. */
const COLOR_VARS = [
  'bg', 'fg', 'fg-muted', 'border', 'control-bg', 'control-hover',
  'accent', 'accent-fill', 'accent-fill-fg', 'danger',
] as const

/** Text-bearing pairs that must reach WCAG AA (4.5:1). */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ['fg', 'bg', 4.5],
  ['fg-muted', 'bg', 4.5],
  ['danger', 'bg', 4.5],
  ['accent-fill-fg', 'accent-fill', 4.5],
]
/** Non-text UI pair (borders, focus rings, slider accent): 3:1 is the bar. */
const UI_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ['accent', 'bg', 3],
]

const markerAt = css.indexOf(PANEL_MARKER)
const entrySection = css.slice(0, markerAt)
const panelSection = css.slice(markerAt)
const darkAt = panelSection.indexOf(DARK_SELECTOR)
const lightBlock = panelSection.slice(0, darkAt)
const darkBlock = panelSection.slice(darkAt)

/** Palette name → declared literal fallback of its `var(--dsw-static-*, #hex)`. */
function palette(block: string, where: string): Map<string, string> {
  const found = new Map<string, string>()
  const pattern = /--wx-panel-([a-z-]+):\s*var\((--dsw-static-[a-z0-9-]+),\s*(#[0-9a-fA-F]{3,8})\);/g
  for (const match of block.matchAll(pattern)) {
    const name = match[1] as string
    expect(name, `${where}: ${name} declared without a literal fallback`).toBeTruthy()
    found.set(name, (match[3] as string).toLowerCase())
  }
  expect(found.size, `${where}: no --wx-panel-* declaration parsed`).toBeGreaterThan(0)
  return found
}

/** Relative luminance of a `#rgb` or `#rrggbb` literal. */
function luminance(hex: string): number {
  const digits = hex.slice(1)
  const full = digits.length === 3 ? digits.split('').map(char => char + char).join('') : digits
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (channels[0] as number) + 0.7152 * (channels[1] as number) + 0.0722 * (channels[2] as number)
}

/** WCAG contrast ratio between two `#hex` literals. */
function contrast(foreground: string, background: string): number {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** Assert every pair of `pairs` against the palette literals. */
function assertPairs(colors: Map<string, string>, pairs: ReadonlyArray<readonly [string, string, number]>, where: string): void {
  for (const [foreground, background, minimum] of pairs) {
    const fg = colors.get(foreground)
    const bg = colors.get(background)
    expect(fg, `${where}: missing --wx-panel-${foreground}`).toBeDefined()
    expect(bg, `${where}: missing --wx-panel-${background}`).toBeDefined()
    const ratio = contrast(fg as string, bg as string)
    expect(ratio, `${where}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum)
  }
}

describe('panel palette', () => {
  it('splits the stylesheet at the panel marker', () => {
    expect(markerAt, 'panel marker comment is required by this guard').toBeGreaterThan(0)
    expect(darkAt, 'dark palette selector is required').toBeGreaterThan(0)
  })

  it('keeps the sidebar entry on theme alias tokens and the panel off them', () => {
    // The sidebar entry lives in the shell surface, where alias tokens are right.
    expect(entrySection).toContain('--dsw-alias-')
    // Alias tokens invert with the theme; the panel surface does not.
    expect(panelSection).not.toContain('--dsw-alias-')
  })

  it('defines both palettes with fallbacks, a shadow, and an explicit color-scheme', () => {
    const light = palette(lightBlock, 'light palette')
    const dark = palette(darkBlock, 'dark palette')
    for (const name of COLOR_VARS) {
      expect(light.has(name), `light palette: missing --wx-panel-${name}`).toBe(true)
      expect(dark.has(name), `dark palette: missing --wx-panel-${name}`).toBe(true)
    }
    expect(lightBlock).toContain('--wx-panel-shadow:')
    expect(darkBlock).toContain('--wx-panel-shadow:')
    expect(lightBlock).toContain('color-scheme: light;')
    expect(darkBlock).toContain('color-scheme: dark;')
    // A dark palette that merely copies the light one would defeat the switch.
    expect(dark.get('bg')).not.toBe(light.get('bg'))
    expect(dark.get('fg')).not.toBe(light.get('fg'))
  })

  it('meets AA contrast for every text pair in the light palette', () => {
    const colors = palette(lightBlock, 'light palette')
    assertPairs(colors, TEXT_PAIRS, 'light palette')
    assertPairs(colors, UI_PAIRS, 'light palette')
  })

  it('meets AA contrast for every text pair in the dark palette', () => {
    const colors = palette(darkBlock, 'dark palette')
    assertPairs(colors, TEXT_PAIRS, 'dark palette')
    assertPairs(colors, UI_PAIRS, 'dark palette')
  })

  it('keeps the primary button fill on its own hover rule', () => {
    // `.button:hover` and `.buttonPrimary:hover` share specificity; the primary
    // override must come last or hovering repaints it with the shared fill.
    const hoverRuleAt = panelSection.indexOf('.button:hover {')
    const primaryHoverAt = panelSection.indexOf('.buttonPrimary:hover {')
    expect(hoverRuleAt).toBeGreaterThan(0)
    expect(primaryHoverAt).toBeGreaterThan(hoverRuleAt)
  })
})
