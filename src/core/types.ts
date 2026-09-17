/**
 * dsh-wx-skin shared types (host + browser halves).
 * @module dsh-wx-skin/core/types
 */

/** Which background source the skin currently paints. */
export type SkinSource = 'image' | 'url' | 'preset' | 'folder' | 'none'

/** How the folder slideshow picks the next image. */
export type SkinOrderMode = 'sequential' | 'random'

/** One cached folder image (mirrors the host scan entry). */
export interface SkinFolderImage {
  /** Absolute host path — the identity recorded in `usedPaths`. */
  path: string
  /** File name (display). */
  name: string
  /** Path relative to the scanned root, `/`-separated (sort key). */
  rel: string
  /** Size in bytes at scan time. */
  size: number
  /** Modification time in ms at scan time (cache-busting token in the image URL). */
  mtimeMs: number
}

/** Durable skin settings persisted in browser localStorage. */
export interface SkinSettings {
  /** Whether the skin is applied to the document. */
  enabled: boolean
  /** Active background source. */
  source: SkinSource
  /** Rasterized local image as a data URL (`source === 'image'`). */
  imageDataUrl: string | null
  /** File name of the picked local image (`source === 'image'`); null when unknown. */
  imageName: string | null
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
  /** Last folder loaded by the slideshow; the host confines image requests to it. */
  folderPath: string | null
  /** Cached image list of `folderPath`, in slideshow order (`source === 'folder'`). */
  folderImages: SkinFolderImage[]
  /** Whether the last scan descended into subdirectories. */
  folderRecursive: boolean
  /** Sequential (filename order) or random (uniform over the unused images). */
  orderMode: SkinOrderMode
  /** Index into `folderImages` of the image currently shown; -1 when none. */
  currentIndex: number
  /** Paths already shown in the current pass — never picked again until the pass ends. */
  usedPaths: string[]
}
