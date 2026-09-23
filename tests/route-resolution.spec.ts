/**
 * dsh-wx-skin — browser route-resolution guard.
 *
 * DSH made app-owned browser references DOCUMENT-RELATIVE: the shell injects
 * `<base href="./">`, so one listener answers under any mount (including a
 * prefix-stripping proxy), while a root-absolute `/dsh-wx-skin/...` literal
 * binds the bundle to one mount and misses everywhere else. The harness
 * enforces this over its own browser sources with `verify-client-route-resolution`
 * (`scripts/` in the DSH checkout); this suite is the plugin-local equivalent:
 * it scans the browser half for root-absolute request targets and asserts the
 * asymmetry the convention depends on — browser constants relative, host
 * registration keys absolute.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FOLDER_ROUTE, LOAD_ROUTE, SAVE_ROUTE } from '../src/client/skin-host.ts'
import { IMAGE_ROUTE } from '../src/client/skin-folder.ts'
import { FOLDER_PATH, IMAGE_PATH, LOAD_PATH, SAVE_PATH } from '../src/index.ts'

/** App-owned route prefixes the rule covers (mirrors the harness gate's set). */
const APP_PREFIXES = 'dsh-wx-skin|api|plugins|open-in-app'

/** Request-target shapes a browser route literal can appear in. */
const TARGET_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:fetch|fetchImpl|open|import)\\(\\s*['"\`]\\/(?:${APP_PREFIXES})\\/`),
  new RegExp(`(?:src|href|url|action)\\s*[:=]\\s*['"\`]\\/(?:${APP_PREFIXES})\\/`),
  new RegExp(`new\\s+(?:URL|Request)\\(\\s*['"\`]\\/(?:${APP_PREFIXES})\\/`),
]

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

describe('browser route resolution', () => {
  it('addresses every app route document-relatively', () => {
    expect(LOAD_ROUTE).toBe('dsh-wx-skin/load')
    expect(SAVE_ROUTE).toBe('dsh-wx-skin/save')
    expect(FOLDER_ROUTE).toBe('dsh-wx-skin/folder')
    expect(IMAGE_ROUTE).toBe('dsh-wx-skin/image')
    for (const route of [LOAD_ROUTE, SAVE_ROUTE, FOLDER_ROUTE, IMAGE_ROUTE]) {
      expect(route.startsWith('/'), `${route} must not be root-absolute`).toBe(false)
    }
  })

  it('keeps the host registration keys absolute', () => {
    expect(LOAD_PATH).toBe('/dsh-wx-skin/load')
    expect(SAVE_PATH).toBe('/dsh-wx-skin/save')
    expect(FOLDER_PATH).toBe('/dsh-wx-skin/folder')
    expect(IMAGE_PATH).toBe('/dsh-wx-skin/image')
  })

  it('has no root-absolute request target in the browser half', () => {
    const root = fileURLToPath(new URL('../src/client', import.meta.url))
    const offenders: string[] = []
    for (const path of walk(root)) {
      const source = readFileSync(path, 'utf8')
      for (const pattern of TARGET_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${path}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
