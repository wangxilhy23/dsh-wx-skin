/**
 * dsh-wx-skin — DOM mounting: inject the global stylesheet and background
 * layer, place the sidebar 「皮肤」 entry (self-healing across shell
 * re-renders), and toggle an anchored popover with the settings panel. All
 * mount failures are logged, never thrown (the shell fails boot when a plugin
 * apply throws). Persists settings with a short debounce so slider drags do
 * not hammer localStorage with the image data URL.
 * @module dsh-wx-skin/client/mount
 */
import { createRoot, type Root } from 'react-dom/client'
import type { SkinSettings } from '../core/types.ts'
import { SkinPanel } from './SkinPanel.tsx'
import { ENTRY_ATTR, loadSettings, saveSettings } from './skin-store.ts'
import { SkinApplier, ensureGlobalCss, ensureLayer } from './skin-dom.ts'
import css from './skin.module.css'

const PANEL_ATTR = 'data-wx-skin-panel'
const PANEL_WIDTH = 300

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 2v2.2M8 11.8V14M2 8h2.2M11.8 8H14M4 4l1.6 1.6M10.4 10.4 12 12M12 4l-1.6 1.6M5.6 10.4 4 12"/></svg>'

/** Locate the sidebar shell root, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
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

/** Keep the entry in the sidebar, re-placing it across shell re-renders. */
function mountEntrySelfHealing(entry: HTMLButtonElement): () => void {
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
    const anchor = newSessionButton(root)
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

/**
 * Mount the skin feature into the web shell.
 * @returns disposer tearing down the entry, popover, layer, and stylesheet.
 */
export function mountSkin(): () => void {
  const disposers: Array<() => void> = []
  ensureGlobalCss()
  ensureLayer()

  const applier = new SkinApplier()
  let latest = loadSettings()
  applier.apply(latest)

  // Debounced persistence (slider drags must not rewrite the image data URL
  // on every tick).
  let saveTimer: number | undefined
  const flushSave = (): void => {
    if (saveTimer === undefined) return
    window.clearTimeout(saveTimer)
    saveTimer = undefined
    saveSettings(latest)
  }
  const scheduleSave = (): void => {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { saveSettings(latest) }, 200)
  }

  // Sidebar entry.
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ENTRY_ATTR, '')
  entry.className = css.entry
  entry.setAttribute('aria-label', '皮肤')
  entry.innerHTML = `<span class="${css.entryIcon}">${ICON}</span><span class="${css.entryLabel}">皮肤</span>`
  const setEntryActive = (active: boolean): void => {
    if (active) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  setEntryActive(latest.enabled)
  disposers.push(mountEntrySelfHealing(entry))

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
    root.render(<SkinPanel
      initial={latest}
      onClose={closePanel}
      commit={(next) => {
        latest = next
        applier.apply(next)
        setEntryActive(next.enabled)
        scheduleSave()
      }}
    />)
  }

  const togglePanel = (): void => { if (root !== undefined) closePanel(); else openPanel() }
  entry.addEventListener('click', togglePanel)

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
  disposers.push(() => {
    document.removeEventListener('mousedown', onDocMouseDown)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('beforeunload', onBeforeUnload)
  })

  return () => {
    closePanel()
    for (const dispose of disposers.splice(0)) dispose()
    document.querySelector<HTMLElement>(`div[data-wx-skin-layer]`)?.remove()
    document.querySelector<HTMLElement>(`style[data-plugin-css="dsh-wx-skin/global"]`)?.remove()
    applier.apply({ ...latest, enabled: false })
  }
}
