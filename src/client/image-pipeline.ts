/**
 * dsh-wx-skin — local-image pipeline: read a picked file, downscale it to a
 * bounded canvas, and re-encode it to a data URL. The browser implementation
 * is injected through `PipelineEnv` so tests drive it with a fake source; the
 * pure `fileToDataUrl` logic is environment-agnostic.
 *
 * There is intentionally no input-size or output-size limit: any image the
 * canvas can decode is accepted (no "too large" rejection). The only bound is
 * the downscale to `maxEdge`, which keeps the resulting data URL small enough
 * to persist while preserving a sharp full-screen background.
 * @module dsh-wx-skin/client/image-pipeline
 */

/** A decodable raster image held by the pipeline. */
export interface ImageSource {
  width: number
  height: number
  /** Draw the source scaled to w×h into a fresh canvas and encode it. */
  render(w: number, h: number, type: string, quality: number): string
  /** Release any held resources (object URLs, …). */
  release(): void
}

/** The browser environment the pipeline runs against. */
export interface PipelineEnv {
  /** Decode a file into an ImageSource. Throws when the file is not readable. */
  readImage(file: Blob): Promise<ImageSource>
}

/** Error the pipeline throws with a stable machine-readable code. */
export class ImagePipelineError extends Error {
  constructor(
    public readonly code: 'unsupported' | 'decode' | 'encode',
    message: string,
  ) {
    super(message)
    this.name = 'ImagePipelineError'
  }
}

/** Tuning knobs for the encode. */
export interface DownscaleOptions {
  /**
   * Optional explicit cap on the longest edge of the first encode (px).
   * Omitted by default — the image keeps its original resolution up to
   * {@link DISPLAY_MAX_EDGE}; larger images are downscaled for display (a
   * background never needs more than ~4K, and oversized canvases silently
   * produce empty data URLs, which is exactly the "selected but not shown"
   * failure). Picking a file is never limited by size.
   */
  maxEdge?: number
  /** JPEG quality (0..1). Default 0.82. */
  quality?: number
  /**
   * Data-URL length budget (chars). When the encoded result exceeds this,
   * the pipeline silently re-encodes at smaller sizes so the skin stays
   * persistable; it never throws. Default 4_000_000 (safe under the ~5 MB
   * localStorage quota).
   */
  storageBudget?: number
}

/**
 * Display cap for the encoded background: images larger than this (per side)
 * are downscaled so the canvas stays inside every browser's limits and the
 * data URL stays small enough to persist. 4096 px is sharper than any screen
 * needs for a background.
 */
export const DISPLAY_MAX_EDGE = 4096

/** Raster formats the pipeline accepts (canvas can re-encode these safely). */
export const ALLOWED_TYPES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/x-png',
  'image/webp', 'image/gif', 'image/bmp', 'image/x-ms-bmp',
] as const

/** Default browser environment: object URL + <img> decode + canvas encode. */
export const browserEnv: PipelineEnv = {
  async readImage(file: Blob): Promise<ImageSource> {
    const url = URL.createObjectURL(file)
    try {
      const image = await loadImage(url)
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        render(w, h, type, quality) {
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (ctx === null) throw new Error('canvas 2d context unavailable')
          ctx.drawImage(image, 0, 0, w, h)
          return canvas.toDataURL(type, quality)
        },
        release() {
          URL.revokeObjectURL(url)
        },
      }
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  },
}

/** Load an <img> from a src, resolving on decode. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image load failed'))
    image.src = src
  })
}

/** Convert a Blob file into a JPEG data URL. Picking is never limited by file
 *  size; the encode keeps the original resolution up to the display cap and
 *  silently re-encodes smaller when the canvas would be oversized or the data
 *  URL would not persist — it never throws a size error. */
export async function fileToDataUrl(
  file: Blob,
  env: PipelineEnv = browserEnv,
  options: DownscaleOptions = {},
): Promise<string> {
  const quality = options.quality ?? 0.82
  const storageBudget = options.storageBudget ?? 4_000_000

  if (typeof (file as File).type === 'string' && (file as File).type !== '') {
    const type = (file as File).type.toLowerCase()
    if (type === 'image/svg+xml') {
      throw new ImagePipelineError('unsupported', '不支持 SVG 矢量图，请选择 PNG / JPEG / WebP / GIF / BMP 位图。')
    }
    if (!type.startsWith('image/')) {
      throw new ImagePipelineError('unsupported', `不支持的文件类型“${type}”，请选择 PNG / JPEG / WebP / GIF / BMP 图片。`)
    }
    // image/* beyond the raster whitelist (e.g. avif) proceeds to decode —
    // a codec the canvas cannot read surfaces as a clear "decode" error.
  }

  let source: ImageSource
  try {
    source = await env.readImage(file)
  } catch (error) {
    throw new ImagePipelineError('decode', '无法读取图片：文件已损坏或不是有效的图片。')
  }

  try {
    if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
      throw new ImagePipelineError('decode', '无法解析图片尺寸，文件可能已损坏。')
    }
    // First attempt: original resolution when it fits the display cap,
    // otherwise downscaled so the canvas stays inside browser limits.
    const cap = options.maxEdge ?? Math.min(Math.max(source.width, source.height), DISPLAY_MAX_EDGE)
    const first = sizeFor(source, cap)
    let data = encode(source, first.w, first.h, quality)
    // Fallback: never reject — when the encode came back invalid (oversized
    // canvases can silently yield empty data URLs) or too big to persist,
    // re-encode smaller. The last attempt always returns.
    if (!isValidDataUrl(data) || data.length > storageBudget) {
      for (const edge of [2560, 1920, 1280]) {
        if (Math.max(first.w, first.h) <= edge) continue
        const next = sizeFor(source, edge)
        data = encode(source, next.w, next.h, Math.max(0.6, quality - 0.1))
        if (isValidDataUrl(data) && data.length <= storageBudget) break
      }
    }
    return data
  } finally {
    try {
      source.release()
    } catch {
      // A release failure must not mask the primary outcome.
    }
  }
}

/** True when the encoder produced a real image payload (not an empty `data:,`). */
function isValidDataUrl(data: string): boolean {
  return data.startsWith('data:image/') && data.length > 64
}

/** Bounded target size: original dimensions, or downscaled to fit `edge`. */
function sizeFor(source: ImageSource, edge: number | undefined): { w: number; h: number } {
  if (edge === undefined) return { w: Math.max(1, Math.round(source.width)), h: Math.max(1, Math.round(source.height)) }
  const scale = Math.min(1, edge / Math.max(source.width, source.height))
  return {
    w: Math.max(1, Math.round(source.width * scale)),
    h: Math.max(1, Math.round(source.height * scale)),
  }
}

/** Draw + encode one attempt; encode failures are wrapped with a stable code. */
function encode(source: ImageSource, w: number, h: number, quality: number): string {
  try {
    return source.render(w, h, 'image/jpeg', quality)
  } catch (error) {
    throw new ImagePipelineError('encode', '图片编码失败，请换一张图片。')
  }
}
