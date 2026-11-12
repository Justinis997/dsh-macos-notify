import { spawn, execFile } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const HELPER = join(PKG_DIR, 'helper', 'DSHNotify.app', 'Contents', 'MacOS', 'DSHNotify')

const DEFAULTS = {
  approval: true,
  turnComplete: true,
  error: true,
  questions: true,
  subagentSessions: false,
  skipWhenFocused: true,
  sound: 'default',
  activateOnClick: true,
}

// Every field is `volatile`: the settings service only projects a form for
// fields whose nearest ancestor is volatile (dsh-settings `volatileForm`), and
// a live field applies without remounting the plugin.
const live = (schema) => schema.extra('volatile', true)

export const Config = z.object({
  approval: live(z.boolean().default(true).description('需要你批准权限时通知')),
  turnComplete: live(z.boolean().default(true).description('回合完成时通知')),
  error: live(z.boolean().default(true).description('回合以错误结束时通知')),
  questions: live(z.boolean().default(true).description('我提问、需要你回答时通知')),
  subagentSessions: live(z.boolean().default(false).description('子代理 / workflow 内部会话也通知')),
  skipWhenFocused: live(z.boolean().default(true).description('DSH 窗口在前台时不弹')),
  sound: live(z.string().default('default').description('播放系统默认提示音；留空则静音')),
  activateOnClick: live(z.boolean().default(true).description('点通知时激活 DSH 窗口')),
})

const APP_BUNDLE_ID = 'com.deepseek.dsh'
const APP_PATH = '/Applications/DeepSeek Harness.app'

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// AppleScript string literal: JSON escaping matches AppleScript's own rules for
// the characters we can meet here (quote, backslash, newline, control chars).
const appleScriptString = (value) => JSON.stringify(String(value ?? ''))

const LOG = join(PKG_DIR, '.debug.log')

const trace = (line) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // logging is best effort
  }
}

export function apply(ctx, config = {}) {
  try {
    return applyInner(ctx, config)
  } catch (error) {
    trace(`apply threw: ${error?.stack ?? error}`)
    throw error
  }
}

function applyInner(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  // Volatile fields arrive as live references (`.get()`); plain values and
  // absent keys fall back to the declared defaults.
  const setting = (key) => {
    const raw = config?.[key]
    if (raw !== undefined && raw !== null && typeof raw.get === 'function') return raw.get()
    return raw ?? DEFAULTS[key]
  }
  try {
    writeFileSync(LOG, `[${new Date().toISOString()}] apply ${JSON.stringify(cfg)}\n`)
  } catch {
    // logging is best effort
  }

  let proc = null
  let preferOsa = false
  const inflight = new Map()

  // ---- delivery -------------------------------------------------------

  const osaNotify = (payload) => {
    const parts = [`display notification ${appleScriptString(payload.body)} with title ${appleScriptString(payload.title)}`]
    if (payload.subtitle) parts.push(`subtitle ${appleScriptString(payload.subtitle)}`)
    // The osascript fallback does resolve system sound names, so "default"
    // maps to one of them instead of the literal word.
    const fallbackSound = !payload.sound ? '' : String(payload.sound).trim().toLowerCase() === 'default' ? 'Glass' : payload.sound
    if (fallbackSound) parts.push(`sound name ${appleScriptString(fallbackSound)}`)
    try {
      execFile('/usr/bin/osascript', ['-e', parts.join(' ')], () => {})
    } catch {
      // nothing else to try
    }
  }

  const handleLine = (line) => {
    let answer
    try {
      answer = JSON.parse(line)
    } catch {
      return
    }
    const queued = answer.id ? inflight.get(answer.id) : undefined
    if (answer.id) inflight.delete(answer.id)
    if (answer.ok === false && queued) {
      // The native helper is not permitted to notify; keep the user informed.
      preferOsa = true
      osaNotify(queued)
    }
  }

  const ensureProc = () => {
    if (!existsSync(HELPER)) return null
    if (proc && proc.exitCode === null && !proc.killed) return proc
    try {
      proc = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      proc = null
      return null
    }
    proc.on('error', () => {
      proc = null
    })
    proc.on('exit', () => {
      proc = null
    })
    proc.stdout.setEncoding('utf8')
    let buffer = ''
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) handleLine(line)
        index = buffer.indexOf('\n')
      }
    })
    return proc
  }

  const send = (payload) => {
    if (!payload.title && !payload.body) return
    try {
      appendFileSync(LOG, `[${new Date().toISOString()}] send ${JSON.stringify(payload)}\n`)
    } catch {
      // logging is best effort
    }
    if (preferOsa) {
      osaNotify(payload)
      return
    }
    const child = ensureProc()
    if (!child) {
      preferOsa = true
      osaNotify(payload)
      return
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    inflight.set(id, payload)
    if (inflight.size > 32) inflight.delete(inflight.keys().next().value)
    try {
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
    } catch {
      inflight.delete(id)
      preferOsa = true
      osaNotify(payload)
    }
  }

  const notify = ({ title, subject, body, sound, thread, event }) => {
    const silenced = Array.isArray(cfg.silentEvents) ? cfg.silentEvents : []
    // Layout (variant A): the event type is the notification title, the
    // conversation title is the gray subtitle, the answer text is the body.
    send({
      title,
      subtitle: clip(subject, 90),
      body: clip(body, 220),
      sound: silenced.includes(event) ? '' : String(sound ?? setting('sound')).trim(),
      skipIfFrontmost: setting('skipWhenFocused') ? [APP_BUNDLE_ID] : [],
      thread: thread ?? '',
      activateBundleId: setting('activateOnClick') ? APP_BUNDLE_ID : '',
      appPath: APP_PATH,
    })
  }

  // ---- session helpers ------------------------------------------------

  const isSubagent = (session) => session?.header?.origin === 'subagent'

  const labelOf = (session) => {
    try {
      const title = ctx.get('sessionTitle')?.get(session)?.title
      if (title) return title
    } catch {
      // optional service
    }
    const cwd = session?.header?.cwd
    if (cwd) {
      const parts = String(cwd).split('/').filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }
    return String(session?.id ?? '')
  }

  const lastAssistantText = (session) => {
    try {
      const events = session.ownEvents()
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event.type !== 'assistant/message') continue
        const content = event.data?.message?.content
        if (Array.isArray(content)) {
          const text = content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
            .trim()
          if (text) return text
        }
        if (typeof event.data?.message?.text === 'string' && event.data.message.text.trim()) {
          return event.data.message.text
        }
      }
    } catch {
      // projection is best effort
    }
    return ''
  }

  const requestedByUser = (session) => {
    try {
      const events = session.ownEvents()
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'turn/start') return null
        if (events[i].type === 'user/message') return events[i]
      }
    } catch {
      // ignore
    }
    return null
  }

  // ---- listeners ------------------------------------------------------

  const disposeEvent = ctx.on('session/event', (session, event) => {
    try {
      if (!setting('subagentSessions') && isSubagent(session)) return

      // Approval prompts are agent-scoped events that never reach a root
      // listener, but every ask is also appended to the session log.
      if (event?.type === 'approval/asked') {
        if (!setting('approval')) return
        const data = event.data ?? {}
        trace(`approval/asked tool=${data.toolName ?? '?'}`)
        notify({
          title: '⚠️ 需要你批准',
          subject: labelOf(session),
          body: [data.toolName, data.reason].filter(Boolean).join(' · ') || '有操作在等你确认',
          thread: String(session?.id ?? ''),
          event: 'approval',
        })
        return
      }

      // The question flow has no durable event of its own; the tool call is the
      // reliable signal that the harness is waiting on the user.
      if (event?.type === 'tool/call' && event.data?.name === 'ask_user_question') {
        if (!setting('questions')) return
        let question = ''
        try {
          const args = JSON.parse(event.data.arguments ?? '{}')
          question = args?.questions?.[0]?.question ?? args?.questions?.[0]?.header ?? ''
        } catch {
          // arguments are best effort
        }
        trace('tool/call ask_user_question')
        notify({
          title: '❓ 需要你回答',
          subject: labelOf(session),
          body: question || '有个问题等你回答',
          thread: String(session?.id ?? ''),
          event: 'questions',
        })
        return
      }

      if (event?.type !== 'turn/end') return
      if (!setting('subagentSessions') && isSubagent(session)) return
      const reason = event.data?.reason ?? {}
      const kind = reason.kind
      if (kind === 'error') {
        if (!setting('error')) return
        const message = reason.error?.message ?? reason.error?.code ?? '模型或工具请求失败'
        notify({
          title: '❌ 任务出错',
          subject: labelOf(session),
          body: message,
          thread: String(session?.id ?? ''),
          event: 'error',
        })
        return
      }
      if (kind !== 'completed') return
      if (!setting('turnComplete')) return
      const last = lastAssistantText(session)
      notify({
        title: '✅ 任务完成',
        subject: labelOf(session),
        body: last || `第 ${event.data?.turn ?? 1} 轮已结束`,
        thread: String(session?.id ?? ''),
        event: 'turnComplete',
      })
    } catch (error) {
      trace(`error session/event listener: ${error?.stack ?? error}`)
    }
  })

  // Page policy for the auto form (a client page renders the switches).
  try {
    ctx.get('settings')?.configure?.({ auto: true })
  } catch (error) {
    trace(`settings.configure failed: ${error?.message ?? error}`)
  }

  trace('listeners registered')
  // Warm the helper so the notification permission lands before the first alert.
  ensureProc()

  ctx.effect(() => () => {
    disposeEvent?.()
    try {
      proc?.stdin?.write('{"quit":true}\n')
    } catch {
      // ignore
    }
    try {
      proc?.kill()
    } catch {
      // ignore
    }
    proc = null
  })
}
