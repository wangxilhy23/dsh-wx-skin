/**
 * dsh-wx-skin — the bridge to the harness's native directory picker.
 *
 * The picker lives behind the `uiWorkspace` client service, which this plugin
 * consumes as a SCOPED OPTIONAL dependency (`ctx.inject(['uiWorkspace'], …)`):
 * the service is provided only after the client↔host connection and the remote
 * namespaces are up, which is always later than a dependency-free plugin's
 * `apply`. A value snapshotted at mount time would therefore always be
 * undefined — the bug this module exists to prevent.
 *
 * The bridge reads the live service through `current()` on every call, so the
 * panel can render "not ready yet" and become clickable the moment the service
 * arrives, without re-mounting anything.
 * @module dsh-wx-skin/client/skin-picker
 */

/** The slice of the harness `uiWorkspace` service this plugin uses. */
export interface DirectoryPickerLike {
  pickDirectory?: () => Promise<string | null>
}

/** What the panel talks to, independent of when the service shows up. */
export interface PickerBridge {
  /** Whether the native picker is usable right now. */
  available(): boolean
  /**
   * Open the native picker.
   * @returns the picked absolute directory, or null when the service is
   * unavailable or the user cancelled; rejects when the picker itself fails.
   */
  open(): Promise<string | null>
}

/**
 * Build a bridge over a live service lookup.
 * @param current - reads the current `uiWorkspace` (undefined while absent).
 * @returns the availability check and the open action.
 */
export function createPickerBridge(current: () => DirectoryPickerLike | undefined): PickerBridge {
  return {
    available: () => typeof current()?.pickDirectory === 'function',
    async open(): Promise<string | null> {
      const service = current()
      if (typeof service?.pickDirectory !== 'function') return null
      return await service.pickDirectory()
    },
  }
}
