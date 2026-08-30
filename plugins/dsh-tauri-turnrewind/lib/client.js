// dsh-tauri-turnrewind — client bundle (browser).
//
// Raises the in-app "undo unavailable" dialog when the current session
// carries the unsupported-workspace heads-up injected by the host.
//
// Hand-written against the DSH client module contract:
//   window.__ModuleLoader__.load({ id, factory }) where factory receives a
//   CommonJS-style `require` and must export `apply` (cordis plugin) + `inject`
//   (services the apply() context needs).
//
// The module id MUST normalize to the bare package name: the client module
// system strips a trailing `/client` and the boot manifest imports the plugin
// under its package name, so this factory is what the manifest materializes.
// Command output renders with the harness's native command card on purpose —
// no custom renderer, so errors show in the native red style.
globalThis.__ModuleLoader__.load({
  id: 'dsh-tauri-turnrewind/client',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const inject = ['sessions', 'locale']

    // ------------------------------------------------------------------
    // Unsupported-workspace dialog: storage, DOM, and runner.
    // ------------------------------------------------------------------
    const NS = 'dsh-tauri-turnrewind'
    const SEEN_KEY = 'turnrewind.seenUnsupportedNotices'
    const MAX_SEEN = 100

    const dictionaries = {
      zh: {
        title: '撤销功能在此工作区不可用',
        intro: '当前会话的工作区不支持文件撤销。对话照常运行，但本工作区内的文件改动无法用 /undo 撤销。',
        reason: '原因',
        ok: '知道了',
      },
      en: {
        title: 'Undo is unavailable in this workspace',
        intro: 'File undo is disabled for this session\'s workspace. Turns still run normally, but changes in this workspace cannot be reverted with /undo.',
        reason: 'Reason',
        ok: 'Got it',
      },
    }

    function readSeen() {
      try {
        const raw = globalThis.localStorage.getItem(SEEN_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list : []
      }
      catch {
        return []
      }
    }

    function markSeen(id) {
      try {
        const seen = readSeen().filter(entry => entry !== id)
        seen.push(id)
        globalThis.localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-MAX_SEEN)))
      }
      catch {
        // Storage may be unavailable; the dialog just re-shows next reload.
      }
    }

    let dialog

    function ensureDialog() {
      if (dialog)
        return dialog
      // Colors are app theme tokens (with hardcoded fallbacks), so the dialog
      // follows the in-app light/dark theme live — inline `var()` re-resolves
      // when the theme switches, no rebuild needed.
      const backdrop = document.createElement('div')
      backdrop.setAttribute('role', 'presentation')
      Object.assign(backdrop.style, {
        display: 'none',
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
      })

      const card = document.createElement('div')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      Object.assign(card.style, {
        maxWidth: '440px',
        width: 'calc(100vw - 48px)',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
        borderRadius: '12px',
        padding: '20px 22px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '1.6',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
      })

      const title = document.createElement('div')
      Object.assign(title.style, {
        fontSize: '15px',
        fontWeight: '600',
        marginBottom: '10px',
        color: 'var(--dsw-alias-state-error-primary, #d03050)',
      })

      const intro = document.createElement('div')
      Object.assign(intro.style, { color: 'var(--dsw-alias-label-secondary, #333333)' })

      const reasonLabel = document.createElement('div')
      Object.assign(reasonLabel.style, { marginTop: '12px', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: '12px' })

      const reasonBox = document.createElement('div')
      Object.assign(reasonBox.style, {
        marginTop: '6px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
        maxHeight: '160px',
        overflowY: 'auto',
      })

      const actions = document.createElement('div')
      Object.assign(actions.style, { marginTop: '16px', textAlign: 'right' })
      const button = document.createElement('button')
      button.type = 'button'
      Object.assign(button.style, {
        background: 'var(--dsw-alias-button-primary-fill, #4f46e5)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        border: 'none',
        borderRadius: '8px',
        padding: '6px 18px',
        fontSize: '13px',
        cursor: 'pointer',
      })
      button.addEventListener('mouseover', () => {
        button.style.background = 'var(--dsw-alias-button-primary-hover, #4338ca)'
      })
      button.addEventListener('mouseout', () => {
        button.style.background = 'var(--dsw-alias-button-primary-fill, #4f46e5)'
      })
      actions.appendChild(button)

      card.append(title, intro, reasonLabel, reasonBox, actions)
      backdrop.appendChild(card)
      document.body.appendChild(backdrop)

      function hide() {
        backdrop.style.display = 'none'
      }
      button.addEventListener('click', hide)
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop)
          hide()
      })

      dialog = { backdrop, title, intro, reasonLabel, reasonBox, button }
      return dialog
    }

    function showDialog(t, notices) {
      const el = ensureDialog()
      el.title.textContent = t('title')
      el.intro.textContent = t('intro')
      el.reasonLabel.textContent = t('reason')
      el.reasonBox.textContent = notices.map(notice => notice.reason || notice.id).join('\n')
      el.button.textContent = t('ok')
      el.backdrop.style.display = 'flex'
    }

    // ------------------------------------------------------------------
    // Plugin apply.
    // ------------------------------------------------------------------
    function apply(ctx) {
      console.warn('[turnrewind] client apply: dialog runner starting')
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'turnrewind locale')
      const t = ctx.locale.bind(NS)
      // Read through the service store, not the ctx.sessions property proxy:
      // the host session service merges a different member under the same name.
      const sessions = ctx.get('sessions')

      function checkOnce() {
        const state = sessions.list.getSnapshot()
        const summary = state.current !== undefined ? state.byId[state.current] : undefined
        const value = summary?.projectionValues?.turnrewind
        const notices = Array.isArray(value?.notices) ? value.notices : []
        const fresh = notices.filter(notice => notice && typeof notice.id === 'string' && !readSeen().includes(notice.id))
        if (fresh.length === 0)
          return
        console.warn(`[turnrewind] unsupported heads-up visible: ${fresh.map(notice => notice.id).join(', ')}`)
        for (const notice of fresh) markSeen(notice.id)
        showDialog(t, fresh)
      }

      ctx.effect(() => {
        const unsubscribe = sessions.list.subscribe(checkOnce)
        // Projection frames can land while the page is loading, before the list
        // store has any subscribers; poll briefly so that ordering can never
        // silently swallow the heads-up.
        const poll = setInterval(checkOnce, 2000)
        const stopPolling = setTimeout(clearInterval, 120000, poll)
        return () => {
          unsubscribe()
          clearInterval(poll)
          clearTimeout(stopPolling)
        }
      }, 'turnrewind dialog runner')
    }

    Object.assign(exports, { apply, inject })
    return module.exports
  },
})
