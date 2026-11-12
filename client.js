window.__ModuleLoader__.load({
  id: 'dsh-macos-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Mirrors `Config` in index.js; keys must stay in sync with the schema.
    const FIELDS = [
      { key: 'approval', type: 'boolean', zh: '需要批准时通知', en: 'Notify when approval is needed', zhHint: '工具调用要你授权时弹通知，点通知回到 DSH 处理', enHint: 'Popup when a tool call needs your approval' },
      { key: 'turnComplete', type: 'boolean', zh: '回合完成时通知', en: 'Notify when a turn completes', zhHint: '正文显示最后一段回答', enHint: 'Body shows the last part of the answer' },
      { key: 'error', type: 'boolean', zh: '任务出错时通知', en: 'Notify on turn errors', zhHint: '模型或工具失败导致回合异常结束时弹', enHint: 'When a turn ends with an error' },
      { key: 'questions', type: 'boolean', zh: '提问时通知', en: 'Notify on questions', zhHint: '等待你回答问题或选项时弹', enHint: 'When the agent waits for your answer' },
      { key: 'subagentSessions', type: 'boolean', zh: '子代理也通知', en: 'Include subagents', zhHint: '开启后子代理 / workflow 内部会话结束也会弹，长任务容易被刷屏', enHint: 'Also notify for subagent and workflow sessions' },
      { key: 'skipWhenFocused', type: 'boolean', zh: '前台不打扰', en: 'Quiet while DSH is frontmost', zhHint: 'DSH 窗口在前台时不弹通知', enHint: 'Skip notifications while DeepSeek Harness is the frontmost app' },
      { key: 'sound', type: 'string', zh: '提示音', en: 'Sound', zhHint: '系统音效名，例如 Glass / Ping / Hero，留空静音', enHint: 'System sound name (Glass, Ping, Hero…). Empty mutes it' },
      { key: 'activateOnClick', type: 'boolean', zh: '点击激活窗口', en: 'Activate on click', zhHint: '点通知时把 DeepSeek Harness 切到前台', enHint: 'Bring DeepSeek Harness forward when a notification is clicked' },
    ]

    const DEFAULTS = {
      approval: true,
      turnComplete: true,
      error: true,
      questions: true,
      subagentSessions: false,
      skipWhenFocused: true,
      sound: 'Glass',
      activateOnClick: true,
    }

    const styles = {
      card: {
        border: '1px solid rgba(128,128,128,.25)',
        borderRadius: 12,
        padding: '0 16px',
        marginTop: 14,
      },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        padding: '12px 0',
        borderTop: '1px solid rgba(128,128,128,.18)',
      },
      label: { fontSize: 14, lineHeight: '20px' },
      hint: { fontSize: 12, lineHeight: '18px', opacity: 0.62, marginTop: 2 },
      title: { fontSize: 18, margin: '0 0 6px' },
      intro: { fontSize: 13, opacity: 0.7, margin: 0 },
      note: { fontSize: 12, opacity: 0.55, marginTop: 10 },
      error: { fontSize: 12, color: '#d9534f', marginTop: 10, whiteSpace: 'pre-wrap' },
      input: {
        width: 170,
        padding: '5px 8px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
      },
    }

    function pageText(en) {
      return {
        heading: en ? 'macOS notifications' : 'macOS 系统通知',
        intro: en
          ? 'Native notifications when the harness needs an approval, finishes a turn, fails, or waits for your answer.'
          : '需要你批准、任务完成、任务出错、等待你回答时，弹出 macOS 原生系统通知。',
        loading: en ? 'Reading configuration…' : '正在读取配置…',
        missing: en
          ? 'This plugin entry exposes no editable fields yet. Reload the plugin (toggle it off and on) and reopen this page.'
          : '这个插件条目还没有可编辑字段。把插件关掉再打开，然后重新进入本页。',
        footer: en
          ? 'Changes apply immediately and are stored in the profile patch.'
          : '改动立即生效，保存在 profile 的 cordis.patch.yml 里。',
        unavailable: en ? 'The settings service is unavailable.' : '设置服务不可用。',
      }
    }

    const isEn = (ctx) => {
      try {
        return String(ctx.get('locale')?.getSnapshot?.().active ?? '').startsWith('en')
      } catch {
        return false
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots ?? ctx.get('slots')
        if (slots === undefined) return

        const remote = ctx.get('remote.settings')
        const en = isEn(ctx)
        const text = pageText(en)
        const ns = 'macos-notify'

        // Remote calls answer `{ ok, value }` envelopes; tolerate a raw value too.
        const unwrap = (answer) => {
          if (answer !== null && typeof answer === 'object' && 'ok' in answer) {
            if (answer.ok !== true) throw new Error(answer?.error?.message ?? String(answer?.error ?? 'remote call failed'))
            return answer.value
          }
          return answer
        }
        const read = async () => {
          if (remote === undefined) throw new Error(text.unavailable)
          const value = unwrap(await remote.describe())
          return (value?.namespaces ?? []).find((row) => row.ns === ns) ?? null
        }
        const write = async (patch, revision) => {
          if (remote === undefined) throw new Error(text.unavailable)
          return unwrap(await remote.update(ns, patch, revision))
        }

        function Page() {
          const [view, setView] = React.useState({ status: 'loading', error: null, data: null })
          const [draft, setDraft] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const pending = React.useRef(null)

          const load = React.useCallback(async () => {
            try {
              const data = await read()
              setDraft(data?.value ?? null)
              setView({ status: data ? 'ready' : 'missing', error: null, data })
            } catch (error) {
              setView({ status: 'error', error: error?.message ?? String(error), data: null })
            }
          }, [])

          React.useEffect(() => { load() }, [load])

          const commit = async (key, value) => {
            const next = { ...(draft ?? {}), [key]: value }
            setDraft(next)
            // Text fields commit once typing pauses; booleans commit at once.
            if (pending.current !== null) clearTimeout(pending.current)
            const flush = async () => {
              pending.current = null
              setBusy(true)
              try {
                const clean = typeof value === 'string' ? value.trim() : value
                const data = await write({ [key]: clean }, view.data?.revision)
                setView({ status: 'ready', error: null, data })
                setDraft(data?.value ?? next)
              } catch (error) {
                setView((current) => ({ ...current, error: error?.message ?? String(error) }))
                await load()
              } finally {
                setBusy(false)
              }
            }
            if (typeof value === 'string') pending.current = setTimeout(flush, 400)
            else await flush()
          }

          const body = []
          body.push(h('h2', { key: 'title', style: styles.title }, text.heading))
          body.push(h('p', { key: 'intro', style: styles.intro }, text.intro))

          if (view.status === 'loading') {
            body.push(h('p', { key: 'loading', style: styles.note }, text.loading))
          } else if (view.status === 'missing') {
            body.push(h('p', { key: 'missing', style: styles.note }, text.missing))
          } else if (view.status === 'ready') {
            const values = draft ?? view.data?.value ?? {}
            body.push(h('div', { key: 'card', style: styles.card },
              FIELDS.map((field, index) => {
                const value = values[field.key] ?? DEFAULTS[field.key]
                const control = field.type === 'boolean'
                  ? h('input', {
                    type: 'checkbox',
                    checked: value === true,
                    disabled: busy,
                    onChange: (event) => commit(field.key, event.target.checked),
                    style: { width: 18, height: 18, margin: 0, cursor: busy ? 'default' : 'pointer' },
                  })
                  : h('input', {
                    type: 'text',
                    value: typeof value === 'string' ? value : '',
                    disabled: busy,
                    placeholder: 'Glass',
                    onChange: (event) => commit(field.key, event.target.value),
                    style: styles.input,
                  })
                return h('div', {
                  key: field.key,
                  style: index === 0 ? { ...styles.row, borderTop: 'none' } : styles.row,
                },
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: styles.label }, en ? field.en : field.zh),
                  h('div', { style: styles.hint }, en ? field.enHint : field.zhHint)),
                h('div', { style: { flex: '0 0 auto', paddingTop: 2 } }, control))
              })))
            body.push(h('p', { key: 'footer', style: styles.note }, text.footer))
          }

          if (view.error) body.push(h('p', { key: 'error', style: styles.error }, view.error))
          return h('div', null, body)
        }

        try {
          slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'macos-notify',
            order: 35,
            label: text.heading,
          }, Page))
        } catch {
          // A missing seat is reported by the shell; the notification path is unaffected.
        }
      },
    }
  },
})
