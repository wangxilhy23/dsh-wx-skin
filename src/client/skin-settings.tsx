/**
 * dsh-wx-skin — the skin's settings page, registered into the harness Settings
 * panel through the official additive seat `settings.section`.
 *
 * The shell owns the modal: its nav rail lists one row per registration
 * (ascending `order`, label resolved per render) and its options column renders
 * the selected page with its own padding and scrolling. That is exactly the room
 * a full skin editor needs — the plugin's own body-level popover used to hang
 * past the window edge when it was anchored to the sidebar foot, which is why
 * the settings moved here.
 *
 * The component is thin: it renders the controller's view snapshot into the
 * panel component (SkinPanel), which owns the controls. `close` (the one owner
 * prop a section receives) is unused — the modal's own close button and Escape
 * already leave settings, and no flow here needs to leave them for the user.
 * @module dsh-wx-skin/client/skin-settings
 */
import { useSyncExternalStore } from 'react'
import { SkinPanel } from './SkinPanel.tsx'
import type { SkinController, SkinView } from './skin-controller.tsx'

/** The official additive seat for one Settings page. */
export const SETTINGS_SECTION = 'settings.section'

/** Owner props every `settings.section` occupant receives. */
export interface SettingsSectionProps {
  /** Close the settings panel (the shell owns the open state). */
  close?: () => void
}

/**
 * Build the settings page component.
 * @param controller - the skin controller the page edits.
 * @returns the component to register into {@link SETTINGS_SECTION}.
 */
export function makeSkinSettings(controller: SkinController): (props: SettingsSectionProps) => JSX.Element {
  const subscribe = (listener: () => void): (() => void) => controller.subscribe(listener)
  const getSnapshot = (): SkinView => controller.view()

  return function SkinSettings(): JSX.Element {
    const { settings } = useSyncExternalStore(subscribe, getSnapshot)
    return (
      <SkinPanel
        settings={settings}
        commit={controller.commit}
        picker={controller.picker}
        onNext={controller.next}
        onPrevious={controller.previous}
      />
    )
  }
}
