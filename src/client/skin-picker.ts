/**
 * dsh-wx-skin — the bridge to whichever carrier can open a folder chooser.
 *
 * Two carriers can, and the plugin prefers the one that owns the dialog:
 *
 * 1. The **official Desktop application** (`apps/desktop` in the DSH checkout)
 *    serves its document from `dsh-app://app` and installs
 *    `globalThis.__DSH_DIRECTORY_PICKER__` from its renderer preload
 *    (`src/preload-app.ts`). That `pick()` opens the Electron folder dialog
 *    bound to the application window, restores and focuses the window first,
 *    and shares one dialog across concurrent requests. It is the very chooser
 *    the harness's own native directory flow drives
 *    (`@deepseek-ai/dsh-client-ui-directory-picker-native`'s client half prefers
 *    the same global over `uiWorkspace.pickDirectory()`), and it is installed
 *    before any page script runs, so nothing has to arrive.
 *
 * 2. **Web** exposes the harness `uiWorkspace` client service, which this plugin
 *    consumes as a SCOPED OPTIONAL dependency (`ctx.inject(['uiWorkspace'], …)`):
 *    the service is provided only after the client↔host connection and the
 *    remote namespaces are up, which is always later than a dependency-free
 *    plugin's `apply`. A value snapshotted at mount time would therefore always
 *    be undefined — the bug this module exists to prevent.
 *
 * Both lookups are LIVE, so the panel can render "not ready yet" and become
 * clickable the moment either carrier can serve a pick, without re-mounting
 * anything.
 * @module dsh-wx-skin/client/skin-picker
 */

/** The slice of the harness `uiWorkspace` service this plugin uses (the Web carrier). */
export interface DirectoryPickerLike {
  pickDirectory?: () => Promise<string | null>
}

/**
 * The renderer-preload picker the Desktop carrier installs under
 * `globalThis.__DSH_DIRECTORY_PICKER__` (an Electron IPC call to its main process).
 */
export interface DesktopDirectoryPicker {
  /**
   * Open the window-bound native folder dialog.
   * @returns the picked absolute directory, or null when the user cancelled.
   */
  pick: () => Promise<string | null>
}

/** What the panel talks to, independent of when (or whether) a carrier shows up. */
export interface PickerBridge {
  /** Whether some carrier's picker is usable right now. */
  available(): boolean
  /**
   * Open the best available picker.
   * @returns the picked absolute directory, or null when no carrier is usable
   * or the user cancelled; rejects when the picker itself fails.
   */
  open(): Promise<string | null>
}

/**
 * Read the Desktop carrier's picker from the page globals.
 *
 * A browser deployment never installs the global, so this doubles as the
 * plugin's carrier test: present ⇒ the Desktop preload owns this document.
 * @returns the picker, or undefined when this document is not the Desktop app.
 */
export function desktopDirectoryPicker(): DesktopDirectoryPicker | undefined {
  const bridge = (globalThis as { __DSH_DIRECTORY_PICKER__?: unknown }).__DSH_DIRECTORY_PICKER__
  if (bridge === null || typeof bridge !== 'object') return undefined
  const pick: unknown = (bridge as { pick?: unknown }).pick
  if (typeof pick !== 'function') return undefined
  // `bind` keeps the preload object as the receiver of its own method.
  const bound = (pick as (this: unknown) => Promise<string | null>).bind(bridge)
  return { pick: () => bound() }
}

/**
 * Build a bridge over a live service lookup and a live Desktop-global lookup.
 * @param current - reads the current `uiWorkspace` (undefined while absent).
 * @param desktop - reads the Desktop carrier's picker (defaults to the page global).
 * @returns the availability check and the open action.
 */
export function createPickerBridge(
  current: () => DirectoryPickerLike | undefined,
  desktop: () => DesktopDirectoryPicker | undefined = desktopDirectoryPicker,
): PickerBridge {
  return {
    available: () => desktop() !== undefined || typeof current()?.pickDirectory === 'function',
    async open(): Promise<string | null> {
      // The Desktop's own window-bound dialog wins whenever it is installed:
      // driving the Host's OS chooser instead would open a second, unbound
      // dialog for the same click (the Desktop Host binds loopback, so its
      // adaptive chooser resolves to the native backend rather than refusing).
      const carrier = desktop()
      if (carrier !== undefined) return await carrier.pick()
      const service = current()
      if (typeof service?.pickDirectory !== 'function') return null
      return await service.pickDirectory()
    },
  }
}
