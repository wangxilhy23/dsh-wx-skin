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

/** Back-history bound: a long slideshow must not grow the persisted blob forever. */
export const MAX_HISTORY = 64

/** Append the image being left behind, keeping only the most recent entries. */
function pushHistory(history: readonly string[], outgoing: string | undefined): string[] {
  const next = outgoing === undefined ? [...history] : [...history, outgoing]
  return next.slice(-MAX_HISTORY)
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
  if (images.length === 0) return { ...settings, currentIndex: -1, usedPaths: [], history: [] }

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
    // The image being left behind is where 上一张 goes back to.
    history: pushHistory(settings.history, images[settings.currentIndex]?.path),
  }
}

/**
 * Whether 「上一张」 has anywhere to go: a recorded earlier image, or — in
 * sequential mode — an earlier image in folder order to fall back to.
 * @param settings - current settings.
 * @returns true when the previous-image action would move.
 */
export function canGoPrevious(settings: SkinSettings): boolean {
  if (settings.folderImages.length === 0) return false
  if (settings.history.length > 0) return true
  return settings.orderMode === 'sequential'
}

/**
 * Go back one image: the recorded previous image when there is one, else — in
 * sequential mode — the previous image in folder order, wrapping from the first
 * to the last. Random mode without history has no previous image and returns
 * the settings unchanged.
 *
 * Going back never rewrites the pass record: everything in the history was
 * already shown, and the image returned to is marked as shown if it somehow was
 * not (the sequential wrap can reach an image the pass had not touched yet).
 * @param settings - current settings.
 * @returns the previous settings value.
 */
export function previousFolder(settings: SkinSettings): SkinSettings {
  const images = settings.folderImages
  if (!canGoPrevious(settings)) return settings

  const history = [...settings.history]
  const recorded = history.pop()
  const recordedIndex = recorded === undefined ? -1 : images.findIndex(image => image.path === recorded)
  // Nothing shown yet reads as "before the first image", so the wrap lands on the last.
  const from = settings.currentIndex >= 0 ? settings.currentIndex : 0
  const index = recordedIndex >= 0 ? recordedIndex : (from - 1 + images.length) % images.length

  const shown = images[index] as SkinFolderImage
  const used = new Set(settings.usedPaths)
  used.add(shown.path)
  return {
    ...settings,
    enabled: true,
    source: 'folder',
    currentIndex: index,
    usedPaths: images.filter(image => used.has(image.path)).map(image => image.path),
    history,
  }
}

/**
 * Stable signature of a cached list (path + size + mtime), so a rescan can tell
 * "nothing changed" from "files were added, removed, or edited" without writing
 * settings on every poll.
 * @param images - cached images.
 * @returns a comparable string.
 */
export function folderSignature(images: readonly SkinFolderImage[]): string {
  return images.map(image => `${image.path}\u0000${image.size}\u0000${image.mtimeMs}`).join('\n')
}

/**
 * Merge a fresh scan of the SAME folder in without disturbing the slideshow.
 *
 * This is what an automatic rescan uses: the shown image is kept (matched by
 * path, or — when its file disappeared — the slot it occupied), and the pass
 * record and back-history keep only paths that still exist. Images added since
 * the last scan are simply not marked as shown yet, so 「下一张」 reaches them.
 * The active source is deliberately untouched: a rescan while a preset is on
 * screen must not switch the background back to the folder.
 * @param settings - current settings.
 * @param images - the freshly scanned images.
 * @returns settings whose list and records track the folder.
 */
export function refreshFolderState(
  settings: SkinSettings,
  images: readonly SkinFolderImage[],
): SkinSettings {
  const sorted = sortFolderImages(images).slice(0, MAX_CACHED_IMAGES)
  const kept = new Set(sorted.map(image => image.path))
  const currentPath = settings.folderImages[settings.currentIndex]?.path
  const matched = currentPath === undefined ? -1 : sorted.findIndex(image => image.path === currentPath)
  const shownIndex = settings.currentIndex >= 0 && sorted.length > 0
    ? Math.min(settings.currentIndex, sorted.length - 1)
    : -1
  return {
    ...settings,
    folderImages: sorted,
    currentIndex: matched >= 0 ? matched : sorted.length === 0 ? -1 : shownIndex,
    usedPaths: settings.usedPaths.filter(path => kept.has(path)),
    history: settings.history.filter(path => kept.has(path)),
  }
}

/**
 * Fold a scan into the settings when the user loads (or reloads) a folder.
 *
 * The same folder is MERGED, so adding or removing files never resets the
 * slideshow or the pass record — new files join the not-yet-shown queue. A
 * different folder starts a fresh pass. Either way the other background
 * sources are cleared, so localStorage keeps only the (small) path cache.
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
  const activated: SkinSettings = {
    ...settings,
    enabled: true,
    source: 'folder',
    imageDataUrl: null,
    imageName: null,
    url: null,
    preset: null,
    folderPath,
    folderRecursive: recursive,
    folderImages: sorted,
  }
  if (folderPath === settings.folderPath) {
    const merged = refreshFolderState(activated, sorted)
    // An explicit load of a folder that had no images yet still shows one.
    return merged.currentIndex >= 0 || merged.folderImages.length === 0 ? merged : advanceFolder(merged)
  }
  const reset: SkinSettings = { ...activated, currentIndex: -1, usedPaths: [], history: [] }
  return reset.folderImages.length === 0 ? reset : advanceFolder(reset)
}
