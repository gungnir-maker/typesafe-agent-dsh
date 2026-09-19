import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The browser half is a hand-written closure-factory artifact with no build
 * step, so nothing else in this repository executes it. The failure it is most
 * likely to hide is silent: a component that reads a service it never declared
 * throws inside the render boundary, and the slot registry retires the entry
 * from its cell for the rest of its life rather than reporting a missing card.
 * The card then simply does not appear, with no error anywhere the author
 * looks. These tests execute the real bundle and fail on that mistake.
 */

const BUNDLE = fileURLToPath(new URL('../client/index.js', import.meta.url))

/** Loaded factory spec captured from the module-loader call. */
type Spec = {
  id: string
  factory: (require: (id: string) => unknown) => {
    apply: (ctx: unknown) => void
    inject: string[]
  }
}

/** Component captured from the slot registration. */
type Component = () => unknown

/**
 * Execute the shipped bundle against a stubbed module loader.
 * @returns the captured spec.
 */
function loadBundle(): Spec {
  let captured: Spec | undefined
  const win = { __ModuleLoader__: { load: (spec: Spec) => { captured = spec } } }
  const run = new Function('window', readFileSync(BUNDLE, 'utf8'))
  run(win)
  if (captured === undefined) throw new Error('bundle never called window.__ModuleLoader__.load')
  return captured
}

/**
 * A React stand-in whose effects run synchronously, so a throw that would reach
 * the render boundary in the browser surfaces here instead.
 */
function reactStub(): unknown {
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (initial: unknown) => [initial, () => {}],
    useEffect: (effect: () => unknown) => { effect() },
  }
}

/** The credential namespace both the host and the browser half address. */
function credentialsStub(): unknown {
  return {
    describe: async (refs: readonly string[]) => ({
      ok: true,
      value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  }
}

/**
 * Resolve the bundle's externals through the injected `require`, which is the
 * only thing the closure factory receives. React is the sole baseline import.
 * @param id - the module-table specifier the bundle asked for.
 * @returns the stub for that specifier.
 */
function requireStub(id: string): unknown {
  if (id === 'react') return reactStub()
  throw new Error(`unexpected require: ${id}`)
}

/**
 * Build a context exposing **only** the services the plugin declared.
 *
 * This is the point of the test: if the component reads `ctx.remote` without
 * `'remote'` in its `inject` list, the property is absent here exactly as it is
 * in the browser, and the render throws.
 * @param declared - the plugin's own inject list.
 * @returns the mock context and a getter for the registered component.
 */
function contextFor(declared: readonly string[]): { ctx: unknown; component: () => Component | undefined } {
  const credentials = credentialsStub()
  let component: Component | undefined
  const ctx: Record<string, unknown> = {
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      register: (_options: unknown, candidate: Component) => { component = candidate; return () => {} },
    },
  }
  if (declared.includes('remote')) ctx.remote = { credentials }
  if (declared.includes('remote.credentials')) ctx['remote.credentials'] = credentials
  return { ctx, component: () => component }
}

test('declares every service the component reads', () => {
  const plugin = loadBundle().factory(requireStub)
  // `remote` is what puts the object on the context; the namespace key alone
  // leaves ctx.remote undefined and the first read throws.
  assert.ok(plugin.inject.includes('slots'), 'must inject slots')
  assert.ok(plugin.inject.includes('remote'), 'must inject the remote service itself')
  assert.ok(plugin.inject.includes('remote.credentials'), 'must inject the credentials namespace')
})

test('registers into the Models footer under a stable id', () => {
  const plugin = loadBundle().factory(requireStub)
  const registrations: Array<{ name?: string; id?: string; order?: number }> = []
  const ctx = {
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      register: (options: { name?: string; id?: string; order?: number }) => {
        registrations.push(options)
        return () => {}
      },
    },
    remote: { credentials: credentialsStub() },
  }
  plugin.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.name, 'settings.models.footer')
  assert.equal(registrations[0]?.id, 'typesafe')
})

test('renders without reading an undeclared service', () => {
  const plugin = loadBundle().factory(requireStub)
  const { ctx, component } = contextFor(plugin.inject)
  plugin.apply(ctx)
  const Card = component()
  assert.equal(typeof Card, 'function', 'slot registration must supply a component')
  assert.notEqual(Card?.(), null, 'the card must render a value')
})

test('the bundle identifies itself by package name', () => {
  // The client module graph keys the browser module by this id.
  assert.equal(loadBundle().id, 'typesafe-agent-dsh')
})
