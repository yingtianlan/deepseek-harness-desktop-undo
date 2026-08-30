// dsh-tauri-turnrewind — client bundle (browser).
// Registers a keyed renderer for the `conversation.chat.commandview` slot at
// key "undo", replacing the generic plain-text command card with a diff-aware
// view that renders deletions red and additions green.
//
// Hand-written against the DSH client module contract:
//   window.__ModuleLoader__.load({ id, factory }) where factory receives a
//   CommonJS-style `require` and must export `apply` (cordis plugin) + `inject`
//   (list of cordis services the apply() context needs).
window.__ModuleLoader__.load({
  id: 'dsh-tauri-turnrewind/client',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const jsx = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs

    const inject = ['slots']

    // ------------------------------------------------------------------
    // Unified-diff line classification.
    // ------------------------------------------------------------------
    function classifyLine(raw) {
      const line = raw
      if (/^\s*diff --git /.test(line))
        return { kind: 'meta', text: line.trim() }
      if (/^\s*index /.test(line))
        return { kind: 'meta', text: line.trim() }
      if (/^\s*---\s+a\//.test(line))
        return { kind: 'meta', text: line.trim() }
      if (/^\s*\+\+\+\s+b\//.test(line))
        return { kind: 'meta', text: line.trim() }
      if (/^\s*@@/.test(line))
        return { kind: 'hunk', text: line.trim() }
      if (/^\s*-/.test(line))
        return { kind: 'del', text: line.replace(/^\s*-/, '') }
      if (/^\s*\+/.test(line))
        return { kind: 'add', text: line.replace(/^\s*\+/, '') }
      return { kind: 'ctx', text: line.replace(/^\s+/, '') }
    }

    function isDiffLine(raw) {
      return /^\s*(?:diff --git |index |--- |\+\+\+ |@@|-[^-]|\+[^+]|-$|\+$)/.test(raw)
    }

    // A "section separator" we emit in the preview, e.g. "--- undo-demo.txt".
    function isFileSeparator(raw) {
      return /^---\s+(?!a\/)\S/.test(raw)
    }

    // ------------------------------------------------------------------
    // Rendering.
    // ------------------------------------------------------------------
    const COLORS = {
      delBg: 'rgba(248,81,73,0.16)',
      delSign: '#f85149',
      addBg: 'rgba(46,160,67,0.16)',
      addSign: '#3fb950',
      hunk: '#79b8ff',
      meta: '#8b949e',
      ctx: '#c9d1d9',
      border: '#30363d',
      bg: 'var(--dsw-alias-markdown-code-block, #161b22)',
      label: 'var(--dsw-alias-label-tertiary, #8b949e)',
      title: 'var(--dsw-alias-label-secondary, #c9d1d9)',
    }

    function diffLineStyle(kind) {
      switch (kind) {
        case 'del': return { background: COLORS.delBg, color: COLORS.ctx }
        case 'add': return { background: COLORS.addBg, color: COLORS.ctx }
        case 'hunk': return { color: COLORS.hunk }
        case 'meta': return { color: COLORS.meta }
        default: return { color: COLORS.ctx }
      }
    }

    function signFor(kind) {
      if (kind === 'del')
        return '-'
      if (kind === 'add')
        return '+'
      return ' '
    }

    function DiffLine(props) {
      const entry = props.entry
      const style = diffLineStyle(entry.kind)
      return jsxs('div', {
        style: Object.assign(
          { display: 'flex', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12.5px', lineHeight: '20px', paddingLeft: 8, paddingRight: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
          style,
        ),
        children: [
          jsx('span', {
            style: { width: 16, flex: 'none', color: entry.kind === 'del' ? COLORS.delSign : entry.kind === 'add' ? COLORS.addSign : COLORS.meta, userSelect: 'none' },
            children: signFor(entry.kind),
          }),
          jsx('span', { style: { flex: 1 }, children: entry.text }),
        ],
      })
    }

    function UndoCommandView(props) {
      const node = props.node || {}
      const outcome = node.outcome
      const text = outcome && typeof outcome.text === 'string' ? outcome.text : ''
      const state = outcome == null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
      const summary = text ? text.split('\n')[0] : (state === 'error' ? '失败' : state === 'running' ? '运行中' : '已完成')
      const body = text.includes('\n') ? text : null
      const [expanded, setExpanded] = React.useState(body !== null)

      const lines = body ? body.split('\n') : []
      const rows = []
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        if (isFileSeparator(raw)) {
          rows.push(jsx('div', {
            style: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12.5px', lineHeight: '20px', paddingLeft: 8, paddingRight: 8, color: COLORS.title, fontWeight: 600 },
            children: raw.replace(/^---\s+/, ''),
          }, `fs${i}`))
        }
        else if (isDiffLine(raw)) {
          rows.push(jsx(DiffLine, { entry: classifyLine(raw) }, `l${i}`))
        }
        else {
          rows.push(jsx('div', {
            style: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12.5px', lineHeight: '20px', paddingLeft: 8, paddingRight: 8, color: COLORS.label, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            children: raw,
          }, `p${i}`))
        }
      }

      return jsxs('div', {
        style: { border: `1px solid ${COLORS.border}`, background: COLORS.bg, borderRadius: 12, margin: '4px 0 4px 4px', overflow: 'hidden', maxWidth: '100%' },
        children: [
          jsxs('button', {
            type: 'button',
            onClick() { setExpanded(v => !v) },
            style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 12px', color: COLORS.title, fontSize: 13 },
            children: [
              jsx('span', { style: { transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .12s', display: 'inline-block', color: COLORS.label }, children: '▸' }),
              jsx('span', { style: { fontWeight: 500 }, children: node.name || 'undo' }),
              jsx('span', { style: { color: COLORS.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }, children: summary }),
            ],
          }),
          expanded && body !== null
            ? jsx('div', {
                style: { borderTop: `1px solid ${COLORS.border}`, paddingTop: 8, paddingBottom: 8, maxHeight: 340, overflow: 'auto' },
                children: rows,
              })
            : null,
        ],
      })
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.chat.commandview', () => {
        return ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'undo',
        }, UndoCommandView)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
// Client half of dsh-tauri-turnrewind: raises an in-app dialog when the
// current session carries an unsupported-workspace heads-up from the host.
// Hand-wrapped in the dsh client ModuleLoader format (no build step): the web
// app evaluates this file and registers the module under the plugin name.
if (globalThis.__ModuleLoader__) {
  globalThis.__ModuleLoader__.load({ id: 'dsh-tauri-turnrewind', factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const inject = ['sessions', 'locale']

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

    function palette() {
      const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
      return dark
        ? { card: '#1f2937', text: '#f9fafb', muted: '#9ca3af', box: '#111827', boxBorder: '#374151', backdrop: 'rgba(2, 6, 23, 0.6)', button: '#6366f1', buttonText: '#ffffff' }
        : { card: '#ffffff', text: '#111827', muted: '#6b7280', box: '#f3f4f6', boxBorder: '#e5e7eb', backdrop: 'rgba(15, 23, 42, 0.45)', button: '#4f46e5', buttonText: '#ffffff' }
    }

    function ensureDialog() {
      if (dialog)
        return dialog
      const colors = palette()
      const backdrop = document.createElement('div')
      backdrop.setAttribute('role', 'presentation')
      Object.assign(backdrop.style, {
        display: 'none',
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.backdrop,
      })

      const card = document.createElement('div')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      Object.assign(card.style, {
        maxWidth: '440px',
        width: 'calc(100vw - 48px)',
        boxSizing: 'border-box',
        background: colors.card,
        color: colors.text,
        borderRadius: '12px',
        padding: '20px 22px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '1.6',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)',
      })

      const title = document.createElement('div')
      Object.assign(title.style, { fontSize: '15px', fontWeight: '600', marginBottom: '10px' })

      const intro = document.createElement('div')

      const reasonLabel = document.createElement('div')
      Object.assign(reasonLabel.style, { marginTop: '12px', color: colors.muted, fontSize: '12px' })

      const reasonBox = document.createElement('div')
      Object.assign(reasonBox.style, {
        marginTop: '6px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: colors.box,
        border: `1px solid ${colors.boxBorder}`,
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
        background: colors.button,
        color: colors.buttonText,
        border: 'none',
        borderRadius: '8px',
        padding: '6px 18px',
        fontSize: '13px',
        cursor: 'pointer',
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

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'turnrewind locale')
      const t = ctx.locale.bind(NS)
      // Read through the service store, not the ctx.sessions property proxy:
      // the host session service merges a different member under the same name.
      const sessions = ctx.get('sessions')
      ctx.effect(() => {
        const unsubscribe = sessions.list.subscribe(() => {
          const state = sessions.list.getSnapshot()
          const summary = state.current !== undefined ? state.byId[state.current] : undefined
          const value = summary?.projectionValues?.turnrewind
          const notices = Array.isArray(value?.notices) ? value.notices : []
          const fresh = notices.filter(notice => notice && typeof notice.id === 'string' && !readSeen().includes(notice.id))
          if (fresh.length === 0)
            return
          for (const notice of fresh) markSeen(notice.id)
          showDialog(t, fresh)
        })
        return () => {
          unsubscribe()
        }
      }, 'turnrewind dialog runner')
    }

    Object.assign(exports, { apply, inject })
    return module.exports
  } })
}
