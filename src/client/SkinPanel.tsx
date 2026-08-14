/**
 * dsh-wx-skin — the popover panel: enable toggle, background preview, local
 * image picker (file input → downscale → data URL), URL input, presets, dim /
 * blur sliders, and reset. The component is controlled: every change calls
 * `commit` (mount persists + applies to the document), keeping the panel and
 * the live skin in lockstep.
 * @module dsh-wx-skin/client/skin-panel
 */
import { useRef, useState, type ChangeEvent } from 'react'
import type { SkinSettings } from '../core/types.ts'
import { ImagePipelineError, fileToDataUrl } from './image-pipeline.ts'
import { DEFAULT_SURFACE, MIN_SURFACE, MAX_SURFACE, PRESETS } from './skin-store.ts'
import css from './skin.module.css'

export interface SkinPanelProps {
  /** Settings as loaded at open time. */
  initial: SkinSettings
  /** Persist + apply a settings change (mount wires storage + DOM). */
  commit: (next: SkinSettings) => void
  /** Close the popover. */
  onClose: () => void
}

/** Describe the currently active source for the status badge. */
function describe(settings: SkinSettings): string {
  if (!settings.enabled) return '未启用'
  if (settings.source === 'image') return '图片（本地）'
  if (settings.source === 'url') return '图片（URL）'
  if (settings.source === 'preset') return '预设'
  return '未启用'
}

/** The popover skin settings panel. */
export function SkinPanel({ initial, commit, onClose }: SkinPanelProps): JSX.Element {
  const [settings, setSettings] = useState<SkinSettings>(initial)
  const [urlInput, setUrlInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A just-picked local image, processed but not yet applied — the user
   *  clicks 「应用」 to commit it (explicit two-step flow). */
  const [staged, setStaged] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const setAndCommit = (next: SkinSettings): void => {
    setSettings(next)
    setError(null)
    commit(next)
  }

  const onPickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setBusy(true)
    setError(null)
    try {
      const dataUrl = await fileToDataUrl(file)
      setStaged(dataUrl)
    } catch (err) {
      setStaged(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Commit the staged local image to the skin. */
  const onApplyImage = (): void => {
    if (staged === null) return
    setAndCommit({
      ...settings,
      enabled: true,
      source: 'image',
      imageDataUrl: staged,
      url: null,
      preset: null,
    })
    setStaged(null)
  }

  const onApplyUrl = (): void => {
    const url = urlInput.trim()
    if (url === '') {
      setError('请输入图片 URL（http:// 或 https:// 开头）。')
      return
    }
    setAndCommit({
      ...settings,
      enabled: true,
      source: 'url',
      url,
      imageDataUrl: null,
      preset: null,
    })
    setUrlInput('')
    setStaged(null)
  }

  const onPreset = (value: string): void => {
    setAndCommit({
      ...settings,
      enabled: true,
      source: 'preset',
      preset: value,
      imageDataUrl: null,
      url: null,
    })
  }

  const onReset = (): void => {
    setStaged(null)
    setAndCommit({
      ...settings,
      enabled: false,
      source: 'none',
      imageDataUrl: null,
      url: null,
      preset: null,
      dim: 0.35,
      blur: 0,
      surface: DEFAULT_SURFACE,
    })
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
          onChange={e => setAndCommit({ ...settings, enabled: e.target.checked })}
        />
        <span>启用皮肤</span>
      </label>

      <div className={css.preview} style={previewStyle}>
        {!settings.enabled && <span>未启用</span>}
      </div>
      <div className={css.currentBadge}>当前：{describe(settings)}</div>

      <div className={css.section}>选择图片</div>
      <div className={css.urlRow}>
        <button
          type="button"
          className={css.buttonPrimary}
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
          onChange={e => setAndCommit({ ...settings, dim: Number(e.target.value) / 100 })}
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
          onChange={e => setAndCommit({ ...settings, blur: Number(e.target.value) })}
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
          onChange={e => setAndCommit({ ...settings, surface: Number(e.target.value) / 100 })}
        />
      </div>

      {error !== null && <div className={css.errorText}>{error}</div>}

      <div className={css.footer}>
        <button type="button" className={css.button} onClick={onReset}>恢复默认</button>
      </div>
    </div>
  )
}
