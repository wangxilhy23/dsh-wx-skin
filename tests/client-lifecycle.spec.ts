// @vitest-environment jsdom
/**
 * dsh-wx-skin — client-half lifecycle tests. The harness owns plugin teardown:
 * client-hmr (and any Loader row disable) unloads the old fiber before
 * re-applying a rebuilt bundle, and only disposers registered on that fiber
 * run. `apply` must therefore register its DOM teardown through `ctx.effect`,
 * or every reload leaves a second sidebar entry and a second body observer.
 * The global stylesheet must also carry `data-plugin`, the attribute the
 * harness uses to attribute and remove plugin-owned <style> tags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { GLOBAL_STYLE_ID, PLUGIN_ID } from '../src/client/skin-dom.ts'
import { ACTIVE_ATTR, ENTRY_ATTR, LAYER_ATTR, SKIN_CSS_VARS, STORAGE_KEY } from '../src/client/skin-store.ts'
import { DEFAULT_SETTINGS } from '../src/client/skin-store.ts'

/** Panel host attribute owned by mount (`data-wx-skin-panel`). */
const PANEL_ATTR = 'data-wx-skin-panel'

interface FakeCtx {
  ctx: Context
  disposers: Array<() => void>
  errors: unknown[]
  /** Scoped `ctx.inject` registrations, started when their service is provided. */
  scopes: Array<{ deps: readonly string[], start: () => void }>
  /** Services handed to `ctx.get` / a started scope. */
  services: Record<string, unknown>
}

/** Persistent observers must never outlive their test file: dispose in afterEach. */
const mounted: Array<() => void> = []

/**
 * Minimal cordis face the client half uses: a fiber effect, a logger, `ctx.get`,
 * and `ctx.inject` (deps + callback, started on demand like a child fiber).
 */
function fakeCtx(): FakeCtx {
  const disposers: Array<() => void> = []
  const errors: unknown[] = []
  const scopes: FakeCtx['scopes'] = []
  const services: Record<string, unknown> = {}
  const ctx = {
    effect: (execute: () => unknown): unknown => {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
    get: (name: string): unknown => services[name],
    inject: (deps: readonly string[], callback: (scope: Context) => unknown): unknown => {
      scopes.push({
        deps,
        start: () => {
          const scope = {
            get: (name: string): unknown => services[name],
            effect: (execute: () => unknown): unknown => {
              const dispose = execute()
              if (typeof dispose === 'function') disposers.push(dispose as () => void)
              return dispose
            },
          }
          const dispose = callback(scope as unknown as Context)
          if (typeof dispose === 'function') disposers.push(dispose as () => void)
        },
      })
      return { dispose: (): void => {} }
    },
    logger: {
      error: (...args: unknown[]): void => { errors.push(args) },
      warn: (): void => {},
      info: (): void => {},
      debug: (): void => {},
    },
  }
  return { ctx: ctx as unknown as Context, disposers, errors, scopes, services }
}

/** Mount the skin the way the fiber does, tracking its disposers for cleanup. */
function applySkin(): FakeCtx {
  const fake = fakeCtx()
  apply(fake.ctx)
  for (const dispose of fake.disposers) mounted.push(dispose)
  return fake
}

/** Emulate the harness providing `uiWorkspace` (and its scoped reaction). */
function providePicker(fake: FakeCtx, service: unknown): void {
  fake.services['uiWorkspace'] = service
  for (const scope of fake.scopes) {
    if (scope.deps.includes('uiWorkspace')) scope.start()
  }
}

/** Dispatch a real click so the entry's listener runs. */
function click(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** Drive the panel's source dropdown the way a user does. */
function selectGroup(group: 'image' | 'folder'): void {
  const select = sourceSelect()
  if (select === null) throw new Error('source dropdown is not open')
  select.value = group
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Dispose every effect registered so far (reverse registration order). */
function disposeAll(): void {
  for (const dispose of mounted.splice(0).reverse()) dispose()
}

/** The sidebar shell the entry anchors into (CSS-module hashed class names). */
function mountSidebarFixture(): void {
  document.body.innerHTML = '<div id="root">'
    + '<div class="x_sidebarCol"><div class="y_logoRow"></div><button class="z_newSession"></button></div>'
    + '</div>'
}

const entries = (): NodeListOf<Element> => document.querySelectorAll(`[${ENTRY_ATTR}]`)
const entryOf = (role: string): Element | null => document.querySelector(`[${ENTRY_ATTR}][data-wx-skin-entry-role="${role}"]`)
const layer = (): Element | null => document.querySelector(`div[${LAYER_ATTR}]`)
const globalStyle = (): Element | null => document.querySelector(`style[data-plugin-css="${GLOBAL_STYLE_ID}"]`)
const pickerButton = (): Element | null => document.querySelector('[data-wx-skin-picker]')
const nameLine = (): Element | null => document.querySelector('[data-wx-skin-name]')
const sourceSelect = (): HTMLSelectElement | null => document.querySelector('[data-wx-skin-source]')
const localPickButton = (): Element | null => document.querySelector('[data-wx-skin-local-pick]')
const folderPathInput = (): Element | null => document.querySelector('[aria-label="图片文件夹路径"]')
const panelText = (): string => document.querySelector(`[${PANEL_ATTR}]`)?.textContent ?? ''

beforeEach(() => {
  // The host copy is irrelevant here; never let a unit test issue a request.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no host in test')))
  // Settings persist across tests in one jsdom document: start from defaults.
  window.localStorage.clear()
  document.documentElement.removeAttribute(ACTIVE_ATTR)
  document.head.innerHTML = ''
  mountSidebarFixture()
})

afterEach(() => {
  disposeAll()
  vi.restoreAllMocks()
})

describe('client half lifecycle', () => {
  it('mounts the entry, layer, and owned stylesheet through ctx.effect', () => {
    const fake = applySkin()

    expect(fake.disposers).toHaveLength(1)
    expect(entries()).toHaveLength(3)
    expect(entryOf('skin')).not.toBeNull()
    expect(entryOf('prev')).not.toBeNull()
    expect(entryOf('next')).not.toBeNull()
    expect(layer()).not.toBeNull()
    expect(globalStyle()).not.toBeNull()
    // The harness removes owned styles on reload by this attribute.
    expect(globalStyle()?.getAttribute('data-plugin')).toBe(PLUGIN_ID)
  })

  it('mounts the sidebar entries in a stable order', () => {
    applySkin()

    const skin = entryOf('skin')
    const prev = entryOf('prev')
    const next = entryOf('next')
    expect(skin).not.toBeNull()
    expect(prev).not.toBeNull()
    expect(next).not.toBeNull()
    const column = document.querySelector('.x_sidebarCol')
    expect([...(column?.children ?? [])].map(child => child.getAttribute('data-wx-skin-entry-role') ?? child.className))
      .toEqual(['y_logoRow', 'z_newSession', 'skin', 'prev', 'next'])
    // No folder is loaded yet, so both switch entries advertise that state.
    expect(next?.getAttribute('data-empty')).toBe('true')
    expect(prev?.getAttribute('data-empty')).toBe('true')
  })

  it('removes every mounted artifact when the fiber is disposed', () => {
    applySkin()
    disposeAll()

    expect(entries()).toHaveLength(0)
    expect(layer()).toBeNull()
    expect(globalStyle()).toBeNull()
    expect(document.documentElement.hasAttribute(ACTIVE_ATTR)).toBe(false)
    for (const name of SKIN_CSS_VARS) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe('')
    }
  })

  it('never leaves two entries behind across a reload (dispose, then re-apply)', () => {
    applySkin()
    disposeAll()
    const second = applySkin()

    expect(second.disposers).toHaveLength(1)
    expect(entries()).toHaveLength(3)
    expect(entryOf('skin')).not.toBeNull()
    expect(entryOf('prev')).not.toBeNull()
    expect(entryOf('next')).not.toBeNull()
    expect(layer()).not.toBeNull()
    expect(globalStyle()).not.toBeNull()
  })

  it('works without the optional harness directory picker', () => {
    const fake = applySkin()

    expect(fake.errors).toEqual([])
    expect(entries()).toHaveLength(3)
  })

  it('swallows a mount failure and leaves no residue', () => {
    const fake = fakeCtx()
    const createElement = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      expect(() => apply(fake.ctx)).not.toThrow()
    } finally {
      createElement.mockRestore()
    }
    for (const dispose of fake.disposers) mounted.push(dispose)

    expect(fake.errors.length).toBeGreaterThan(0)
    expect(fake.disposers).toHaveLength(1)
    expect(entries()).toHaveLength(0)
    expect(layer()).toBeNull()
    expect(globalStyle()).toBeNull()
  })

  it('adopts an untagged stylesheet injected before ownership stamping', () => {
    const legacy = document.createElement('style')
    legacy.dataset.pluginCss = GLOBAL_STYLE_ID
    document.head.appendChild(legacy)
    applySkin()

    const tags = document.querySelectorAll(`style[data-plugin-css="${GLOBAL_STYLE_ID}"]`)
    expect(tags).toHaveLength(1)
    expect(legacy.getAttribute('data-plugin')).toBe(PLUGIN_ID)
  })

  it('watches the harness picker as a scoped optional dependency', () => {
    const fake = applySkin()

    // Not an `inject` on the plugin itself (that would make the skin wait for
    // the client↔host connection); a child scope is the optional form.
    expect(fake.scopes.map(scope => [...scope.deps])).toEqual([['uiWorkspace']])
  })

  it('shows the picker button immediately, disabled until the service arrives', async () => {
    const fake = applySkin()
    click(entryOf('skin'))
    await vi.waitFor(() => { expect(sourceSelect()).not.toBeNull() })
    // The picker lives in the folder family; a user previewing it with no folder
    // loaded must still see the button (it is rendered unconditionally there).
    selectGroup('folder')

    // Regression: the panel used to render no picker button at all, because the
    // service was snapshotted during apply (it is provided later, once the
    // client↔host connection is up).
    await vi.waitFor(() => { expect(pickerButton()).not.toBeNull() })
    expect(pickerButton()?.getAttribute('data-ready')).toBe('false')
    expect(pickerButton()?.hasAttribute('disabled')).toBe(true)

    providePicker(fake, { pickDirectory: async () => null })

    await vi.waitFor(() => { expect(pickerButton()?.getAttribute('data-ready')).toBe('true') })
    expect(pickerButton()?.hasAttribute('disabled')).toBe(false)
  })

  it('does nothing when 下一张 is clicked with no folder loaded', () => {
    applySkin()

    click(entryOf('next'))

    // No panel, no dialog, no background change — the entry stays inert.
    expect(document.querySelector(`[${PANEL_ATTR}]`)).toBeNull()
    expect(layer()).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toBe('')
    expect(entryOf('next')?.getAttribute('data-empty')).toBe('true')
  })

  it('does nothing when 上一张 is clicked with no folder loaded', () => {
    applySkin()

    click(entryOf('prev'))

    expect(document.querySelector(`[${PANEL_ATTR}]`)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toBe('')
    expect(entryOf('prev')?.getAttribute('data-empty')).toBe('true')
    expect(entryOf('prev')?.getAttribute('title')).toBe('先加载图片文件夹')
  })

  it('sets the background back to the previous image', () => {
    // demo1.png is on screen, a.png is the recorded previous image.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [
        { path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 },
        { path: 'D:\\pics\\b.png', name: 'b.png', rel: 'b.png', size: 1, mtimeMs: 3 },
      ],
      currentIndex: 1,
      usedPaths: ['D:\\pics\\a.png', 'D:\\pics\\b.png'],
      history: ['D:\\pics\\a.png'],
    }))
    applySkin()

    click(entryOf('prev'))

    const background = document.documentElement.style.getPropertyValue('--wx-skin-bg-image')
    expect(background).toContain('a.png')
    expect(background).not.toContain('b.png')
    // The entry tooltips follow the new image.
    expect(entryOf('prev')?.getAttribute('title')).toContain('a.png')
    expect(entryOf('next')?.getAttribute('title')).toContain('a.png')
  })

  it('shows the current image name in the panel and in the switch tooltip', async () => {
    // A folder is loaded with demo1.png on screen.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [{ path: 'D:\\pics\\demo1.png', name: 'demo1.png', rel: 'demo1.png', size: 3, mtimeMs: 4 }],
      currentIndex: 0,
      usedPaths: ['D:\\pics\\demo1.png'],
    }))
    applySkin()

    expect(entryOf('next')?.getAttribute('title')).toBe('顺序下一张 · 第 1/1 张 · 当前 demo1.png')
    expect(entryOf('prev')?.getAttribute('title')).toBe('上一张 · 当前 demo1.png')

    click(entryOf('skin'))
    await vi.waitFor(() => { expect(nameLine()).not.toBeNull() })
    expect(nameLine()?.textContent).toContain('demo1.png')
    // The full path rides the hover title, not the visible line.
    expect(nameLine()?.getAttribute('title')).toBe('D:\\pics\\demo1.png')
  })

  it('switches the shown controls with the source dropdown', async () => {
    applySkin()
    click(entryOf('skin'))
    await vi.waitFor(() => { expect(sourceSelect()).not.toBeNull() })

    // Default source is "none" → the image family, with no folder controls.
    expect(sourceSelect()?.value).toBe('image')
    expect(localPickButton()).not.toBeNull()
    expect(folderPathInput()).toBeNull()

    // Choosing 文件夹 reveals the folder path section (renamed from 文件夹轮播).
    selectGroup('folder')

    await vi.waitFor(() => { expect(folderPathInput()).not.toBeNull() })
    expect(localPickButton()).toBeNull()
    expect(panelText()).toContain('文件夹路径')
    expect(panelText()).not.toContain('文件夹轮播')
    // 上一张 is offered but unavailable until a folder with images is loaded.
    expect(document.querySelector('[data-wx-skin-prev]')?.hasAttribute('disabled')).toBe(true)

    // Switching back restores the image controls (including the presets).
    selectGroup('image')
    await vi.waitFor(() => { expect(localPickButton()).not.toBeNull() })
    expect(folderPathInput()).toBeNull()
  })

  it('picks up a file added to the folder when the page regains focus', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [{ path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 }],
      currentIndex: 0,
      usedPaths: ['D:\\pics\\a.png'],
    }))
    // The host now reports a second image (added in Explorer after the load).
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: true,
      root: 'D:\\pics',
      truncated: false,
      images: [
        { path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 },
        { path: 'D:\\pics\\b.png', name: 'b.png', rel: 'b.png', size: 1, mtimeMs: 9 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    applySkin()

    window.dispatchEvent(new Event('focus'))

    // The entry tooltip reflects the merged list (1 of 2 now), and the shown
    // image did not jump: the new file joins the queue instead.
    await vi.waitFor(() => { expect(entryOf('next')?.getAttribute('title')).toContain('第 1/2 张') })
    expect(entryOf('next')?.getAttribute('title')).toContain('a.png')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toContain('a.png')
  })

  it('opens on the family the committed source belongs to', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [{ path: 'D:\\pics\\demo1.png', name: 'demo1.png', rel: 'demo1.png', size: 3, mtimeMs: 4 }],
      currentIndex: 0,
      usedPaths: [],
    }))
    applySkin()
    click(entryOf('skin'))
    await vi.waitFor(() => { expect(sourceSelect()).not.toBeNull() })

    // The dropdown follows the committed source, so a folder background opens
    // on the folder controls rather than on the image ones.
    expect(sourceSelect()?.value).toBe('folder')
    expect(folderPathInput()).not.toBeNull()
    expect(localPickButton()).toBeNull()
  })
})

