/**
 * dsh-wx-skin — browser half entry. Builds the skin controller (settings,
 * background layer, body-level popover, slideshow, persistence) and registers
 * the three sidebar entries into the harness's own additive slot
 * (`sidebar.footer.action`), so the shell owns their placement, ordering, the
 * collapsed rail, and teardown. Everything is wired as fiber effects, so the
 * harness can tear it down again: client-hmr unloads the old fiber before
 * re-applying a rebuilt bundle (and any row disable does the same), and only a
 * registered disposer removes the entries, the popover, the layer, and the
 * stylesheet. All mount failures are logged, never thrown.
 *
 * The only host capabilities the skin borrows are SCOPED OPTIONAL dependencies,
 * never `inject` on this plugin:
 *
 * - `uiWorkspace.pickDirectory` (the harness's native directory picker) appears
 *   only after the client↔host connection is up — always later than this
 *   `apply`. A value snapshotted here would always be undefined, which is
 *   exactly why the panel never showed a 「选择文件夹」 button. It is watched with
 *   `ctx.inject(['uiWorkspace'], …)` and read lazily through a bridge.
 * - `slots` (the slot registry) plus ui-sidebar's `sidebar.footer.action`
 *   declaration. Declaring `inject: ['slots']` on the plugin would make the
 *   whole browser half — background layer and persistence included — wait on a
 *   service and, in a deployment without it, trip the client boot audit. The
 *   scoped form keeps the skin working when the sidebar is absent; only the
 *   entries would not appear.
 * @module dsh-wx-skin/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { FOOTER_SLOT, makeSkinFooter } from './entries.tsx'
import { SETTINGS_SECTION, makeSkinSettings } from './skin-settings.tsx'
import { createSkinController, type SkinController, type SkinControllerOptions } from './skin-controller.tsx'
import { createPickerBridge, type DirectoryPickerLike } from './skin-picker.ts'
import { teardownSkinDom } from './skin-dom.ts'

/** No hard service dependencies — the skin only touches the DOM and the slots. */
export const inject: string[] = []

/**
 * Structural face of the harness slot service (`@deepseek-ai/dsh-client-ui-renderer`).
 * Declared locally on purpose: this plugin does not depend on harness client
 * packages, exactly like `DirectoryPickerLike` in skin-picker.ts.
 *
 * `inject(key, …)` waits for a slot DECLARATION (ui-sidebar's / ui-settings', in
 * this case) and runs the callback as a child fiber effect, so a shell reload
 * tears the registrations down and rebuilds them.
 */
interface SlotsLike {
  inject(key: string, callback: () => unknown): () => void
  register(options: { name: string, id: string, order?: number, label?: string }, component: unknown): () => void
}

/** Apply the browser half. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    let service: DirectoryPickerLike | undefined
    let refresh: (() => void) | undefined

    // Scoped optional dependency: the child fiber starts when the harness
    // picker appears, and its disposer runs if the service goes away again.
    ctx.inject(['uiWorkspace'], (scope: Context) => {
      // `get` rather than the typed property: the Context merge for this service
      // belongs to the harness package, which this plugin does not depend on.
      service = scope.get('uiWorkspace') as DirectoryPickerLike | undefined
      refresh?.()
      scope.effect(() => () => {
        service = undefined
        refresh?.()
      }, 'dsh-wx-skin: picker release')
    })

    const options: SkinControllerOptions = {
      picker: createPickerBridge(() => service),
      onPickerChange: (listener) => {
        refresh = listener
        return () => {
          if (refresh === listener) refresh = undefined
        }
      },
    }

    // A failing external plugin must never take the GUI down.
    let controller: SkinController
    try {
      controller = createSkinController(options)
    } catch (error) {
      ctx.logger.error('[dsh-wx-skin] mount failed')
      ctx.logger.error(error)
      // A half-mounted skin leaves no layer, stylesheet, or entry behind.
      teardownSkinDom()
      return () => {}
    }

    // Two official seats, one registration each:
    //  - `settings.section` — the skin's settings PAGE inside the harness
    //    Settings panel (nav row + its own room, padding and scrolling).
    //  - `sidebar.footer.action` — the slideshow quick actions at the sidebar
    //    foot. ONE registration carries the pair: that row is a flex row whose
    //    shipped occupant claims a full line, so sibling registrations would be
    //    squeezed to zero width (see entries.tsx).
    ctx.inject(['slots'], (scope: Context) => {
      const slots = scope.get('slots') as SlotsLike | undefined
      if (slots === undefined) return () => {}
      const stops = [
        slots.inject(SETTINGS_SECTION, () => slots.register(
          { name: SETTINGS_SECTION, id: 'skin', order: 30, label: '皮肤' },
          makeSkinSettings(controller),
        )),
        slots.inject(FOOTER_SLOT, () => slots.register(
          { name: FOOTER_SLOT, id: 'skin-slideshow', order: 10, label: '换图' },
          makeSkinFooter(controller),
        )),
      ]
      return () => {
        for (const stop of stops.splice(0)) stop()
      }
    })

    return () => { controller.dispose() }
  }, 'dsh-wx-skin: skin mount')
}
