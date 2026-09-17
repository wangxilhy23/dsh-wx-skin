/**
 * dsh-wx-skin — folder slideshow state machine (pure, DOM-free).
 *
 * The host scans a folder once and returns its images; everything after that is
 * decided here: the slideshow order, which image the next click shows, and the
 * "already shown" bookkeeping. The rule the UI promises is a pass over the
 * folder: an image that has been shown is never picked again until every image
 * has been shown, at which point the pass restarts — and the restart does not
 * immediately repeat the image on screen (unless it is the only one).
 *
 * `advanceFolder` takes its randomness through `rng` so tests are deterministic.
 * @module dsh-wx-skin/client/skin-folder
 */
import type { SkinFolderImage, SkinSettings } from '../core/types.ts'

/** Host route serving one image file inside the configured folder. */
export const IMAGE_ROUTE = '/dsh-wx-skin/image'

/** Upper bound on the cached list (mirrors the host scan bound). */
export const MAX_CACHED_IMAGES = 2000

/** Natural-order comparator on the root-relative path (`img2` before `img10`). */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Return a copy of `images` in slideshow order. */
export function sortFolderImages(images: readonly SkinFolderImage[]): SkinFolderImage[] {
  return [...images].sort((left, right) => collator.compare(left.rel, right.rel))
}

/** The host URL for one cached image; `v` invalidates the browser cache when the file changes. */
export function imageUrl(image: SkinFolderImage): string {
  return `${IMAGE_ROUTE}?p=${encodeURIComponent(image.path)}&v=${encodeURIComponent(String(image.mtimeMs))}`
}

/** Slideshow counters for the panel's status line. */
export interface FolderStatus {
  /** 1-based position of the shown image, 0 when none is shown. */
  position: number
  /** Total cached images. */
  total: number
  /** Images already shown in the current pass. */
  usedThisPass: number
}

/** Read the panel-facing counters out of the settings. */
export function folderStatus(settings: SkinSettings): FolderStatus {
  const total = settings.folderImages.length
  const used = new Set(settings.folderImages.map(image => image.path))
  return {
    position: settings.currentIndex >= 0 && settings.currentIndex < total ? settings.currentIndex + 1 : 0,
    total,
    usedThisPass: settings.usedPaths.filter(path => used.has(path)).length,
  }
}

/** The next unused index after `currentIndex` (ascending order), or undefined when the list is empty. */
function pickSequential(unused: readonly number[], currentIndex: number): number | undefined {
  if (unused.length === 0) return undefined
  for (const index of unused) {
    if (index > currentIndex) return index
  }
  return unused[0]
}

/**
 * Advance the slideshow by one image and record it as shown.
 *
 * Unused images first; when none remain, the pass restarts (the used set is
 * cleared) and the currently shown image is excluded, so a full cycle never
 * repeats back-to-back. Returns the settings unchanged when there is nothing to
 * show (an empty folder), so callers can treat "index did not move" as "no
 * folder loaded".
 * @param settings - current settings.
 * @param rng - uniform [0,1) source for random mode (injected by tests).
 * @returns the next settings value.
 */
export function advanceFolder(settings: SkinSettings, rng: () => number = Math.random): SkinSettings {
  const images = settings.folderImages
  if (images.length === 0) return { ...settings, currentIndex: -1, usedPaths: [] }

  const indexOfPath = new Map(images.map((image, index) => [image.path, index] as const))
  const used = new Set<number>()
  for (const path of settings.usedPaths) {
    const index = indexOfPath.get(path)
    if (index !== undefined) used.add(index)
  }

  let candidates = images.map((_, index) => index).filter(index => !used.has(index))
  let nextUsed = used
  if (candidates.length === 0) {
    // The pass is complete: clear the record, but never re-pick what is on screen.
    nextUsed = new Set<number>()
    candidates = images.map((_, index) => index)
      .filter(index => images.length === 1 || index !== settings.currentIndex)
  }

  const picked = settings.orderMode === 'random'
    ? candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(rng() * candidates.length)))]
    : pickSequential(candidates, settings.currentIndex)
  /* v8 ignore next -- candidates is non-empty: either image indices exist or the single-image pass is non-empty. */
  if (picked === undefined) return settings

  const usedThisPass = [...nextUsed, picked].sort((left, right) => left - right)
  return {
    ...settings,
    enabled: true,
    source: 'folder',
    currentIndex: picked,
    usedPaths: usedThisPass.map(index => (images[index] as SkinFolderImage).path),
  }
}

/**
 * Fold a fresh scan into the settings.
 *
 * Re-loading the same folder with an unchanged list keeps the current image and
 * the pass record (aligned by path); a new folder, or a changed list, starts a
 * fresh pass. Loading a folder always clears the other background sources so
 * localStorage keeps only the (small) path cache.
 * @param settings - current settings.
 * @param folderPath - the folder that was just scanned.
 * @param recursive - whether that scan descended into subdirectories.
 * @param images - the scanned images, already in slideshow order.
 * @returns settings pointing at the folder, with one image picked when any exist.
 */
export function loadFolderState(
  settings: SkinSettings,
  folderPath: string,
  recursive: boolean,
  images: readonly SkinFolderImage[],
): SkinSettings {
  const sorted = sortFolderImages(images).slice(0, MAX_CACHED_IMAGES)
  const currentPath = settings.folderImages[settings.currentIndex]?.path
  const previous = settings.folderImages.map(image => image.path)
  const unchanged = folderPath === settings.folderPath
    && previous.length === sorted.length
    && previous.every((path, index) => path === (sorted[index] as SkinFolderImage).path)

  const keptPaths = new Set(sorted.map(image => image.path))
  const base: SkinSettings = {
    ...settings,
    enabled: true,
    source: 'folder',
    imageDataUrl: null,
    imageName: null,
    url: null,
    preset: null,
    folderPath,
    folderImages: sorted,
    folderRecursive: recursive,
    currentIndex: unchanged && currentPath !== undefined ? sorted.findIndex(image => image.path === currentPath) : -1,
    usedPaths: unchanged ? settings.usedPaths.filter(path => keptPaths.has(path)) : [],
  }
  if (base.currentIndex >= 0) return base
  return advanceFolder(base)
}
