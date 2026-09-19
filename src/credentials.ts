/**
 * Credential resolution for the TypeSafe key.
 *
 * Deliberately its own module: `index.ts` imports `@deepseek-ai/dsh-tools`,
 * which only resolves inside a DeepSeek Harness process, so anything living
 * there is untestable in this standalone package. This file depends on the
 * Harness context by type only.
 * @module typesafe-agent-dsh/credentials
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The slice of the Harness credential service this plugin reads.
 *
 * Resolution is per call and never cached: a key written from a configuration
 * surface must reach the next verification without a restart, and the service
 * is the only authority on whether a value exists.
 */
export type CredentialService = {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

/**
 * Narrow the optional credential service at runtime.
 *
 * The service is genuinely optional — a composition may mount no credential
 * provider, and the published package is also loaded outside the Harness — so
 * the shape is checked rather than asserted.
 * @param ctx - plugin context.
 * @returns the service, or `undefined` when this composition mounts none.
 */
export function credentialService(ctx: Context): CredentialService | undefined {
  const candidate = ctx.get('credentials')
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return undefined
  const resolve = (candidate as { resolve?: unknown }).resolve
  return typeof resolve === 'function' ? candidate as CredentialService : undefined
}

/**
 * Resolve the TypeSafe key for one reference.
 *
 * The credential service is asked first because it layers the writable store
 * over `.env` files and the inherited environment, so a key stored from the
 * Models page resolves exactly like one exported before launch. The ambient
 * environment is the fallback for the standalone package, where no Harness
 * credential provider is mounted and the service is unreachable. An empty
 * value never counts as configured, matching the credential seam's own rule.
 * @param ctx - plugin context; the credential service is optional.
 * @param ref - credential reference naming the environment key.
 * @returns the non-empty key, or `undefined` while the reference is unconfigured.
 */
export async function resolveApiKey(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = credentialService(ctx)
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(ref)
    return resolved !== undefined && resolved.value.length > 0 ? resolved.value : undefined
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}
