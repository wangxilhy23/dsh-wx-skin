/**
 * dsh-wx-skin — folder image scanning and path confinement.
 *
 * The host half reads a user-picked folder into a cached image list and later
 * serves individual files back over a loopback route. Both steps need the same
 * two facts — which files count as images, and whether a candidate path really
 * lives inside the configured root — so they live here as pure functions with
 * an injected filesystem face. Unit tests drive a fake `ScanIo`; the routes
 * pass `node:fs`.
 *
 * Nothing here touches the DOM or the Cordis context, and it sits at the host
 * half's root (not under `core/`) because of its `node:path` import: the client
 * tsconfig type-checks only `src/client` + `src/core`, and that boundary is what
 * keeps node builtins out of the browser bundle.
 * @module dsh-wx-skin/folder
 */
import { basename, resolve, sep } from 'node:path'

/** Bitmap formats the folder slideshow accepts (case-insensitive, no SVG). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const

/** One accepted extension. */
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]

const CONTENT_TYPES: Readonly<Record<ImageExtension, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/** One cached image entry (also the shape persisted in the settings blob). */
export interface FolderImage {
  /** Absolute host path — the key the slideshow records as used. */
  path: string
  /** File name (display). */
  name: string
  /** Path relative to the scanned root, with `/` separators (sort key). */
  rel: string
  /** Size in bytes at scan time. */
  size: number
  /** Modification time in ms at scan time (cache-busting token). */
  mtimeMs: number
}

/** The extension of `file` when it is an accepted bitmap, else undefined. */
export function imageExtension(file: string): ImageExtension | undefined {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = file.slice(dot + 1).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extension)
    ? extension as ImageExtension
    : undefined
}

/** The HTTP content type for an accepted bitmap, else undefined. */
export function imageContentType(file: string): string | undefined {
  const extension = imageExtension(file)
  return extension === undefined ? undefined : CONTENT_TYPES[extension]
}

/**
 * Whether `candidate` is the root itself or lives below it. Comparison is
 * prefix-on-path-separator, so `/pics2` never passes as inside `/pics`;
 * Windows paths are compared case-insensitively.
 */
export function isInsideRoot(root: string, candidate: string, caseInsensitive = false): boolean {
  const normalize = (value: string): string => {
    const absolute = resolve(value)
    return caseInsensitive ? absolute.toLowerCase() : absolute
  }
  const base = normalize(root)
  const target = normalize(candidate)
  const prefix = base.endsWith(sep) ? base : base + sep
  return target === base || target.startsWith(prefix)
}

/** One directory entry as `readdirSync(dir, { withFileTypes: true })` reports it. */
export interface DirEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** The slice of `node:fs` the scan uses. */
export interface ScanIo {
  /** Directory entries with their type, as `readdirSync(dir, { withFileTypes: true })` returns them. */
  readdirSync(dir: string): ReadonlyArray<DirEntry>
  /** File metadata, as `statSync(path)` returns it. */
  statSync(path: string): { isFile(): boolean; size: number; mtimeMs: number }
  /** Canonical absolute path, as `realpathSync(path)` returns it. */
  realpathSync(path: string): string
}

/** Scan bounds: a whole drive of wallpapers must not stall the host. */
export interface ScanLimits {
  /** Maximum images returned (and therefore cached). */
  maxImages: number
  /** Maximum directory entries examined before the scan stops early. */
  maxScan: number
  /** Maximum recursion depth below the root (recursive scans only). */
  maxDepth: number
}

/** Default scan bounds. */
export const SCAN_LIMITS: ScanLimits = { maxImages: 2000, maxScan: 20000, maxDepth: 6 }

/** One scan result. */
export interface ScanResult {
  /** Canonical absolute root the returned paths live under. */
  root: string
  /** Image entries sorted by `rel` (natural, case-insensitive). */
  images: FolderImage[]
  /** Whether a bound stopped the scan before the folder was exhausted. */
  truncated: boolean
}

/** Natural-order comparator shared by the host scan and the browser's re-sort. */
export function compareRel(left: string, right: string): number {
  return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(left, right)
}

/**
 * Collect the accepted bitmap files under `root`.
 *
 * Symlinks are skipped outright (they can escape the root and form loops), so
 * every returned path is a real file directly below the canonical root.
 * @param root - directory picked by the user (any form `path.resolve` accepts).
 * @param recursive - descend into subdirectories.
 * @param io - filesystem face (tests pass a fake).
 * @param limits - scan bounds.
 * @returns the canonical root plus the sorted image list and truncation flag.
 * @throws {Error} when the root itself cannot be resolved or read.
 */
export function scanImageFolder(
  root: string,
  recursive: boolean,
  io: ScanIo,
  limits: ScanLimits = SCAN_LIMITS,
): ScanResult {
  const canonicalRoot = io.realpathSync(resolve(root))
  const images: FolderImage[] = []
  let scanned = 0
  let truncated = false
  const pending: Array<{ dir: string, depth: number }> = [{ dir: canonicalRoot, depth: 0 }]

  while (pending.length > 0) {
    const current = pending.shift() as { dir: string, depth: number }
    let entries: ReadonlyArray<DirEntry>
    try {
      entries = io.readdirSync(current.dir)
    } catch {
      // An unreadable subdirectory is skipped; the root was validated by the caller.
      continue
    }
    for (const entry of entries) {
      if (scanned >= limits.maxScan) {
        truncated = true
        pending.length = 0
        break
      }
      scanned += 1
      if (entry.name.startsWith('.')) continue
      const full = resolve(current.dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (recursive && current.depth + 1 <= limits.maxDepth) pending.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (imageExtension(entry.name) === undefined) continue
      if (images.length >= limits.maxImages) {
        truncated = true
        pending.length = 0
        break
      }
      let stats: { isFile(): boolean, size: number, mtimeMs: number }
      try {
        stats = io.statSync(full)
      } catch {
        continue
      }
      if (!stats.isFile()) continue
      images.push({
        path: full,
        name: basename(full),
        rel: full.slice(canonicalRoot.length + 1).split(sep).join('/'),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      })
    }
  }

  images.sort((left, right) => compareRel(left.rel, right.rel))
  return { root: canonicalRoot, images, truncated }
}
