/**
 * dsh-wx-skin — image-pipeline unit tests (fake PipelineEnv, no canvas/DOM).
 */
import { describe, expect, it } from 'vitest'
import { ImagePipelineError, fileToDataUrl, type ImageSource, type PipelineEnv } from '../src/client/image-pipeline.ts'

interface RenderCall {
  w: number
  h: number
  type: string
  quality: number
}

/** Fake env that encodes the source as a fixed-length data URL. */
function makeEnv(options: {
  width: number
  height: number
  /** Data-URL length produced per render attempt (can be a function). */
  dataLength?: number | ((w: number, h: number) => number)
  /** Whether readImage throws. */
  readFails?: boolean
  /** Whether render throws. */
  renderFails?: boolean
}): { env: PipelineEnv; calls: RenderCall[]; released: () => number } {
  let releasedCount = 0
  const calls: RenderCall[] = []
  const { width, height } = options
  const source: ImageSource = {
    width,
    height,
    render(w, h, type, quality) {
      calls.push({ w, h, type, quality })
      if (options.renderFails === true) throw new Error('encode exploded')
      const length = typeof options.dataLength === 'function'
        ? options.dataLength(w, h)
        : (options.dataLength ?? 100)
      return `data:image/jpeg;base64,${'A'.repeat(Math.max(4, length))}`
    },
    release() {
      releasedCount += 1
    },
  }
  const env: PipelineEnv = {
    async readImage() {
      if (options.readFails === true) throw new Error('decode exploded')
      return source
    },
  }
  return { env, calls, released: () => releasedCount }
}

function fileLike(type: string, size: number): Blob {
  return { type, size } as unknown as Blob
}

describe('fileToDataUrl', () => {
  it('rejects unsupported MIME types', async () => {
    await expect(fileToDataUrl(fileLike('image/svg+xml', 100), makeEnv({ width: 10, height: 10 }).env))
      .rejects.toMatchObject({ code: 'unsupported' })
  })

  it('accepts empty MIME (unknown file) and tries to decode', async () => {
    const { env, calls } = makeEnv({ width: 100, height: 50 })
    const url = await fileToDataUrl(fileLike('', 100), env)
    expect(url).toContain('data:image/jpeg;base64,')
    expect(calls).toHaveLength(1)
  })

  it('accepts any input size (no size limit)', async () => {
    const { env, calls, released } = makeEnv({ width: 4000, height: 2000 })
    // A huge input file (well past the old 30 MB cap) is accepted and
    // downscaled to the max edge.
    const url = await fileToDataUrl(fileLike('image/png', 200 * 1024 * 1024), env, { maxEdge: 2560 })
    expect(url).toContain('data:image/jpeg;base64,')
    expect(calls[0]).toMatchObject({ w: 2560, h: 1280 })
    expect(released()).toBe(1)
  })

  it('surfaces decode failures', async () => {
    const { env, released } = makeEnv({ width: 10, height: 10, readFails: true })
    await expect(fileToDataUrl(fileLike('image/png', 100), env))
      .rejects.toMatchObject({ code: 'decode' })
    expect(released()).toBe(0)
  })

  it('rejects zero dimensions as undecodable', async () => {
    const { env, released } = makeEnv({ width: 0, height: 0 })
    await expect(fileToDataUrl(fileLike('image/png', 100), env))
      .rejects.toMatchObject({ code: 'decode' })
    expect(released()).toBe(1)
  })

  it('downscales to the max edge and encodes at quality', async () => {
    const { env, calls, released } = makeEnv({ width: 4000, height: 2000 })
    const url = await fileToDataUrl(fileLike('image/png', 1000), env, { maxEdge: 2560, quality: 0.8 })
    expect(url).toContain('data:image/jpeg;base64,')
    // scale = 2560 / 4000 = 0.64 → 2560 × 1280
    expect(calls[0]).toMatchObject({ w: 2560, h: 1280, type: 'image/jpeg', quality: 0.8 })
    expect(released()).toBe(1)
  })

  it('upscales nothing (scale capped at 1)', async () => {
    const { env, calls } = makeEnv({ width: 800, height: 600 })
    await fileToDataUrl(fileLike('image/jpeg', 100), env, { maxEdge: 2560 })
    expect(calls[0]).toMatchObject({ w: 800, h: 600 })
  })

  it('keeps the original resolution by default (no downscale, no size limit)', async () => {
    const { env, calls, released } = makeEnv({ width: 4000, height: 2000 })
    const url = await fileToDataUrl(fileLike('image/jpeg', 100), env)
    expect(url).toContain('data:image/jpeg;base64,')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ w: 4000, h: 2000 })
    expect(released()).toBe(1)
  })

  it('silently shrinks only when the data URL would exceed the storage budget (never throws)', async () => {
    const { env, calls, released } = makeEnv({
      width: 4000,
      height: 2000,
      dataLength: (w) => (w > 1500 ? 9_000_000 : 1000),
    })
    const url = await fileToDataUrl(fileLike('image/jpeg', 100), env, { storageBudget: 1_000_000 })
    expect(url).toContain('data:image/jpeg;base64,')
    // Original 4000-wide is 9M (over budget) → 2560 → 1920 (still over) →
    // 1280 fits. No error is thrown; the result always returns.
    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatchObject({ w: 4000 })
    expect(calls[1]).toMatchObject({ w: 2560 })
    expect(calls[2]).toMatchObject({ w: 1920 })
    expect(calls[3]).toMatchObject({ w: 1280 })
    expect(released()).toBe(1)
  })

  it('caps oversized images to the display edge so the canvas stays valid', async () => {
    // A 20000×10000 image (like a >40 MB panorama) would blow browser canvas
    // limits at original size; it is downscaled to 4096 and still encodes.
    const { env, calls, released } = makeEnv({ width: 20000, height: 10000 })
    const url = await fileToDataUrl(fileLike('image/png', 50 * 1024 * 1024), env)
    expect(url).toContain('data:image/jpeg;base64,')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ w: 4096, h: 2048 })
    expect(released()).toBe(1)
  })

  it('recovers from an empty data URL (oversized canvas case) by re-encoding smaller', async () => {
    // render returns a useless `data:,` for the first attempt (what browsers
    // do when the canvas is oversized) — the pipeline must fall back, not
    // return an undisplayable result.
    const { env, calls, released } = makeEnv({
      width: 20000,
      height: 10000,
      dataLength: (w) => (w > 1500 ? 5 : 1000), // tiny/empty payload while huge
    })
    const url = await fileToDataUrl(fileLike('image/png', 50 * 1024 * 1024), env)
    expect(url).toContain('data:image/jpeg;base64,')
    // 4096 first (5 chars = invalid) → 2560 → 1920 → 1280 (1000, valid).
    expect(calls).toHaveLength(4)
    expect(calls[3]).toMatchObject({ w: 1280 })
    expect(released()).toBe(1)
  })

  it('surfaces encode failures as code "encode"', async () => {
    const { env, released } = makeEnv({ width: 100, height: 100, renderFails: true })
    await expect(fileToDataUrl(fileLike('image/png', 100), env))
      .rejects.toMatchObject({ code: 'encode' })
    expect(released()).toBe(1)
  })

  it('is an Error subclass with a stable name', () => {
    const err = new ImagePipelineError('decode', 'boom')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ImagePipelineError')
    expect(err.code).toBe('decode')
  })
})
