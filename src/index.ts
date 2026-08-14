/**
 * dsh-wx-skin — host half: a no-op plugin row. The whole skin lives in the
 * browser half (exports "./client", served by client-modules from the
 * package's `dsh.client` declaration); the node entry exists only so the
 * profile Loader row has a valid module to mount.
 * @module dsh-wx-skin
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-wx-skin'

/**
 * Apply the host half: nothing to do — the skin is browser-only.
 * @param _ctx - the Cordis context (unused).
 */
export function apply(_ctx: Context): void {
  // Intentionally empty.
}
