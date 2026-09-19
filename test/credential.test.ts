import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialService, resolveApiKey } from '../src/credentials.js'

/** Credential reference under test; never the production default. */
const REF = 'TYPESAFE_TEST_KEY'

/** A context stub exposing only the optional-service lookup the resolver uses. */
function context(credentials: unknown): never {
  return { get: (name: string) => (name === 'credentials' ? credentials : undefined) } as never
}

test('prefers the credential service over the ambient environment', async () => {
  process.env[REF] = 'from-environment'
  try {
    const key = await resolveApiKey(
      context({ resolve: async () => ({ value: 'from-credential-store', source: 'store' }) }),
      REF,
    )
    assert.equal(key, 'from-credential-store')
  } finally {
    delete process.env[REF]
  }
})

test('falls back to the ambient environment without a credential service', async () => {
  process.env[REF] = 'from-environment'
  try {
    assert.equal(await resolveApiKey(context(undefined), REF), 'from-environment')
  } finally {
    delete process.env[REF]
  }
})

test('reports an unconfigured reference as absent', async () => {
  delete process.env[REF]
  assert.equal(await resolveApiKey(context({ resolve: async () => undefined }), REF), undefined)
  assert.equal(await resolveApiKey(context(undefined), REF), undefined)
})

test('treats an empty credential and an empty environment value as absent', async () => {
  process.env[REF] = ''
  try {
    assert.equal(await resolveApiKey(context({ resolve: async () => ({ value: '', source: 'store' }) }), REF), undefined)
    assert.equal(await resolveApiKey(context(undefined), REF), undefined)
  } finally {
    delete process.env[REF]
  }
})

test('ignores a service that exposes no resolve method', () => {
  assert.equal(credentialService(context({ describe: async () => ({}) })), undefined)
  assert.equal(credentialService(context(null)), undefined)
  assert.equal(credentialService(context('credentials')), undefined)
})
