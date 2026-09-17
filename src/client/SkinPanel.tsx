/**
 * dsh-wx-skin — the popover panel: enable toggle, background preview, local
 * image picker (file input → downscale → data URL), URL input, folder
 * slideshow (host folder scan + sequential/random next), presets, dim / blur
 * sliders, and reset.
 *
 * The component is CONTROLLED: it renders the `settings` mount owns and reports
 * every change through `commit`, so a switch driven from the sidebar entry and
 * a switch driven from here always render the same state. Only transient UI
 * state (inputs, busy flags, messages) lives in local state.
 * @module dsh-wx-skin/client/skin-panel
 */
import { useRef, useState, type ChangeEvent } from 'react'
import type { SkinOrderMode, SkinSettings } from '../core/types.ts'
import { ImagePipelineError, fileToDataUrl } from './image-pipeline.ts'
import { folderStatus, loadFolderState } from './skin-folder.ts'
import { hostListFolder } from './skin-host.ts'
import type { PickerBridge } from './skin-picker.ts'
import { DEFAULT_SETTINGS, DEFAULT_SURFACE, MAX_SURFACE, MIN_SURFACE, PRESETS, currentImageLabel } from './skin-store.ts'
import css from './skin.module.css'

export interface SkinPanelProps {
  /** Settings currently applied (owned by mount). */
  settings: SkinSettings
  /** Persist + apply a settings change (mount wires storage, DOM, host sync). */
  commit: (next: SkinSettings) => void
  /** Close the popover. */
  onClose: () => void
  /**
   * Bridge to the harness native directory picker. Always present; the service
   * behind it may not be ready yet, which the button renders as unavailable.
   */
  picker?: PickerBridge
  /** Advance the slideshow by one image (mount owns the algorithm + preload). */
  onNext: () => void
}

/** Describe the currently active source for the status badge. */
function describe(settings: SkinSettings): string {
  if (!settings.enabled) return '未启用'
  if (settings.source === 'image') return '图片（本地）'
  if (settings.source === 'url') return '图片（URL）'
  if (settings.source === 'preset') return '预设'
  if (settings.source === 'folder') {
    const status = folderStatus(settings)
    return status.total === 0 ? '文件夹（空）' : `文件夹 ${status.position}/${status.total}`
  }
  return '未启用'
}

/** The two source families the panel switches between with its dropdown. */
type SourceGroup = 'image' | 'folder'

/** The popover skin settings panel. */
export function SkinPanel({ settings, commit, onClose, picker, onNext }: SkinPanelProps): JSX.Element {
  const [urlInput, setUrlInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A just-picked local image, processed but not yet applied — the user
   *  clicks 「应用」 to commit it (explicit two-step flow). */
  const [staged, setStaged] = useState<string | null>(null)
  /** File name of `staged`, kept so the panel can name the applied image. */
  const [stagedName, setStagedName] = useState<string | null>(null)
  /** Folder path box; seeded from the loaded folder and updated after a scan. */
  const [folderInput, setFolderInput] = useState(settings.folderPath ?? '')
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [folderNotice, setFolderNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const status = folderStatus(settings)
  /** Name of the image currently on screen (null when nothing is named). */
  const currentLabel = currentImageLabel(settings)

  /**
   * Which source family the panel shows. The committed source decides; the
   * dropdown only overrides it (so the user can look at the folder controls
   * before any folder is loaded), and the override lapses as soon as a real
   * switch — 下一张, a preset, a folder load — changes the committed family.
   */
  const sourceGroup: SourceGroup = settings.source === 'folder' ? 'folder' : 'image'
  const [groupOverride, setGroupOverride] = useState<{ base: SourceGroup, value: SourceGroup } | null>(null)
  const group: SourceGroup = groupOverride !== null && groupOverride.base === sourceGroup
    ? groupOverride.value
    : sourceGroup
  const onGroup = (next: SourceGroup): void => { setGroupOverride({ base: sourceGroup, value: next }) }

  const onPickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setBusy(true)
    setError(null)
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

  /** Commit the staged local image to the skin. */
  const onApplyImage = (): void => {
    if (staged === null) return
    commit({
      ...settings,
      enabled: true,
      source: 'image',
      imageDataUrl: staged,
      imageName: stagedName,
      url: null,
      preset: null,
    })
    setStaged(null)
    setStagedName(null)
  }

  const onApplyUrl = (): void => {
    const url = urlInput.trim()
    if (url === '') {
      setError('请输入图片 URL（http:// 或 https:// 开头）。')
      return
    }
    commit({
      ...settings,
      enabled: true,
      source: 'url',
      url,
      imageDataUrl: null,
      imageName: null,
      preset: null,
    })
    setUrlInput('')
    setStaged(null)
    setStagedName(null)
  }

  const onPreset = (value: string): void => {
    commit({
      ...settings,
      enabled: true,
      source: 'preset',
      preset: value,
      imageDataUrl: null,
      imageName: null,
      url: null,
    })
  }

  const onReset = (): void => {
    setStaged(null)
    setStagedName(null)
    setFolderInput('')
    setFolderError(null)
    setFolderNotice(null)
    commit({ ...DEFAULT_SETTINGS })
  }

  /** Scan a folder (or the one currently typed) and start the slideshow. */
  const onLoadFolder = async (explicit?: string): Promise<void> => {
    const target = (explicit ?? folderInput).trim()
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
      setFolderInput(result.root)
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
      setFolderInput(picked)
      await onLoadFolder(picked)
    } catch {
      setFolderError('无法打开系统目录选择器，请直接粘贴文件夹路径。')
    }
  }

  const onMode = (mode: SkinOrderMode): void => {
    commit({ ...settings, orderMode: mode })
  }

  const previewStyle = settings.enabled
    ? { background: 'var(--wx-skin-bg-image, none) center / cover no-repeat, var(--wx-skin-bg-color, transparent)' }
    : undefined

  return (
    <div className={css.panel} role="dialog" aria-label="皮肤设置">
      <div className={css.header}>
        <span>皮肤</span>
        <button type="button" className={css.close} aria-label="关闭" onClick={onClose}>×</button>
      </div>

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

      <div className={css.section}>背景来源</div>
      <select
        className={css.select}
        data-wx-skin-source=""
        aria-label="背景来源"
        value={group}
        onChange={e => { onGroup(e.target.value === 'folder' ? 'folder' : 'image') }}
      >
        <option value="image">图片（本地 / URL / 预设）</option>
        <option value="folder">文件夹</option>
      </select>

      {group === 'image' ? (
        <>
          <div className={css.section}>选择图片</div>
          <div className={css.urlRow}>
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
              <span className={css.stagedLabel}>已选择图片</span>
              <button type="button" className={css.buttonPrimary} onClick={onApplyImage}>应用</button>
            </div>
          )}

          <div className={css.section}>图片 URL</div>
          <div className={css.urlRow}>
            <input
              className={css.urlInput}
              value={urlInput}
              placeholder="https://…/image.jpg"
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onApplyUrl() }}
            />
            <button type="button" className={css.button} onClick={onApplyUrl}>应用</button>
          </div>

          <div className={css.section}>预设</div>
          <div className={css.presets}>
            {PRESETS.map(preset => (
              <button
                key={preset.id}
                type="button"
                className={settings.source === 'preset' && settings.preset === preset.value
                  ? `${css.swatch} ${css.swatchActive}`
                  : css.swatch}
                title={preset.label}
                style={{ background: preset.value }}
                onClick={() => onPreset(preset.value)}
              />
            ))}
          </div>

          {error !== null && <div className={css.errorText}>{error}</div>}
        </>
      ) : (
        <>
          <div className={css.section}>文件夹路径</div>
          <div className={css.urlRow}>
            <input
              className={css.urlInput}
              value={folderInput}
              placeholder="D:\\Pictures\\wallpapers"
              aria-label="图片文件夹路径"
              onChange={e => setFolderInput(e.target.value)}
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
            {/* Always rendered: the harness picker service arrives after this panel
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
              className={css.buttonPrimary}
              disabled={status.total === 0}
              onClick={onNext}
            >
              下一张
            </button>
          </div>
          <div className={css.statusLine}>
            {status.total === 0
              ? '尚未加载文件夹'
              : `第 ${status.position}/${status.total} 张 · 本轮已用 ${status.usedThisPass}/${status.total}`}
            {settings.usedPaths.length > 0 && status.total > 0 && (
              <button type="button" className={css.linkButton} onClick={() => commit({ ...settings, usedPaths: [] })}>
                重置本轮
              </button>
            )}
          </div>
          {folderNotice !== null && <div className={css.noticeText}>{folderNotice}</div>}
          {folderError !== null && <div className={css.errorText}>{folderError}</div>}
        </>
      )}

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
