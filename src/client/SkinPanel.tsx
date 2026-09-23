/**
 * dsh-wx-skin — the skin's settings page: enable toggle, background preview, the
 * folder row, the local-file row, the slideshow controls (顺序 / 随机, 上一张 /
 * 下一张), dim / blur / surface sliders, and reset.
 *
 * The page describes the background by PATH, which is also what the slideshow
 * walks:
 *
 * - 文件夹 is the folder being shown; loading one scans it and shows an image.
 * - 本地文件 is the image on screen — its absolute path for a folder image, the
 *   URL for a URL background, or the picked file name when the browser dialog
 *   gave no directory. Pasting an absolute path there loads THAT file: the
 *   folder becomes the file's own folder and the slideshow walks it, so 下一张
 *   from image 10 shows 11 and 上一张 shows 9 (sequential mode steps through the
 *   folder order).
 *
 * The component is CONTROLLED: it renders the `settings` the controller owns and
 * reports every change through `commit`. Only transient UI state (drafts, busy
 * flags, messages) lives in local state.
 * @module dsh-wx-skin/client/skin-panel
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { SkinFitMode, SkinFolderImage, SkinOrderMode, SkinSettings } from '../core/types.ts'
import { ImagePipelineError, fileToDataUrl } from './image-pipeline.ts'
import { canGoPrevious, focusFolderImage, folderStatus, loadFolderState, matchFolderImageByName } from './skin-folder.ts'
import { hostListFolder } from './skin-host.ts'
import { isAbsolutePath, isRemoteImageUrl, parentDirectory, pathBasename, samePath } from './skin-path.ts'
import type { PickerBridge } from './skin-picker.ts'
import { DEFAULT_SETTINGS, DEFAULT_SURFACE, MAX_SURFACE, MIN_SURFACE, currentImageLabel } from './skin-store.ts'
import css from './skin.module.css'

export interface SkinPanelProps {
  /** Settings currently applied (owned by the controller). */
  settings: SkinSettings
  /** Persist + apply a settings change (the controller wires storage, DOM, host sync). */
  commit: (next: SkinSettings) => void
  /**
   * Bridge to the harness native directory picker. Always present; the service
   * behind it may not be ready yet, which the button renders as unavailable.
   */
  picker?: PickerBridge
  /** Advance the slideshow by one image (the controller owns the algorithm + preload). */
  onNext: () => void
  /** Go back one image (the controller owns the algorithm + preload). */
  onPrevious: () => void
}

/** How the page offers the background fit modes, in menu order. */
const FIT_OPTIONS: ReadonlyArray<{ value: SkinFitMode, label: string, hint: string }> = [
  { value: 'fill', label: '填充', hint: '铺满窗口，超出的部分裁掉。' },
  { value: 'fit', label: '适应', hint: '完整显示整张图，按比例缩放并留白。' },
  { value: 'stretch', label: '拉伸', hint: '拉满窗口，比例可能变形。' },
  { value: 'tile', label: '平铺', hint: '按图片原始尺寸重复铺满。' },
  { value: 'center', label: '居中', hint: '按原始尺寸居中，四周留白。' },
]

/** The one-line explanation shown under the 适合度 row. */
function fitHint(fit: SkinFitMode): string {
  return FIT_OPTIONS.find(option => option.value === fit)?.hint ?? ''
}

/** Describe the currently active source for the status badge. */
function describe(settings: SkinSettings): string {
  if (!settings.enabled) return '未启用'
  if (settings.source === 'image') return '本地图片'
  if (settings.source === 'url') return '图片（URL）'
  if (settings.source === 'folder') {
    const status = folderStatus(settings)
    return status.total === 0 ? '文件夹（空）' : `文件夹 ${status.position}/${status.total}`
  }
  return '未启用'
}

/**
 * What the 本地文件 row shows for the current settings: the image's absolute
 * path, its URL, or the picked file's name when no directory was available.
 */
function currentPathOf(settings: SkinSettings): string {
  if (settings.source === 'folder') return settings.folderImages[settings.currentIndex]?.path ?? ''
  if (settings.source === 'url') return settings.url ?? ''
  if (settings.source === 'image') return settings.imageName ?? ''
  return ''
}

/** The popover-free skin settings page. */
export function SkinPanel({ settings, commit, picker, onNext, onPrevious }: SkinPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A just-picked local image, processed but not yet applied — the user
   *  clicks 「应用」 to commit it (explicit two-step flow). */
  const [staged, setStaged] = useState<string | null>(null)
  /** File name of `staged`, kept so the page can name the applied image. */
  const [stagedName, setStagedName] = useState<string | null>(null)
  /** Folder path box; follows the loaded folder unless the user is typing. */
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [folderNotice, setFolderNotice] = useState<string | null>(null)
  /** Local-file row draft; null means "mirror the shown image". */
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  const [pathNotice, setPathNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const status = folderStatus(settings)
  /** Name of the image currently on screen (null when nothing is named). */
  const currentLabel = currentImageLabel(settings)
  /** Path / URL of the image on screen; the local-file row mirrors it. */
  const currentPath = currentPathOf(settings)
  const folderValue = folderDraft ?? settings.folderPath ?? ''
  const pathValue = pathDraft ?? currentPath
  /** The shown image is a data URL from the browser dialog: no directory known. */
  const pathIsFileNameOnly = settings.source === 'image' && currentPath !== ''

  // The rows mirror the committed state; a draft the user is typing survives
  // until the shown image / folder changes underneath it.
  useEffect(() => { setPathDraft(null) }, [currentPath])
  useEffect(() => { setFolderDraft(null) }, [settings.folderPath])

  const onPickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setBusy(true)
    setError(null)
    setPathNotice(null)
    try {
      const dataUrl = await fileToDataUrl(file)
      setStaged(dataUrl)
      setStagedName(file.name)
    } catch (err) {
      setStaged(null)
      setStagedName(null)
      setError(err instanceof ImagePipelineError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Commit the staged local image to the skin.
   *
   * The browser's file dialog hands over the file NAME and no directory, so this
   * is where the picked file joins the slideshow when it can: if the loaded
   * folder holds exactly one image with that name, the background becomes that
   * file — the 本地文件 row then shows its full path and 下一张 continues in
   * folder order from it (pick bg129 → 下一张 bg130). Otherwise the encoded image
   * is used, with a hint explaining why no folder was attached.
   */
  const onApplyImage = (): void => {
    if (staged === null) return
    const matched = stagedName === null ? -1 : matchFolderImageByName(settings.folderImages, stagedName)
    if (settings.folderPath !== null && matched >= 0) {
      const image = settings.folderImages[matched] as SkinFolderImage
      commit(focusFolderImage(settings, matched))
      setStaged(null)
      setStagedName(null)
      setPathDraft(null)
      setPathNotice(`已按文件名定位到文件夹里的 ${image.name}（「下一张 / 上一张」从它继续）。`)
      return
    }
    commit({
      ...settings,
      enabled: true,
      source: 'image',
      imageDataUrl: staged,
      imageName: stagedName,
      url: null,
    })
    setStaged(null)
    setStagedName(null)
    setPathDraft(null)
    setPathNotice(stagedName === null
      ? null
      : `已应用本地图片 ${stagedName}（浏览器文件对话框不提供目录，未能关联文件夹；粘贴完整路径可自动关联）。`)
  }

  const onReset = (): void => {
    setStaged(null)
    setStagedName(null)
    setFolderDraft(null)
    setFolderError(null)
    setFolderNotice(null)
    setPathDraft(null)
    setPathNotice(null)
    setError(null)
    commit({ ...DEFAULT_SETTINGS })
  }

  /**
   * Apply a local-file row value: an `http(s)` address becomes a URL background;
   * an absolute path is loaded as the shown image, with its own folder scanned
   * so the slideshow walks that folder from this file.
   */
  const onApplyPath = async (): Promise<void> => {
    const value = pathValue.trim()
    setError(null)
    setPathNotice(null)
    if (value === '') {
      setError('请填写本地图片的绝对路径，或点「选择图片」；也可以填 http(s) 图片地址。')
      return
    }
    if (isRemoteImageUrl(value)) {
      commit({ ...settings, enabled: true, source: 'url', url: value, imageDataUrl: null, imageName: null })
      setStaged(null)
      setStagedName(null)
      setPathDraft(null)
      return
    }
    if (!isAbsolutePath(value)) {
      setError('请填写完整路径（如 D:\\Pictures\\a.png）或 http(s) 图片地址。')
      return
    }
    const folder = parentDirectory(value)
    if (folder === null) {
      setError('无法从该路径得到所在文件夹，请填写完整的图片路径。')
      return
    }
    setFolderBusy(true)
    try {
      const result = await hostListFolder(folder, settings.folderRecursive)
      if (!result.ok) {
        setFolderError(result.error)
        return
      }
      if (!result.images.some(image => samePath(image.path, value))) {
        setError('该文件不在支持的图片类型内（PNG / JPEG / WebP / GIF / BMP），或无法访问。')
        return
      }
      setFolderDraft(null)
      setFolderError(null)
      setPathDraft(null)
      commit(loadFolderState(settings, result.root, settings.folderRecursive, result.images, value))
      setFolderNotice(`已切到该文件所在文件夹（${result.images.length} 张图片）。`)
    } finally {
      setFolderBusy(false)
    }
  }

  /** Scan a folder (or the one currently typed) and start the slideshow. */
  const onLoadFolder = async (explicit?: string): Promise<void> => {
    const target = (explicit ?? folderValue).trim()
    if (target === '') {
      setFolderError('请填写文件夹的绝对路径，或点「选择文件夹」。')
      return
    }
    setFolderBusy(true)
    setFolderError(null)
    setFolderNotice(null)
    try {
      const result = await hostListFolder(target, settings.folderRecursive)
      if (!result.ok) {
        setFolderError(result.error)
        return
      }
      setFolderDraft(null)
      commit(loadFolderState(settings, result.root, settings.folderRecursive, result.images))
      setFolderNotice(result.images.length === 0
        ? '该文件夹里没有找到图片（支持 PNG / JPEG / WebP / GIF / BMP）。'
        : `已加载 ${result.images.length} 张图片${result.truncated ? '（已达上限，只取前 2000 张）' : ''}。`)
    } finally {
      setFolderBusy(false)
    }
  }

  /** Native picker when the harness exposes it; the path box stays as fallback. */
  const onPickFolder = async (): Promise<void> => {
    if (picker === undefined) return
    setFolderError(null)
    if (!picker.available()) {
      setFolderError('宿主目录选择器尚未就绪，请稍后再试，或直接粘贴文件夹路径。')
      return
    }
    try {
      const picked = await picker.open()
      if (picked === null) return // cancelled
      setFolderDraft(picked)
      await onLoadFolder(picked)
    } catch {
      setFolderError('无法打开系统目录选择器，请直接粘贴文件夹路径。')
    }
  }

  const onMode = (mode: SkinOrderMode): void => {
    commit({ ...settings, orderMode: mode })
  }

  // Only the image layer: size/position/repeat/backdrop come from `.preview`,
  // which contains the whole image (the preview is not the wallpaper's crop).
  const previewStyle = settings.enabled
    ? { backgroundImage: 'var(--wx-skin-bg-image, none)' }
    : undefined

  return (
    // The skin's settings page inside the harness Settings panel (registered
    // into `settings.section`): inline content, no popover chrome and no title
    // of its own — the shell's modal header and nav row already name the page.
    <div className={css.panel} data-wx-skin-panel="">
      <label className={css.toggleRow}>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={e => { commit({ ...settings, enabled: e.target.checked }) }}
        />
        <span>启用皮肤</span>
      </label>

      <div className={css.preview} style={previewStyle}>
        {!settings.enabled && <span>未启用</span>}
      </div>
      <div className={css.currentBadge}>当前：{describe(settings)}</div>
      {currentLabel !== null && (
        <div className={css.imageName} data-wx-skin-name="" title={currentLabel.detail}>
          图片：{currentLabel.label}
        </div>
      )}

      <div className={css.section}>文件夹</div>
      <div className={css.urlRow}>
        <input
          className={css.urlInput}
          value={folderValue}
          placeholder="D:\\Pictures\\wallpapers"
          aria-label="图片文件夹路径"
          onChange={e => setFolderDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void onLoadFolder() }}
        />
        <button
          type="button"
          className={css.button}
          disabled={folderBusy}
          onClick={() => void onLoadFolder()}
        >
          {folderBusy ? '读取中…' : settings.folderImages.length === 0 ? '加载' : '重新加载'}
        </button>
      </div>
      <div className={css.folderRow}>
        {/* Always rendered: the harness picker service arrives after this page
            mounts, so hiding the button until then made the option look absent.
            It is disabled (with a hint) until the service is ready. */}
        <button
          type="button"
          className={css.button}
          data-wx-skin-picker=""
          data-ready={picker?.available() === true ? 'true' : 'false'}
          disabled={picker?.available() !== true}
          title={picker?.available() === true ? '选择图片文件夹' : '目录选择器尚未就绪'}
          onClick={() => void onPickFolder()}
        >
          选择文件夹
        </button>
        <label className={css.inlineToggle}>
          <input
            type="checkbox"
            checked={settings.folderRecursive}
            onChange={e => { commit({ ...settings, folderRecursive: e.target.checked }) }}
          />
          <span>包含子文件夹</span>
        </label>
      </div>
      {folderNotice !== null && <div className={css.noticeText}>{folderNotice}</div>}
      {folderError !== null && <div className={css.errorText}>{folderError}</div>}

      <div className={css.section}>本地文件</div>
      <div className={css.urlRow}>
        <input
          className={css.urlInput}
          data-wx-skin-path=""
          value={pathValue}
          placeholder="D:\\Pictures\\a.png 或 https://…/a.jpg"
          aria-label="本地图片路径"
          onChange={e => setPathDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void onApplyPath() }}
        />
        <button
          type="button"
          className={css.button}
          data-wx-skin-path-apply=""
          disabled={folderBusy}
          title="应用该路径：http(s) 地址作为图片 URL；本地绝对路径会切到它所在文件夹并按顺序继续"
          onClick={() => void onApplyPath()}
        >
          应用
        </button>
      </div>
      <div className={css.folderRow}>
        <button
          type="button"
          className={css.buttonPrimary}
          data-wx-skin-local-pick=""
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? '处理中…' : '选择图片'}
        </button>
        <input
          ref={fileRef}
          className={css.fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          onChange={(e) => void onPickFile(e)}
        />
      </div>
      {staged !== null && (
        <div className={css.stagedRow}>
          <div
            className={css.stagedThumb}
            style={{ backgroundImage: `url("${staged}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
          />
          <span className={css.stagedLabel}>已选择 {stagedName ?? '图片'}</span>
          <button type="button" className={css.buttonPrimary} data-wx-skin-apply-image="" onClick={onApplyImage}>应用</button>
        </div>
      )}
      {pathIsFileNameOnly && (
        <div className={css.noticeText}>
          浏览器文件对话框只提供文件名（{pathBasename(currentPath)}），不提供目录；粘贴完整路径后点「应用」即可自动关联所在文件夹并参与轮播。
        </div>
      )}
      {pathNotice !== null && <div className={css.noticeText}>{pathNotice}</div>}
      {error !== null && <div className={css.errorText}>{error}</div>}

      <div className={css.section}>切换</div>
      <div className={css.folderRow}>
        <div className={css.segmented} role="group" aria-label="切换方式">
          <button
            type="button"
            className={settings.orderMode === 'sequential' ? `${css.segBtn} ${css.segBtnActive}` : css.segBtn}
            onClick={() => onMode('sequential')}
          >
            顺序
          </button>
          <button
            type="button"
            className={settings.orderMode === 'random' ? `${css.segBtn} ${css.segBtnActive}` : css.segBtn}
            onClick={() => onMode('random')}
          >
            随机
          </button>
        </div>
        <button
          type="button"
          className={css.button}
          data-wx-skin-prev=""
          disabled={!canGoPrevious(settings)}
          title={canGoPrevious(settings) ? '上一张' : '没有可返回的上一张'}
          onClick={onPrevious}
        >
          上一张
        </button>
        <button
          type="button"
          className={css.buttonPrimary}
          data-wx-skin-next=""
          disabled={status.total === 0}
          onClick={onNext}
        >
          下一张
        </button>
      </div>
      <div className={css.statusLine}>
        {status.total === 0
          ? '尚未加载文件夹'
          : settings.orderMode === 'random'
            ? `第 ${status.position}/${status.total} 张 · 本轮已用 ${status.usedThisPass}/${status.total}`
            : `第 ${status.position}/${status.total} 张`}
        {settings.orderMode === 'random' && settings.usedPaths.length > 0 && status.total > 0 && (
          <button type="button" className={css.linkButton} onClick={() => commit({ ...settings, usedPaths: [] })}>
            重置本轮
          </button>
        )}
      </div>

      <div className={css.section}>适合度</div>
      <div className={css.urlRow}>
        <select
          className={css.select}
          data-wx-skin-fit=""
          aria-label="背景适合度"
          value={settings.fit}
          onChange={e => {
            const next = FIT_OPTIONS.find(option => option.value === e.target.value)
            if (next !== undefined) commit({ ...settings, fit: next.value })
          }}
        >
          {FIT_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className={css.hintText} data-wx-skin-fit-hint="">{fitHint(settings.fit)}</div>

      <div className={css.section}>效果</div>
      <div className={css.sliderRow}>
        <span className={css.sliderLabel}>暗化 {Math.round(settings.dim * 100)}%</span>
        <input
          className={css.slider}
          type="range"
          min={0}
          max={80}
          step={5}
          value={Math.round(settings.dim * 100)}
          onChange={e => { commit({ ...settings, dim: Number(e.target.value) / 100 }) }}
        />
      </div>
      <div className={css.sliderRow}>
        <span className={css.sliderLabel}>模糊 {Math.round(settings.blur)}px</span>
        <input
          className={css.slider}
          type="range"
          min={0}
          max={24}
          step={1}
          value={Math.round(settings.blur)}
          onChange={e => { commit({ ...settings, blur: Number(e.target.value) }) }}
        />
      </div>
      <div className={css.sliderRow}>
        <span className={css.sliderLabel}>透出 {Math.round(settings.surface * 100)}%</span>
        <input
          className={css.slider}
          type="range"
          min={MIN_SURFACE * 100}
          max={MAX_SURFACE * 100}
          step={1}
          value={Math.round(settings.surface * 100)}
          title="表面不透明度越低，背景图片越明显"
          onChange={e => { commit({ ...settings, surface: Number(e.target.value) / 100 }) }}
        />
      </div>

      <div className={css.footer}>
        <button type="button" className={css.button} onClick={onReset}>恢复默认</button>
      </div>
    </div>
  )
}
