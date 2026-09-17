/**
 * dsh-wx-skin — directory-picker bridge tests.
 *
 * The bridge exists because the harness `uiWorkspace` service is provided only
 * after the client↔host connection is up, i.e. after this plugin's `apply`.
 * What it must guarantee: availability and the service are read LIVE (never
 * snapshotted), an absent service is reported instead of throwing, and a real
 * picker failure still surfaces to the panel.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPickerBridge, type DirectoryPickerLike } from '../src/client/skin-picker.ts'

describe('createPickerBridge', () => {
  it('reports unavailable and open() resolves null while the service is missing', async () => {
    const bridge = createPickerBridge(() => undefined)
    expect(bridge.available()).toBe(false)
    await expect(bridge.open()).resolves.toBeNull()
  })

  it('reports unavailable when the service object has no pickDirectory', async () => {
    const bridge = createPickerBridge(() => ({}) as DirectoryPickerLike)
    expect(bridge.available()).toBe(false)
    await expect(bridge.open()).resolves.toBeNull()
  })

  it('forwards open() to the live service and returns its path', async () => {
    const pickDirectory = vi.fn(async () => 'D:\\pics')
    const bridge = createPickerBridge(() => ({ pickDirectory }))
    expect(bridge.available()).toBe(true)
    await expect(bridge.open()).resolves.toBe('D:\\pics')
    expect(pickDirectory).toHaveBeenCalledTimes(1)
  })

  it('passes a cancelled picker through as null', async () => {
    const bridge = createPickerBridge(() => ({ pickDirectory: async () => null }))
    await expect(bridge.open()).resolves.toBeNull()
  })

  it('reads the holder live instead of snapshotting it', () => {
    let service: DirectoryPickerLike | undefined
    const bridge = createPickerBridge(() => service)
    expect(bridge.available()).toBe(false)
    service = { pickDirectory: async () => 'D:\\pics' }
    // The service arriving later must flip availability with no re-creation.
    expect(bridge.available()).toBe(true)
    service = undefined
    expect(bridge.available()).toBe(false)
  })

  it('lets a real picker failure reject (the panel reports it)', async () => {
    const bridge = createPickerBridge(() => ({
      pickDirectory: async () => { throw new Error('rpc down') },
    }))
    await expect(bridge.open()).rejects.toThrow('rpc down')
  })
})
