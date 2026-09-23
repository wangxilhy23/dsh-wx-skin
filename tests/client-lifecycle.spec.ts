// @vitest-environment jsdom
/**
 * dsh-wx-skin — client-half lifecycle tests. The harness owns plugin teardown:
 * client-hmr (and any Loader row disable) unloads the old fiber before
 * re-applying a rebuilt bundle, and only disposers registered on that fiber
 * run. `apply` must therefore register its DOM teardown through `ctx.effect`,
 * or every reload leaves a second background layer and a second body observer.
 * The global stylesheet must also carry `data-plugin`, the attribute the
 * harness uses to attribute and remove plugin-owned <style> tags.
 *
 * The UI is React registered into two harness slots — the settings page
 * (`settings.section`) and the sidebar-foot slideshow actions
 * (`sidebar.footer.action`) — so this suite drives a fake slot registry: it runs
 * each `slots.inject` callback, renders every registration into that slot's fake
 * container (one React root per registration, exactly one owner), and unmounts it
 * when the registration is disposed. Nothing here asserts shell DOM internals any
 * more — that coupling is gone by design.
 */
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { FOOTER_SLOT } from '../src/client/entries.tsx'
import { SETTINGS_SECTION } from '../src/client/skin-settings.tsx'
import { GLOBAL_STYLE_ID, PLUGIN_ID } from '../src/client/skin-dom.ts'
import { ACTIVE_ATTR, DEFAULT_SETTINGS, ENTRY_ATTR, LAYER_ATTR, SKIN_CSS_VARS, STORAGE_KEY } from '../src/client/skin-store.ts'

// The image pipeline needs a real canvas; these tests exercise the dialog flow,
// so encoding is stubbed (its own suite covers the pipeline).
vi.mock('../src/client/image-pipeline.ts', () => ({
  ImagePipelineError: class ImagePipelineError extends Error {},
  fileToDataUrl: async (file: File): Promise<string> => `data:image/png;base64,${file.name}`,
}))

/** Marker attribute on the settings page root (`data-wx-skin-panel`). */
const PANEL_ATTR = 'data-wx-skin-panel'

/** Owner props one registration's component receives, by slot. */
type OccupantProps = Record<string, unknown>

/** One registration the fake slot registry holds. */
interface FakeRegistration {
  id: string
  slot: string
  order: number
  label: string | undefined
  component: FunctionComponent<OccupantProps>
  cell: HTMLElement
  root: Root
  disposed: boolean
}

/** The fake `slots` service plus the containers it renders into. */
interface FakeSlots {
  service: {
    inject(key: string, callback: () => unknown): () => void
    register(options: { name: string, id: string, order?: number, label?: string }, component: unknown): () => void
  }
  /** Live registrations by id, in registration order. */
  registrations: Map<string, FakeRegistration>
  /** Registration ids in the order the fake footer renders them. */
  footerOrder(): string[]
  /** Re-render every occupant with the sidebar's new wide/rail state. */
  setWide(wide: boolean): void
}

/** Slot declarations this plugin is expected to use. */
const DECLARED_SLOTS = new Set([FOOTER_SLOT, SETTINGS_SECTION])

/**
 * A fake slot registry: `inject` runs its callback straight away (the slot is
 * declared in this harness) and returns the registrations' combined disposer;
 * `register` owns one React root per occupant so teardown is observable.
 * @param containers - the fake shell containers, keyed by slot name.
 * @param state - live owner props handed to every occupant.
 * @returns the fake service and its bookkeeping.
 */
function createSlotsService(containers: Map<string, HTMLElement>, state: { wide: boolean }): FakeSlots {
  const registrations = new Map<string, FakeRegistration>()

  const propsFor = (slot: string): OccupantProps =>
    slot === FOOTER_SLOT ? { wide: state.wide } : { close: (): void => {} }

  const renderCell = (entry: FakeRegistration): void => {
    entry.root.render(createElement(entry.component, propsFor(entry.slot)))
  }
  /** One slot's registrations, refined by the list slot's ascending `order`. */
  const resort = (slot: string): void => {
    const container = containers.get(slot) as HTMLElement
    const ordered = [...registrations.values()].filter(entry => entry.slot === slot)
      .sort((left, right) => left.order - right.order)
    for (const entry of ordered) container.appendChild(entry.cell)
  }

  return {
    service: {
      inject(key: string, callback: () => unknown): () => void {
        if (!DECLARED_SLOTS.has(key)) throw new Error(`unexpected slot injected: ${key}`)
        const stop = callback()
        return () => {
          if (typeof stop === 'function') (stop as () => void)()
        }
      },
      register(options: { name: string, id: string, order?: number, label?: string }, component: unknown): () => void {
        const container = containers.get(options.name)
        if (container === undefined) throw new Error(`registering into an undeclared slot: ${options.name}`)
        const cell = document.createElement('div')
        cell.setAttribute('data-slot-cell', options.id)
        container.appendChild(cell)
        const entry: FakeRegistration = {
          id: options.id,
          slot: options.name,
          order: options.order ?? 0,
          label: options.label,
          component: component as FunctionComponent<OccupantProps>,
          cell,
          root: createRoot(cell),
          disposed: false,
        }
        registrations.set(options.id, entry)
        renderCell(entry)
        resort(entry.slot)
        return () => {
          if (entry.disposed) return
          entry.disposed = true
          entry.root.unmount()
          cell.remove()
          registrations.delete(options.id)
        }
      },
    },
    registrations,
    footerOrder: () => [...((containers.get(FOOTER_SLOT) as HTMLElement).querySelectorAll('[data-slot-cell]'))]
      .map(cell => cell.getAttribute('data-slot-cell') ?? ''),
    setWide(wide: boolean): void {
      state.wide = wide
      for (const entry of registrations.values()) renderCell(entry)
    },
  }
}

interface FakeCtx {
  ctx: Context
  disposers: Array<() => void>
  errors: unknown[]
  /** Scoped `ctx.inject` registrations, started when their service is provided. */
  scopes: Array<{ deps: readonly string[], start: () => void }>
  /** Services handed to `ctx.get` / a started scope. */
  services: Record<string, unknown>
  /** The fake shell footer the slot registrations render into. */
  slots: FakeSlots
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

  // The shell's containers: the Settings options column and the sidebar foot.
  const containers = new Map<string, HTMLElement>()
  const settings = document.createElement('div')
  settings.className = 'shell_optionsColumn'
  document.body.appendChild(settings)
  containers.set(SETTINGS_SECTION, settings)
  const footer = document.createElement('div')
  footer.className = 'shell_footerActions'
  document.body.appendChild(footer)
  containers.set(FOOTER_SLOT, footer)
  const slots = createSlotsService(containers, { wide: true })
  services.slots = slots.service

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
  return { ctx: ctx as unknown as Context, disposers, errors, scopes, services, slots }
}

/** Start every scoped reaction waiting on `dep`, the way the harness provides it. */
function provide(fake: FakeCtx, dep: string, service?: unknown): void {
  if (service !== undefined) fake.services[dep] = service
  for (const scope of fake.scopes) {
    if (scope.deps.includes(dep)) scope.start()
  }
}

/** Mount the skin the way the fiber does, tracking its disposers for cleanup. */
function applySkin(): FakeCtx {
  const fake = fakeCtx()
  apply(fake.ctx)
  // The slot declaration arrives from the shell; rendering it is React work.
  act(() => { provide(fake, 'slots') })
  for (const dispose of fake.disposers) mounted.push(dispose)
  return fake
}

/** Emulate the harness providing `uiWorkspace` (and its scoped reaction). */
function providePicker(fake: FakeCtx, service: unknown): void {
  act(() => { provide(fake, 'uiWorkspace', service) })
}

/** Dispatch a real click so React's listener runs, and flush its updates. */
function click(element: Element | null): void {
  act(() => {
    rawClick(element)
  })
}

/** Dispatch a click with no act wrapper, for handlers that await the host. */
function rawClick(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** Type into a React-controlled input the way a user does. */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (input === null) throw new Error('input is not rendered')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Dispose every effect registered so far (reverse registration order). */
function disposeAll(): void {
  act(() => {
    for (const dispose of mounted.splice(0).reverse()) dispose()
  })
}

const entries = (): NodeListOf<Element> => document.querySelectorAll(`[${ENTRY_ATTR}]`)
const entryOf = (role: string): Element | null => document.querySelector(`[${ENTRY_ATTR}][data-wx-skin-entry-role="${role}"]`)
const layer = (): Element | null => document.querySelector(`div[${LAYER_ATTR}]`)
const globalStyle = (): Element | null => document.querySelector(`style[data-plugin-css="${GLOBAL_STYLE_ID}"]`)
const pickerButton = (): Element | null => document.querySelector('[data-wx-skin-picker]')
const nameLine = (): Element | null => document.querySelector('[data-wx-skin-name]')
const pathInput = (): HTMLInputElement | null => document.querySelector('[data-wx-skin-path]')
const pathApply = (): Element | null => document.querySelector('[data-wx-skin-path-apply]')
const localPickButton = (): Element | null => document.querySelector('[data-wx-skin-local-pick]')
const folderPathInput = (): HTMLInputElement | null => document.querySelector('[aria-label="图片文件夹路径"]')
const panelText = (): string => document.querySelector(`[${PANEL_ATTR}]`)?.textContent ?? ''

beforeEach(() => {
  // React 18 needs this flag to let act() flush without warning.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The host copy is irrelevant here; never let a unit test issue a request.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no host in test')))
  // Settings persist across tests in one jsdom document: start from defaults.
  window.localStorage.clear()
  document.documentElement.removeAttribute(ACTIVE_ATTR)
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  disposeAll()
  vi.restoreAllMocks()
})

describe('client half lifecycle', () => {
  it('mounts the settings page, footer actions, layer, and owned stylesheet', () => {
    const fake = applySkin()

    expect(fake.disposers.length).toBeGreaterThan(0)
    // The footer carries the two slideshow actions …
    expect(entries()).toHaveLength(2)
    expect(entryOf('prev')).not.toBeNull()
    expect(entryOf('next')).not.toBeNull()
    // … and the settings page is mounted in the shell's options column.
    expect(document.querySelector(`[${PANEL_ATTR}]`)).not.toBeNull()
    expect(layer()).not.toBeNull()
    expect(globalStyle()).not.toBeNull()
    // The harness removes owned styles on reload by this attribute.
    expect(globalStyle()?.getAttribute('data-plugin')).toBe(PLUGIN_ID)
  })

  it('registers one ordered settings section and one footer action group', () => {
    const fake = applySkin()

    const registrations = [...fake.slots.registrations.values()]
      .map(entry => [entry.slot, entry.id, entry.order, entry.label])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    expect(registrations).toEqual([
      [SETTINGS_SECTION, 'skin', 30, '皮肤'],
      [FOOTER_SLOT, 'skin-slideshow', 10, '换图'],
    ])

    // ONE footer registration: the seat's row is a flex row whose shipped
    // occupant claims a full line, so sibling registrations would be squeezed
    // to nothing.
    expect(fake.slots.footerOrder()).toEqual(['skin-slideshow'])
    // No folder is loaded yet, so both switch actions advertise that state.
    expect(entryOf('next')?.getAttribute('data-empty')).toBe('true')
    expect(entryOf('prev')?.getAttribute('data-empty')).toBe('true')
  })

  it('asks the shell footer row to wrap, and restores it on dispose', () => {
    applySkin()

    // The shell renders list occupants unwrapped, so the group's parent is the
    // row the shell's footer placed it in (in this harness: the slot cell).
    const group = entryOf('next')?.parentElement as HTMLElement
    const row = group.parentElement as HTMLElement
    expect(row).not.toBeNull()
    expect(row.style.flexWrap).toBe('wrap')

    disposeAll()
    // The row is the shell's, so the negotiation is reversible.
    expect(row.style.flexWrap).toBe('')
  })

  it('renders the footer actions label-free on the collapsed rail', () => {
    const fake = applySkin()

    act(() => { fake.slots.setWide(false) })

    // The rail is 56px wide: two 28px icons, no labels.
    expect(entries()).toHaveLength(2)
    for (const role of ['prev', 'next']) {
      const button = entryOf(role)
      expect(button?.getAttribute('class')).toContain('footerActionRail')
      expect(button?.textContent).toBe('')
      expect(button?.querySelector('svg')).not.toBeNull()
    }

    act(() => { fake.slots.setWide(true) })
    expect(entryOf('next')?.textContent).toBe('下一张')
  })

  it('removes every mounted artifact when the fiber is disposed', () => {
    applySkin()
    disposeAll()

    expect(entries()).toHaveLength(0)
    expect(document.querySelector(`[${PANEL_ATTR}]`)).toBeNull()
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

    expect(second.disposers.length).toBeGreaterThan(0)
    expect(entries()).toHaveLength(2)
    expect(entryOf('prev')).not.toBeNull()
    expect(entryOf('next')).not.toBeNull()
    expect(document.querySelectorAll(`[${PANEL_ATTR}]`)).toHaveLength(1)
    expect(layer()).not.toBeNull()
    expect(globalStyle()).not.toBeNull()
  })

  it('works without the optional harness directory picker', () => {
    const fake = applySkin()

    expect(fake.errors).toEqual([])
    expect(entries()).toHaveLength(2)
    expect(document.querySelector(`[${PANEL_ATTR}]`)).not.toBeNull()
  })

  it('swallows a mount failure and leaves no residue', () => {
    const fake = fakeCtx()
    const createElement_ = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      expect(() => apply(fake.ctx)).not.toThrow()
    } finally {
      createElement_.mockRestore()
    }
    for (const dispose of fake.disposers) mounted.push(dispose)

    expect(fake.errors.length).toBeGreaterThan(0)
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

  it('watches the picker and the slot registry as scoped optional dependencies', () => {
    const fake = applySkin()

    // Not `inject` on the plugin itself: `slots` would then gate the whole
    // browser half (background layer included) and trip the boot audit in a
    // deployment without it, and `uiWorkspace` only exists after the
    // client↔host connection. Child scopes are the optional form.
    expect(fake.scopes.map(scope => [...scope.deps])).toEqual([['uiWorkspace'], ['slots']])
  })

  it('shows the picker button immediately, disabled until the service arrives', async () => {
    const fake = applySkin()

    // The settings page is mounted with the section, so its folder row is
    // reachable without opening anything.
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

    // No background change, no dialog — the action stays inert.
    expect(layer()).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toBe('')
    expect(entryOf('next')?.getAttribute('data-empty')).toBe('true')
  })

  it('does nothing when 上一张 is clicked with no folder loaded', () => {
    applySkin()

    click(entryOf('prev'))

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

  it('shows the current image name on the settings page and in the switch tooltip', () => {
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
    // Sequential 上一张 needs a neighbour: a one-image folder has none.
    expect(entryOf('prev')?.getAttribute('title')).toBe('文件夹里只有这一张图片')

    expect(nameLine()).not.toBeNull()
    expect(nameLine()?.textContent).toContain('demo1.png')
    // The full path rides the hover title, not the visible line.
    expect(nameLine()?.getAttribute('title')).toBe('D:\\pics\\demo1.png')
  })

  it('shows the folder and local-file rows together, with the shown path', () => {
    // A folder is loaded with demo1.png on screen.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [
        { path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 },
        { path: 'D:\\pics\\demo1.png', name: 'demo1.png', rel: 'demo1.png', size: 3, mtimeMs: 4 },
      ],
      currentIndex: 1,
      usedPaths: [],
    }))
    applySkin()

    // Both rows are always visible — there is no 背景来源 dropdown any more.
    expect(panelText()).not.toContain('背景来源')
    expect(folderPathInput()?.value).toBe('D:\\pics')
    // The local-file row shows the SHOWN image's full path, not the folder.
    expect(pathInput()?.value).toBe('D:\\pics\\demo1.png')
    // A folder image needs no "the browser hid the directory" hint.
    expect(panelText()).not.toContain('只提供文件名')
    expect(entryOf('next')?.getAttribute('title')).toBe('顺序下一张 · 第 2/2 张 · 当前 demo1.png')
  })

  it('applying a local file path switches to its folder and walks from that file', async () => {
    // Twelve images, so "pick img10 → 下一张 11 / 上一张 9" is observable.
    const images = Array.from({ length: 12 }, (_, index) => {
      const name = `img${index + 1}.png`
      return { path: `D:\\pics\\${name}`, name, rel: name, size: 1, mtimeMs: index + 1 }
    })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: true,
      root: 'D:\\pics',
      truncated: false,
      images,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    applySkin()

    await act(async () => {
      typeInto(pathInput(), 'D:\\pics\\img10.png')
      rawClick(pathApply())
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    // The folder row follows the named file's folder …
    expect(folderPathInput()?.value).toBe('D:\\pics')
    expect(pathInput()?.value).toBe('D:\\pics\\img10.png')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toContain('img10.png')
    expect(entryOf('next')?.getAttribute('title')).toContain('第 10/12 张')

    // … and sequential walking continues from it: 11 forwards, 9 backwards.
    click(entryOf('next'))
    expect(entryOf('next')?.getAttribute('title')).toContain('第 11/12 张')
    expect(pathInput()?.value).toBe('D:\\pics\\img11.png')
    click(entryOf('prev'))
    expect(entryOf('next')?.getAttribute('title')).toContain('第 10/12 张')
    expect(pathInput()?.value).toBe('D:\\pics\\img10.png')
  })

  it('applying an http(s) address takes the local-file row back to a URL background', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [{ path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 }],
      currentIndex: 0,
    }))
    applySkin()

    await act(async () => {
      typeInto(pathInput(), 'https://example.test/walls/deep.jpg')
      rawClick(pathApply())
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    expect(pathInput()?.value).toBe('https://example.test/walls/deep.jpg')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image'))
      .toBe('url("https://example.test/walls/deep.jpg")')
    // The folder row keeps the cached folder, so 下一张 can walk back into it.
    expect(folderPathInput()?.value).toBe('D:\\pics')
    expect(entryOf('next')?.getAttribute('title')).toContain('第 1/1 张')
  })

  it('explains that a browser-picked file carries no directory', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'image',
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      imageName: 'wallpaper.jpg',
    }))
    applySkin()

    expect(pathInput()?.value).toBe('wallpaper.jpg')
    expect(panelText()).toContain('只提供文件名')
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

    // The rescan is async (loopback readdir → commit → subscribers); keep the
    // whole chain inside act so the entries' re-render is the user-visible one.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    // The entry tooltip reflects the merged list (1 of 2 now), and the shown
    // image did not jump: the new file joins the queue instead.
    expect(entryOf('next')?.getAttribute('title')).toContain('第 1/2 张')
    expect(entryOf('next')?.getAttribute('title')).toContain('a.png')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toContain('a.png')
  })

  it('lets a dialog-picked file join the slideshow by name (bg129 → 下一张 bg130)', async () => {
    const names = ['bg127.png', 'bg128.png', 'bg129.png', 'bg130.png']
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\bg-image\\bg',
      folderImages: names.map((name, index) => ({
        path: `D:\\bg-image\\bg\\${name}`, name, rel: name, size: 1, mtimeMs: index + 1,
      })),
      currentIndex: 0,
    }))
    applySkin()

    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'bg129.png', { type: 'image/png' })],
      configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    // The staged pick is applied explicitly.
    click(document.querySelector('[data-wx-skin-apply-image]'))

    // The dialog gave no directory, but the name placed the folder cursor: the
    // row shows the full path and the background is that file.
    expect(pathInput()?.value).toBe('D:\\bg-image\\bg\\bg129.png')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image')).toContain('bg129.png')
    expect(entryOf('next')?.getAttribute('title')).toContain('第 3/4 张')

    click(entryOf('next'))
    expect(pathInput()?.value).toBe('D:\\bg-image\\bg\\bg130.png')
    click(entryOf('prev'))
    expect(pathInput()?.value).toBe('D:\\bg-image\\bg\\bg129.png')
  })

  it('keeps the encoded image when the picked name is not in the folder', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\bg-image\\bg',
      folderImages: [{ path: 'D:\\bg-image\\bg\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 1 }],
      currentIndex: 0,
    }))
    applySkin()

    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'elsewhere.png', { type: 'image/png' })],
      configurable: true,
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    click(document.querySelector('[data-wx-skin-apply-image]'))

    expect(pathInput()?.value).toBe('elsewhere.png')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-image'))
      .toBe('url("data:image/png;base64,elsewhere.png")')
    expect(panelText()).toContain('不提供目录')
  })

  it('offers the wallpaper fit modes and applies the chosen one', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [{ path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 }],
      currentIndex: 0,
    }))
    applySkin()

    const select = document.querySelector('[data-wx-skin-fit]') as HTMLSelectElement
    expect([...select.options].map(option => option.textContent)).toEqual(['填充', '适应', '拉伸', '平铺', '居中'])
    expect(select.value).toBe('fill')
    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-size')).toBe('cover')

    act(() => {
      select.value = 'fit'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(document.documentElement.style.getPropertyValue('--wx-skin-bg-size')).toBe('contain')
    expect(document.querySelector('[data-wx-skin-fit-hint]')?.textContent).toContain('完整显示')
  })

  it('keeps the local-file row in step with the shown image after a rescan', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      enabled: true,
      source: 'folder',
      folderPath: 'D:\\pics',
      folderImages: [{ path: 'D:\\pics\\a.png', name: 'a.png', rel: 'a.png', size: 1, mtimeMs: 2 }],
      currentIndex: 0,
      usedPaths: [],
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

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    // The shown image did not jump — the new file waits its turn — so the
    // local-file row still names a.png.
    expect(entryOf('next')?.getAttribute('title')).toContain('第 1/2 张')
    expect(pathInput()?.value).toBe('D:\\pics\\a.png')
  })
})
