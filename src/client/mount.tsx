/**
 * dsh-wx-skin — DOM mounting: inject the global stylesheet and background
 * layer, place the sidebar entries (「皮肤」 and 「下一张」, self-healing across
 * shell re-renders), and toggle an anchored popover with the settings panel.
 * All mount failures are logged, never thrown (the shell fails boot when a
 * plugin apply throws). Persists settings with a short debounce so slider drags
 * do not hammer localStorage with the image data URL.
 *
 * Settings are owned here: the panel is controlled by `latest`, and every
 * mutation — panel control, preset, or a slideshow switch from either entry —
 * goes through one `commitSettings` so the panel, the entries, the document,
 * and the persisted copies can never disagree.
 * @module dsh-wx-skin/client/mount
 */
import { createRoot, type Root } from 'react-dom/client'
import type { SkinSettings } from '../core/types.ts'
import { SkinPanel } from './SkinPanel.tsx'
import { advanceFolder, canGoPrevious, folderSignature, folderStatus, imageUrl, previousFolder, refreshFolderState } from './skin-folder.ts'
import type { PickerBridge } from './skin-picker.ts'
import { ENTRY_ATTR, currentImageLabel, isDefaultSettings, loadSettings, saveSettings } from './skin-store.ts'
import { hostListFolder, hostLoad, hostSave } from './skin-host.ts'
import { SkinApplier, ensureGlobalCss, ensureLayer, teardownSkinDom } from './skin-dom.ts'
import css from './skin.module.css'

const PANEL_ATTR = 'data-wx-skin-panel'
const PANEL_WIDTH = 300
/** How often a loaded folder is re-scanned in the background (ms). */
const FOLDER_RESCAN_MS = 60_000

const SKIN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 2v2.2M8 11.8V14M2 8h2.2M11.8 8H14M4 4l1.6 1.6M10.4 10.4 12 12M12 4l-1.6 1.6M5.6 10.4 4 12"/></svg>'
const NEXT_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9"/><path d="M8.5 4.5 12 8l-3.5 3.5"/></svg>'
const PREV_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H4"/><path d="M7.5 4.5 4 8l3.5 3.5"/></svg>'

/** Mount options supplied by the browser half entry. */
export interface MountOptions {
  /**
   * Live bridge to the harness directory picker. The service behind it appears
   * only after the client↔host connection is up, so `available()` is asked on
   * every render instead of being snapshotted here.
   */
  picker?: PickerBridge
  /**
   * Subscribe to picker availability changes; returns an unsubscriber. Lets the
   * open panel light its 「选择文件夹」 button up without reopening.
   */
  onPickerChange?: (listener: () => void) => (() => void) | void
}

/** Locate the sidebar shell root, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button (nested in the logo row on current shells). */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/**
 * Keep the entry in the sidebar, re-placing it across shell re-renders.
 * @param entry - the injected button.
 * @param previous - entry to sit after when it is still mounted (keeps the
 * injected entries in a stable order under the New Session button).
 * @returns disposer removing the entry and its observers.
 */
function mountEntrySelfHealing(
  entry: HTMLButtonElement,
  previous?: () => HTMLButtonElement | undefined,
): () => void {
  let root: HTMLElement | undefined
  let placed = false
  let rootObserver: MutationObserver | undefined

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    const preferred = previous?.()
    const anchor = preferred !== undefined && root.contains(preferred) ? preferred : newSessionButton(root)
    if (anchor === undefined) return
    if (entry.parentElement !== root) root.insertBefore(entry, anchor.nextElementSibling)
    placed = true
    if (rootObserver === undefined) {
      rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) tryPlace()
      })
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver?.disconnect()
    entry.remove()
  }
}

/** Build one sidebar entry button. */
function createEntry(label: string, icon: string, role: string): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ENTRY_ATTR, '')
  entry.dataset.wxSkinEntryRole = role
  entry.className = css.entry
  entry.setAttribute('aria-label', label)
  entry.innerHTML = `<span class="${css.entryIcon}">${icon}</span><span class="${css.entryLabel}">${label}</span>`
  return entry
}

/**
 * Mount the skin feature into the web shell.
 * @param options - host capabilities handed in by the browser half entry.
 * @returns disposer tearing down the entries, popover, layer, and stylesheet.
 */
export function mountSkin(options: MountOptions = {}): () => void {
  const disposers: Array<() => void> = []
  ensureGlobalCss()
  ensureLayer()

  const applier = new SkinApplier()
  let latest = loadSettings()
  applier.apply(latest)

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

  // Sidebar entries: 「皮肤」 opens the panel; 「下一张」 advances the slideshow.
  const entry = createEntry('皮肤', SKIN_ICON, 'skin')
  const prevEntry = createEntry('上一张', PREV_ICON, 'prev')
  const nextEntry = createEntry('下一张', NEXT_ICON, 'next')
  const setEntryActive = (active: boolean): void => {
    if (active) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const setNextEntryState = (settings: SkinSettings): void => {
    const status = folderStatus(settings)
    const name = currentImageLabel(settings)
    const here = name === null ? '' : ` · 当前 ${name.label}`
    if (status.total === 0) {
      nextEntry.dataset.empty = 'true'
      nextEntry.setAttribute('aria-disabled', 'true')
      nextEntry.title = '先加载图片文件夹'
    } else {
      delete nextEntry.dataset.empty
      nextEntry.removeAttribute('aria-disabled')
      nextEntry.title = `${settings.orderMode === 'random' ? '随机' : '顺序'}下一张 · 第 ${status.position}/${status.total} 张${here}`
    }
    if (canGoPrevious(settings)) {
      delete prevEntry.dataset.empty
      prevEntry.removeAttribute('aria-disabled')
      prevEntry.title = `上一张${here}`
    } else {
      prevEntry.dataset.empty = 'true'
      prevEntry.setAttribute('aria-disabled', 'true')
      prevEntry.title = status.total === 0 ? '先加载图片文件夹' : '随机模式还没有可返回的上一张'
    }
  }
  setEntryActive(latest.enabled)
  setNextEntryState(latest)
  disposers.push(mountEntrySelfHealing(nextEntry, () => prevEntry))
  disposers.push(mountEntrySelfHealing(prevEntry, () => entry))
  disposers.push(mountEntrySelfHealing(entry))

  // Server-side durability: the desktop app changes origin — and therefore its
  // localStorage bucket — on every launch, so the durable copy lives in the
  // DSH home via the host half. Seen at the end of the mount below: adopt the
  // host copy when present, else seed it from localStorage on the first run
  // after upgrade. Never throws into the GUI; any host failure keeps the
  // localStorage path.

  // Popover host + React root.
  const panelHost = document.createElement('div')
  panelHost.setAttribute(PANEL_ATTR, '')
  panelHost.style.cssText = `position: fixed; z-index: 1000; width: ${PANEL_WIDTH}px;`
  let root: Root | undefined

  const positionPopover = (): void => {
    const rect = entry.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.right + 10, window.innerWidth - PANEL_WIDTH - 8))
    const top = Math.max(8, rect.top)
    panelHost.style.left = `${left}px`
    panelHost.style.top = `${top}px`
  }

  /** Render (or re-render) the controlled panel against the current settings. */
  const renderPanel = (): void => {
    root?.render(<SkinPanel
      settings={latest}
      commit={commitSettings}
      onClose={closePanel}
      picker={options.picker}
      onNext={nextImage}
      onPrevious={previousImage}
    />)
  }

  // The harness picker service arrives later than this mount; re-render the
  // open panel so its button becomes clickable without reopening.
  const offPicker = options.onPickerChange?.(() => { renderPanel() })

  const closePanel = (): void => {
    if (root === undefined) return
    flushSave()
    root.unmount()
    root = undefined
    panelHost.remove()
  }

  const openPanel = (): void => {
    if (root !== undefined) return
    positionPopover()
    document.body.appendChild(panelHost)
    root = createRoot(panelHost)
    renderPanel()
    // Opening the panel is a user gesture: sync the folder list then.
    void rescanFolder()
  }

  /** Every settings change goes through here. */
  const commitSettings = (next: SkinSettings): void => {
    latest = next
    applier.apply(next)
    setEntryActive(next.enabled)
    setNextEntryState(next)
    scheduleSave()
    renderPanel()
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
   * to switch to, and a click must never open anything (no panel, no dialog):
   * the sidebar entry is rendered as unavailable instead.
   */
  const nextImage = (): void => {
    if (latest.folderImages.length === 0) return
    const advanced = advanceFolder(latest)
    commitSettings(advanced)
    preloadNext(advanced)
  }

  /**
   * Go back one image (the recorded previous one, or the previous in folder
   * order under sequential mode). Same rule as 下一张: nothing loaded, nothing
   * happens — and a click never opens a panel.
   */
  const previousImage = (): void => {
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
  const rescanFolder = async (): Promise<void> => {
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

  const togglePanel = (): void => { if (root !== undefined) closePanel(); else openPanel() }
  entry.addEventListener('click', togglePanel)
  prevEntry.addEventListener('click', previousImage)
  nextEntry.addEventListener('click', nextImage)

  // Adopt the durable host copy once the mount is wired (a later arrival is
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

  // Close on outside click, Escape, or window resize.
  const onDocMouseDown = (event: MouseEvent): void => {
    if (root === undefined) return
    const target = event.target as Node | null
    if (target !== null && (panelHost.contains(target) || entry.contains(target))) return
    closePanel()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && root !== undefined) closePanel()
  }
  const onResize = (): void => { if (root !== undefined) closePanel() }
  const onBeforeUnload = (): void => flushSave()
  document.addEventListener('mousedown', onDocMouseDown)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', onBeforeUnload)

  // Folder rescan triggers: the page regaining focus is the "I just added files
  // in Explorer" case; the interval covers a side-by-side window; the panel
  // opening refreshes on demand.
  const onVisibilityChange = (): void => { if (document.visibilityState === 'visible') void rescanFolder() }
  const onFocus = (): void => { void rescanFolder() }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onFocus)
  const rescanTimer = window.setInterval(() => { void rescanFolder() }, FOLDER_RESCAN_MS)

  disposers.push(() => {
    document.removeEventListener('mousedown', onDocMouseDown)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('beforeunload', onBeforeUnload)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('focus', onFocus)
    window.clearInterval(rescanTimer)
  })

  return () => {
    closePanel()
    offPicker?.()
    for (const dispose of disposers.splice(0)) dispose()
    teardownSkinDom()
  }
}
