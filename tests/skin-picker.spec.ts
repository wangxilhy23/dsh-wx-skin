/**
 * dsh-wx-skin — directory-picker bridge tests.
 *
 * The bridge spans two carriers, and what it must guarantee for each one:
 *
 * - **Web** — the harness `uiWorkspace` service is provided only after the
 *   client↔host connection is up, i.e. after this plugin's `apply`. The service
 *   must be read LIVE (never snapshotted), an absent service reported instead of
 *   throwing, and a real picker failure still surfaced to the panel.
 * - **Desktop** — the official application's renderer preload installs
 *   `globalThis.__DSH_DIRECTORY_PICKER__` before any page script runs. It is the
 *   dialog the harness's own native directory flow drives, so it must win over
 *   the Host service whenever it is installed, and its absence must leave the
 *   Web path untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPickerBridge, desktopDirectoryPicker, type DirectoryPickerLike,
} from '../src/client/skin-picker.ts'

/** Install the Desktop carrier's global exactly as the Electron preload does. */
function installDesktopPicker(pick: () => Promise<string | null>): void {
  vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('desktopDirectoryPicker', () => {
  it('reports nothing in a browser deployment', () => {
    expect(desktopDirectoryPicker()).toBeUndefined()
  })

  it('rejects lookalike globals that carry no usable pick()', () => {
    for (const value of [null, 'bridge', 42, {}, { pick: 'not-a-function' }]) {
      vi.stubGlobal('__DSH_DIRECTORY_PICKER__', value)
      expect(desktopDirectoryPicker(), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('reads the preload bridge and calls pick on the bridge itself', async () => {
    const bridge = { picks: 0, async pick(): Promise<string | null> { this.picks += 1; return 'D:\\pics' } }
    vi.stubGlobal('__DSH_DIRECTORY_PICKER__', bridge)
    await expect(desktopDirectoryPicker()?.pick()).resolves.toBe('D:\\pics')
    expect(bridge.picks).toBe(1)
  })
})

describe('createPickerBridge', () => {
  it('reports unavailable and open() resolves null while no carrier can pick', async () => {
    const bridge = createPickerBridge(() => undefined, () => undefined)
    expect(bridge.available()).toBe(false)
    await expect(bridge.open()).resolves.toBeNull()
  })

  it('reports unavailable when the service object has no pickDirectory', async () => {
    const bridge = createPickerBridge(() => ({}) as DirectoryPickerLike, () => undefined)
    expect(bridge.available()).toBe(false)
    await expect(bridge.open()).resolves.toBeNull()
  })

  it('forwards open() to the live service and returns its path', async () => {
    const pickDirectory = vi.fn(async () => 'D:\\pics')
    const bridge = createPickerBridge(() => ({ pickDirectory }), () => undefined)
    expect(bridge.available()).toBe(true)
    await expect(bridge.open()).resolves.toBe('D:\\pics')
    expect(pickDirectory).toHaveBeenCalledTimes(1)
  })

  it('passes a cancelled picker through as null', async () => {
    const bridge = createPickerBridge(() => ({ pickDirectory: async () => null }), () => undefined)
    await expect(bridge.open()).resolves.toBeNull()
  })

  it('reads the holder live instead of snapshotting it', () => {
    let service: DirectoryPickerLike | undefined
    const bridge = createPickerBridge(() => service, () => undefined)
    expect(bridge.available()).toBe(false)
    service = { pickDirectory: async () => 'D:\\pics' }
    // The service arriving later must flip availability with no re-creation.
    expect(bridge.available()).toBe(true)
    service = undefined
    expect(bridge.available()).toBe(false)
  })

  it('lets a real picker failure reject (the panel reports it)', async () => {
    const bridge = createPickerBridge(
      () => ({ pickDirectory: async () => { throw new Error('rpc down') } }),
      () => undefined,
    )
    await expect(bridge.open()).rejects.toThrow('rpc down')
  })

  it('prefers the Desktop carrier installed in the page globals', async () => {
    const pickDirectory = vi.fn(async () => 'D:\\web-pics')
    installDesktopPicker(async () => 'D:\\desktop-pics')
    const bridge = createPickerBridge(() => ({ pickDirectory }))
    // Available from the first render: the preload global needs no service to arrive.
    expect(bridge.available()).toBe(true)
    await expect(bridge.open()).resolves.toBe('D:\\desktop-pics')
    // One click opens ONE dialog — the Host chooser must not also run.
    expect(pickDirectory).not.toHaveBeenCalled()
  })

  it('is available on the Desktop carrier even with no uiWorkspace service', async () => {
    installDesktopPicker(async () => null)
    const bridge = createPickerBridge(() => undefined)
    expect(bridge.available()).toBe(true)
    await expect(bridge.open()).resolves.toBeNull() // user cancelled, not "no picker"
  })

  it('lets a Desktop picker failure reject (the panel reports it)', async () => {
    installDesktopPicker(async () => { throw new Error('ipc rejected the renderer') })
    const bridge = createPickerBridge(() => undefined)
    await expect(bridge.open()).rejects.toThrow('ipc rejected the renderer')
  })

  it('falls back to the Web service once the Desktop global is gone', async () => {
    installDesktopPicker(async () => 'D:\\desktop-pics')
    const service = { pickDirectory: async () => 'D:\\web-pics' }
    const bridge = createPickerBridge(() => service)
    expect(bridge.available()).toBe(true)
    vi.unstubAllGlobals()
    await expect(bridge.open()).resolves.toBe('D:\\web-pics')
  })
})
