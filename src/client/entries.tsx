/**
 * dsh-wx-skin — the sidebar-foot slideshow actions, registered into the
 * harness's own additive slot instead of injecting DOM into the shell's sidebar.
 *
 * DSH declares `sidebar.footer.action` (`kind: 'list'`, `scope: 'root'`,
 * `replaceRisk: 'none'`) as the sanctioned seat for extra sidebar-foot actions:
 * the shell renders one row per registration, in ascending `order`, directly
 * inside its `.footerActions` flex row above Settings, and hands each occupant
 * the live column state as `{ wide }`. Registering there replaces the plugin's
 * old `[class*="sidebarCol"]` / `[class*="logoRow"]` / `button[class*="newSession"]`
 * DOM hunt plus its two MutationObservers.
 *
 * These are pure ACTIONS (换图), not settings: the skin's settings live in the
 * harness Settings panel (`settings.section`, see skin-settings.tsx), which
 * owns its own room, padding and scrolling.
 *
 * TWO SHAPE CONSTRAINTS come from the seat's box model, and both are handled
 * here rather than by guessing at the shell's internals:
 *
 * 1. ONE registration, not two. The row is a flex row and its shipped occupant
 *    (`cordis-panel`, ui-cordis) claims the whole line with
 *    `width: 100%; flex: none`; separate sibling registrations would be laid out
 *    after a line-consuming item and squeezed to zero width.
 * 2. The group asks the ROW to wrap (`flex-wrap: wrap` on its own parent, set and
 *    restored by effect). Without it, a second full-line occupant cannot share
 *    the line at all; with it every occupant keeps its own line.
 * @module dsh-wx-skin/client/entries
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { SkinController, SkinView } from './skin-controller.tsx'
import { canGoPrevious, folderStatus } from './skin-folder.ts'
import { currentImageLabel } from './skin-store.ts'
import css from './skin.module.css'

/** The official additive seat these actions register into. */
export const FOOTER_SLOT = 'sidebar.footer.action'

/** Owner props every `sidebar.footer.action` occupant receives. */
export interface FooterEntryProps {
  /** Whether the sidebar renders wide content (false = 56px rail, icon only). */
  wide?: boolean
}

const NEXT_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9"/><path d="M8.5 4.5 12 8l-3.5 3.5"/></svg>'
const PREV_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H4"/><path d="M7.5 4.5 4 8l3.5 3.5"/></svg>'

/** One action button: icon always, label only in the wide sidebar. */
function EntryButton({
  wide, role, label, title, icon, empty, onClick,
}: {
  wide: boolean
  role: 'prev' | 'next'
  label: string
  title: string
  icon: string
  empty?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-wx-skin-entry=""
      data-wx-skin-entry-role={role}
      data-empty={empty === true ? 'true' : undefined}
      aria-disabled={empty === true ? 'true' : undefined}
      aria-label={label}
      title={title}
      className={wide ? `${css.footerAction} ${css.footerActionWide}` : `${css.footerAction} ${css.footerActionRail}`}
      onClick={onClick}
    >
      <span className={css.entryIcon} dangerouslySetInnerHTML={{ __html: icon }} />
      {wide ? <span className={css.entryLabel}>{label}</span> : null}
    </button>
  )
}

/**
 * Build the sidebar-foot group: 「上一张」「下一张」 on the wide sidebar, the same
 * two icons on the collapsed rail. Both are inert while no folder is loaded.
 * @param controller - the skin controller the actions drive.
 * @returns the component to register into {@link FOOTER_SLOT}.
 */
export function makeSkinFooter(controller: SkinController): (props: FooterEntryProps) => JSX.Element {
  const subscribe = (listener: () => void): (() => void) => controller.subscribe(listener)
  const getSnapshot = (): SkinView => controller.view()

  return function SkinFooter({ wide = true }: FooterEntryProps): JSX.Element {
    const { settings } = useSyncExternalStore(subscribe, getSnapshot)
    const group = useRef<HTMLDivElement>(null)
    const status = folderStatus(settings)
    const name = currentImageLabel(settings)
    const here = name === null ? '' : ` · 当前 ${name.label}`

    // Let the shell's footer row wrap: its shipped occupant claims a full line
    // with `flex: none`, so without wrapping a second occupant would be clipped.
    // Only the element this group was placed in is touched, and it is restored
    // on unmount (client-hmr reload, row disable).
    useEffect(() => {
      const parent = group.current?.parentElement
      if (parent === null || parent === undefined) return
      const previous = parent.style.flexWrap
      parent.style.flexWrap = 'wrap'
      return () => { parent.style.flexWrap = previous }
    }, [])

    const previousEnabled = canGoPrevious(settings)
    const previousTitle = previousEnabled
      ? `上一张${here}`
      : status.total === 0
        ? '先加载图片文件夹'
        : settings.orderMode === 'random' ? '随机模式还没有可返回的上一张' : '文件夹里只有这一张图片'
    const nextEmpty = status.total === 0
    const nextTitle = nextEmpty
      ? '先加载图片文件夹'
      : `${settings.orderMode === 'random' ? '随机' : '顺序'}下一张 · 第 ${status.position}/${status.total} 张${here}`

    return (
      <div
        ref={group}
        className={`${css.footerGroup} ${wide ? css.footerGroupWide : css.footerGroupRail}`}
        data-wx-skin-footer=""
      >
        <EntryButton
          wide={wide}
          role="prev"
          label="上一张"
          title={previousTitle}
          icon={PREV_ICON}
          empty={!previousEnabled}
          onClick={() => { controller.previous() }}
        />
        <EntryButton
          wide={wide}
          role="next"
          label="下一张"
          title={nextTitle}
          icon={NEXT_ICON}
          empty={nextEmpty}
          onClick={() => { controller.next() }}
        />
      </div>
    )
  }
}
