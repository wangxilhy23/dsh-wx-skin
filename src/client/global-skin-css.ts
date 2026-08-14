/**
 * dsh-wx-skin — global skin stylesheet, injected once as a <style> tag by
 * mount. Everything is gated on the `data-wx-skin-active` attribute on
 * documentElement, which the DOM applier toggles; with the attribute absent
 * the sheet is inert and the default theme is untouched.
 *
 * Design: a full-viewport fixed layer paints the chosen image/color, and the
 * alias surface tokens are overridden with translucent values so the
 * background shows through while text stays readable. The light/dark palette
 * branches ride `body[data-ds-dark-theme]`, exactly like the theme's own
 * token sheets.
 *
 * Stacking: measured on the real DSH shell, a `position: fixed` layer with
 * `z-index: -1` never paints (it lands behind the canvas background), while a
 * positive z-index layer paints fine. So the layer sits at `z-index: 0` and
 * the app root `#root` is lifted to `z-index: 1` — the layer renders behind
 * the app and shows through its translucent surfaces.
 *
 * Translucency: every surface token is `rgb(<static palette literal> /
 * var(--wx-skin-surface))` — a user-adjustable surface opacity (default 0.72)
 * — with no `color-mix()` dependency, so it works on any modern browser.
 * @module dsh-wx-skin/client/global-skin-css
 */

export const GLOBAL_SKIN_CSS = String.raw`
/* ---- background layer (paints behind the app, above the canvas) ---- */
html[data-wx-skin-active] div[data-wx-skin-layer] {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: var(--wx-skin-bg-image, none);
  background-color: var(--wx-skin-bg-color, transparent);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  filter: blur(var(--wx-skin-blur, 0px));
}

/* dim / scrim overlay between the image and the translucent surfaces */
html[data-wx-skin-active] div[data-wx-skin-layer]::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--wx-skin-scrim, transparent);
}

/* keep the canvas neutral so nothing opaque hides the layer */
html[data-wx-skin-active] body {
  background: transparent !important;
}

/* lift the app above the layer; its translucent surfaces let it show through */
html[data-wx-skin-active] #root {
  position: relative !important;
  z-index: 1 !important;
}

/* ---- translucent surfaces: light palette ---- */
html[data-wx-skin-active] body {
  --dsw-alias-bg-base: rgb(255 255 255 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-layer-1: rgb(255 255 255 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-layer-2: rgb(255 255 255 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-layer-3: rgb(255 255 255 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-overlay: rgb(233 236 242 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-module-platform: rgb(245 246 247 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-multi-select: rgb(245 246 247 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-sidebar-fill: rgb(249 250 251 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-input-major: rgb(255 255 255 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-selector: rgb(245 246 247 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-tip: rgb(245 246 247 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-bubble: rgb(237 243 254 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-bubble-highlight: rgb(211 226 255 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-code-block: rgb(249 250 251 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-code-block-banner: rgb(249 250 251 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-inline-code: rgb(235 238 242 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-placeholder: rgb(245 246 247 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-tag: rgb(241 243 245 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-citation: rgb(235 238 242 / var(--wx-skin-surface, 0.72)) !important;
}

/* ---- translucent surfaces: dark palette ---- */
html[data-wx-skin-active] body[data-ds-dark-theme] {
  --dsw-alias-bg-base: rgb(21 21 23 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-layer-1: rgb(35 35 36 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-layer-2: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-layer-3: rgb(53 54 56 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-overlay: rgb(97 102 107 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-module-platform: rgb(53 54 56 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-bg-multi-select: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-sidebar-fill: rgb(27 27 28 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-input-major: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-selector: rgb(53 54 56 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-tip: rgb(53 54 56 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-bubble: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-specific-bubble-highlight: rgb(67 69 74 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-code-block: rgb(27 27 28 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-code-block-banner: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-inline-code: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-placeholder: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-tag: rgb(44 44 46 / var(--wx-skin-surface, 0.72)) !important;
  --dsw-alias-markdown-citation: rgb(53 54 56 / var(--wx-skin-surface, 0.72)) !important;
}

/* ---- sidebar entry active indicator ---- */
html[data-wx-skin-active] button[data-wx-skin-entry] {
  color: var(--dsw-alias-state-business-primary, #4176e6);
}
`
