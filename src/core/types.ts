/**
 * dsh-wx-skin shared types (host + browser halves).
 * @module dsh-wx-skin/core/types
 */

/** Which background source the skin currently paints. */
export type SkinSource = 'image' | 'url' | 'preset' | 'none'

/** Durable skin settings persisted in browser localStorage. */
export interface SkinSettings {
  /** Whether the skin is applied to the document. */
  enabled: boolean
  /** Active background source. */
  source: SkinSource
  /** Rasterized local image as a data URL (`source === 'image'`). */
  imageDataUrl: string | null
  /** Remote / absolute image URL (`source === 'url'`). */
  url: string | null
  /** CSS background value of the active preset — solid color or gradient (`source === 'preset'`). */
  preset: string | null
  /** Black scrim opacity 0..0.8, applied between the image and the surfaces. */
  dim: number
  /** Blur radius in px on the background layer, 0..24. */
  blur: number
  /** Surface opacity 0.5..1 — how see-through the app surfaces are (0.5 = very, 1 = opaque). */
  surface: number
}
