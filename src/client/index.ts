/**
 * dsh-wx-skin — browser half entry. Mounts the skin feature (sidebar entries +
 * settings popover + background layer) as a fiber effect, so the harness can
 * tear it down again: client-hmr unloads the old fiber before re-applying a
 * rebuilt bundle (and any row disable does the same), and only a registered
 * disposer removes the entries, the popover, the layer, and the stylesheet.
 * All mount failures are logged, never thrown.
 *
 * The only host capability the skin borrows is the harness's native directory
 * picker (`uiWorkspace.pickDirectory`). It is a SCOPED OPTIONAL dependency, not
 * an `inject` on this plugin: the service appears only after the client↔host
 * connection is up (always later than this `apply`), so it is watched with
 * `ctx.inject(['uiWorkspace'], …)` and read lazily through a bridge. A value
 * snapshotted here would always be undefined — which is exactly why the panel
 * never showed a 「选择文件夹」 button.
 * @module dsh-wx-skin/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { mountSkin, type MountOptions } from './mount.tsx'
import { createPickerBridge, type DirectoryPickerLike } from './skin-picker.ts'
import { teardownSkinDom } from './skin-dom.ts'

/** No hard service dependencies — the skin only touches the DOM. */
export const inject: string[] = []

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

    const options: MountOptions = {
      picker: createPickerBridge(() => service),
      onPickerChange: (listener) => {
        refresh = listener
        return () => {
          if (refresh === listener) refresh = undefined
        }
      },
    }

    try {
      return mountSkin(options)
    } catch (error) {
      // A failing external plugin must never take the GUI down.
      ctx.logger.error('[dsh-wx-skin] mount failed')
      ctx.logger.error(error)
      // A half-mounted skin leaves no layer, stylesheet, or entry behind.
      teardownSkinDom()
      return () => {}
    }
  }, 'dsh-wx-skin: skin mount')
}
