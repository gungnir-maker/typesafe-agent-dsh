/**
 * DeepSeek Harness browser half for typesafe-agent-dsh.
 *
 * Registers one TypeSafe card in the Models settings page's footer extension
 * area, so the API key that `typesafe_verify_task` resolves is entered beside
 * the provider keys instead of being hand-written into a `.env` file.
 *
 * Written as the shipped artifact rather than compiled from a source tree: the
 * Harness client-module loader consumes exactly this closure-factory form
 * (`window.__ModuleLoader__.load({ id, factory })`, the factory returning the
 * plugin's exports), and the package carries no client build step. React is a
 * client baseline external; the slot service and the credentials Remote are
 * reached through the injected context, so nothing else is required here.
 *
 * The key is written through the existing `ctx.remote.credentials` namespace,
 * which is the same surface the Models page uses. The literal travels one way
 * only: `describe` answers whether a value is configured and never returns it.
 */

window.__ModuleLoader__.load({
  id: 'typesafe-agent-dsh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /** Credential reference the Host's `typesafe` check resolves. */
    const REF = 'TYPESAFE_API_KEY'

    /** Models-page extension seat this card occupies. */
    const SLOT = 'settings.models.footer'

    /**
     * Theme-token styles, inlined rather than injected as a stylesheet: a
     * hand-written artifact has no CSS-module pipeline, and these are the same
     * variables the surrounding provider rows use.
     */
    const styles = {
      card: {
        maxWidth: '560px',
        padding: '16px',
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      identity: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      name: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      dot: { boxSizing: 'border-box', flex: 'none', width: '8px', height: '8px', borderRadius: '50%' },
      actions: { display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: '12px',
        padding: '8px 10px',
        fontSize: '13px',
        borderRadius: '8px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      button: {
        padding: '5px 12px',
        fontSize: '13px',
        borderRadius: '8px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      primary: {
        background: 'var(--dsw-alias-brand-primary)',
        borderColor: 'transparent',
        color: '#fff',
      },
      note: { margin: '10px 0 0', fontSize: '12px', lineHeight: 1.4 },
      noteOk: { color: 'var(--dsw-alias-state-success-primary)' },
      noteError: { color: 'var(--dsw-alias-state-error-primary)' },
      hint: {
        margin: '10px 0 0',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /**
     * Mount the card.
     * @param ctx - browser plugin context; `slots` and the `remote.credentials`
     * namespace are declared in this plugin's own `inject`.
     */
    function apply(ctx) {
      function TypeSafeCard() {
        const [draft, setDraft] = React.useState('')
        const [state, setState] = React.useState({
          configured: false,
          writable: true,
          error: null,
        })
        const [note, setNote] = React.useState(null)
        const [busy, setBusy] = React.useState(false)

        /** Re-read whether the Host holds a value for {@link REF}. */
        const refresh = async () => {
          try {
            const response = await ctx.remote.credentials.describe([REF])
            if (!response.ok) {
              setState({ configured: false, writable: false, error: response.error.message })
              return
            }
            const info = response.value[REF]
            setState({
              configured: info !== undefined && info.configured === true,
              writable: info === undefined || info.writable !== false,
              error: null,
            })
          } catch (error) {
            setState({ configured: false, writable: false, error: String(error) })
          }
        }

        React.useEffect(() => {
          let live = true
          ctx.remote.credentials.describe([REF]).then((response) => {
            if (!live) return
            if (!response.ok) {
              setState({ configured: false, writable: false, error: response.error.message })
              return
            }
            const info = response.value[REF]
            setState({
              configured: info !== undefined && info.configured === true,
              writable: info === undefined || info.writable !== false,
              error: null,
            })
          }).catch((error) => {
            if (live) setState({ configured: false, writable: false, error: String(error) })
          })
          return () => { live = false }
        }, [])

        /**
         * Store the staged key. Refusals are surfaced verbatim: the Host's own
         * message is what names a read-only source shadowing the reference.
         */
        const submit = async () => {
          setBusy(true)
          setNote(null)
          try {
            const response = await ctx.remote.credentials.set(REF, draft)
            if (response.ok) {
              setDraft('')
              setNote({ tone: 'ok', text: 'Key stored.' })
            } else {
              setNote({ tone: 'error', text: response.error.message })
            }
          } catch (error) {
            setNote({ tone: 'error', text: String(error) })
          }
          setBusy(false)
          await refresh()
        }

        /** Remove the stored key; the ambient environment is untouched. */
        const remove = async () => {
          setBusy(true)
          setNote(null)
          try {
            const response = await ctx.remote.credentials.unset(REF)
            if (!response.ok) setNote({ tone: 'error', text: response.error.message })
            else setNote({ tone: 'ok', text: 'Key removed.' })
          } catch (error) {
            setNote({ tone: 'error', text: String(error) })
          }
          setBusy(false)
          await refresh()
        }

        const dotLabel = state.configured ? 'TypeSafe key configured' : 'TypeSafe key missing'
        const canSubmit = !busy && draft.length > 0 && state.writable

        return React.createElement(
          'div',
          { style: styles.card },
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement(
              'div',
              { style: styles.identity },
              React.createElement('span', { style: styles.name }, 'TypeSafe'),
              React.createElement('span', {
                style: {
                  ...styles.dot,
                  background: state.configured
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-state-error-primary)',
                },
                role: 'img',
                'aria-label': dotLabel,
                title: dotLabel,
              }),
            ),
            React.createElement(
              'div',
              { style: styles.actions },
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: { ...styles.button, ...styles.primary, opacity: canSubmit ? 1 : 0.5 },
                  disabled: !canSubmit,
                  onClick: () => { void submit() },
                },
                busy ? 'Saving...' : 'Save',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: { ...styles.button, opacity: busy || !state.configured ? 0.5 : 1 },
                  disabled: busy || !state.configured || !state.writable,
                  onClick: () => { void remove() },
                },
                'Remove',
              ),
            ),
          ),
          React.createElement('input', {
            style: styles.input,
            type: 'password',
            value: draft,
            placeholder: state.configured
              ? 'Stored - paste a new key to replace it'
              : 'Paste your TypeSafe API key',
            autoComplete: 'off',
            spellCheck: false,
            'aria-label': 'TypeSafe API key',
            onChange: (event) => { setDraft(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && canSubmit) {
                event.preventDefault()
                void submit()
              }
            },
          }),
          note === null
            ? null
            : React.createElement(
              'p',
              { style: { ...styles.note, ...(note.tone === 'ok' ? styles.noteOk : styles.noteError) } },
              note.text,
            ),
          state.error === null
            ? null
            : React.createElement('p', { style: { ...styles.note, ...styles.noteError } }, state.error),
          React.createElement(
            'p',
            { style: styles.hint },
            'Semantic completion gate for typesafe-agent-dsh. Stored in the Harness credential store '
            + `under ${REF}, layered over the launching environment; the value is never returned to this page.`,
          ),
        )
      }

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'typesafe',
        order: 0,
      }, TypeSafeCard))
    }

    exports.apply = apply
    exports.inject = ['slots', 'remote.credentials']
    return module.exports
  },
})
