/**
 * dsh-wx-skin — browser half entry. Mounts the skin feature (sidebar entry +
 * settings popover + background layer). All failures are logged, never thrown.
 * @module dsh-wx-skin/client
 */
import { mountSkin } from './mount.tsx'

/** No hard service dependencies — the skin only touches the DOM. */
export const inject: string[] = []

/** Apply the browser half. */
export function apply(): void {
  try {
    mountSkin()
  } catch (error) {
    // A failing external plugin must never take the GUI down.
    console.error('[dsh-wx-skin] mount failed:', error)
  }
}
