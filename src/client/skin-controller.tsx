/**
 * dsh-wx-skin — skin controller: the single owner of the skin's state and side
 * effects. It holds the current settings, applies them to the document, drives
 * the slideshow, rescans the folder, persists to localStorage + the host half,
 * and owns the document listeners.
 *
 * The UI is NOT built here. Both halves are React components registered into
 * harness slots — the settings page into `settings.section` (skin-settings.tsx)
 * and the slideshow quick actions into `sidebar.footer.action` (entries.tsx) —
 * and this controller is the value they render: they subscribe to
 * `subscribe`/`view` (a snapshot object recreated only when something changes)
 * and call back into `commit` / `next` / `previous`.
 * @module dsh-wx-skin/client/skin-controller
 */
import type { SkinSettings } from '../core/types.ts'
import {
  advanceFolder, canGoPrevious, folderSignature, imageUrl, previousFolder, refreshFolderState,
} from './skin-folder.ts'
import type { PickerBridge } from './skin-picker.ts'
import { isDefaultSettings, loadSettings, saveSettings } from './skin-store.ts'
import { hostListFolder, hostLoad, hostSave } from './skin-host.ts'
import { SkinApplier, ensureGlobalCss, ensureLayer, teardownSkinDom } from './skin-dom.ts'

/** How often a loaded folder is re-scanned in the background (ms). */
const FOLDER_RESCAN_MS = 60_000

/** Host capabilities handed in by the browser half entry. */
export interface SkinControllerOptions {
  /**
   * Live bridge to the harness directory picker. The service behind it appears
   * only after the client↔host connection is up, so `available()` is asked on
   * every render instead of being snapshotted here.
   */
  picker?: PickerBridge
  /**
   * Subscribe to picker availability changes; returns an unsubscriber. Lets the
   * settings page light its 「选择文件夹」 button up without a remount.
   */
  onPickerChange?: (listener: () => void) => (() => void) | void
}

/** Immutable view the slot components render. */
export interface SkinView {
  /** Settings currently applied. */
  settings: SkinSettings
  /** Whether the harness directory picker is usable right now. */
  pickerReady: boolean
}

/** The skin's reactive surface, consumed by the settings page and the footer actions. */
export interface SkinController {
  /** Live directory-picker bridge (identity is stable; readiness comes from `view`). */
  readonly picker: PickerBridge | undefined
  /** Subscribe to view changes; returns an unsubscriber. */
  subscribe(listener: () => void): () => void
  /** Current view (stable reference until something changes). */
  view(): SkinView
  /** Apply + persist a settings change (the single commit path for every UI). */
  commit(next: SkinSettings): void
  /** Advance the slideshow by one image (no-op with no folder loaded). */
  next(): void
  /** Go back one image (no-op when there is nothing to go back to). */
  previous(): void
  /** Persist pending writes and remove everything this controller mounted. */
  dispose(): void
}

/**
 * Create the skin controller and mount its persistent pieces (stylesheet,
 * background layer, document listeners, host settings adoption).
 * @param options - host capabilities handed in by the browser half entry.
 * @returns the controller; call `dispose` to remove every artifact.
 */
export function createSkinController(options: SkinControllerOptions = {}): SkinController {
  const disposers: Array<() => void> = []
  ensureGlobalCss()
  ensureLayer()

  const applier = new SkinApplier()
  let latest = loadSettings()
  applier.apply(latest)

  const listeners = new Set<() => void>()
  let snapshot: SkinView = { settings: latest, pickerReady: options.picker?.available() === true }

  /** Publish the current view; a change-free call notifies nobody. */
  const notify = (): void => {
    const pickerReady = options.picker?.available() === true
    if (snapshot.settings === latest && snapshot.pickerReady === pickerReady) return
    snapshot = { settings: latest, pickerReady }
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        // A broken subscriber must not take the skin (or the shell) down.
        console.warn('[dsh-wx-skin] view subscriber failed:', error)
      }
    }
  }

  // Debounced persistence (slider drags must not rewrite the image data URL
  // on every tick). Writes both the localStorage cache/fallback and the
  // durable host copy (deduped so an unchanged settings blob is not re-POSTed).
  let lastSentHost: string | undefined
  const syncHost = (): void => {
    const serialized = JSON.stringify(latest)
    if (lastSentHost === serialized) return
    lastSentHost = serialized
    void hostSave(latest)
  }
  const persist = (): void => {
    saveSettings(latest)
    syncHost()
  }
  let saveTimer: number | undefined
  const flushSave = (): void => {
    if (saveTimer === undefined) return
    window.clearTimeout(saveTimer)
    saveTimer = undefined
    persist()
  }
  const scheduleSave = (): void => {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { persist() }, 200)
  }

  /** Every settings change from any UI goes through here. */
  function commitSettings(next: SkinSettings): void {
    latest = next
    applier.apply(next)
    scheduleSave()
    notify()
  }

  /**
   * Warm the browser cache for the image the next click will show (sequential
   * mode is deterministic; random mode draws fresh, so it is not preloaded).
   */
  const preloadNext = (current: SkinSettings): void => {
    if (current.orderMode !== 'sequential' || current.folderImages.length < 2) return
    const projected = advanceFolder(current)
    const candidate = projected.folderImages[projected.currentIndex]
    const shown = current.folderImages[current.currentIndex]
    if (candidate === undefined || shown?.path === candidate.path) return
    const image = new Image()
    image.src = imageUrl(candidate)
  }

  /**
   * Advance the slideshow by one image. With no folder loaded there is nothing
   * to switch to: the footer action renders as unavailable instead.
   */
  function next(): void {
    if (latest.folderImages.length === 0) return
    const advanced = advanceFolder(latest)
    commitSettings(advanced)
    preloadNext(advanced)
  }

  /**
   * Go back one image (the recorded previous one, or the previous in folder
   * order under sequential mode). Same rule as 下一张: nothing loaded, nothing
   * happens.
   */
  function previous(): void {
    if (!canGoPrevious(latest)) return
    const back = previousFolder(latest)
    commitSettings(back)
    preloadNext(back)
  }

  /**
   * Re-scan the loaded folder so images added outside the app join the queue.
   *
   * The merge never switches the background or resets the pass (see
   * refreshFolderState), and the settings are only written when the list really
   * changed — a poll that finds nothing new costs one loopback readdir.
   */
  let rescanning = false
  async function rescanFolder(): Promise<void> {
    const folderPath = latest.folderPath
    if (rescanning || folderPath === null) return
    rescanning = true
    try {
      const result = await hostListFolder(folderPath, latest.folderRecursive)
      if (!result.ok) return // unrelated failure (e.g. host restarted): keep the cache
      if (folderSignature(result.images) === folderSignature(latest.folderImages)) return
      commitSettings(refreshFolderState(latest, result.images))
    } finally {
      rescanning = false
    }
  }

  // The harness picker service arrives later than this controller; re-publish
  // the view so the settings page's picker button flips to ready in place.
  const offPicker = options.onPickerChange?.(() => { notify() })

  // Adopt the durable host copy once the controller is wired (a later arrival is
  // applied through the same single commit path as any UI change), then sync the
  // folder list so files added while the app was closed show up immediately.
  void (async () => {
    try {
      const host = await hostLoad()
      if (host !== null) {
        commitSettings(host)
      } else {
        const local = loadSettings()
        if (!isDefaultSettings(local)) void hostSave(local)
      }
    } catch {
      // Swallow — the skin must never take the shell down.
    }
    void rescanFolder()
  })()

  // Persist pending writes when the page goes away.
  const onBeforeUnload = (): void => flushSave()
  window.addEventListener('beforeunload', onBeforeUnload)

  // Folder rescan triggers: the page regaining focus is the "I just added files
  // in Explorer" case; the interval covers a side-by-side window; the settings
  // page opening refreshes on demand through the same path.
  const onVisibilityChange = (): void => { if (document.visibilityState === 'visible') void rescanFolder() }
  const onFocus = (): void => { void rescanFolder() }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onFocus)
  const rescanTimer = window.setInterval(() => { void rescanFolder() }, FOLDER_RESCAN_MS)

  disposers.push(() => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('focus', onFocus)
    window.clearInterval(rescanTimer)
  })

  return {
    picker: options.picker,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    view(): SkinView {
      return snapshot
    },
    commit: commitSettings,
    next,
    previous,
    dispose(): void {
      flushSave()
      offPicker?.()
      listeners.clear()
      for (const dispose of disposers.splice(0)) dispose()
      teardownSkinDom()
    },
  }
}
