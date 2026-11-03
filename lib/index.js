/**
 * dsh-desktop-alerts —— Host half.
 *
 * Intercepts approval requests so a desktop widget (or the in-page overlay)
 * can answer them, and reports turn completion / errors as desktop notices.
 *
 * Design rules that matter:
 * - The official page approval card always stays available: we call `next()`
 *   immediately and race it against the widget decision. Whoever answers first
 *   wins and the other side is withdrawn from our UI.
 * - Nothing here may throw into the approval path. A broken widget must look
 *   exactly like "the plugin was never installed".
 * - Approvals are never auto-answered: an expired widget entry only stops being
 *   displayed; the request keeps waiting on the official card.
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AlertStore } from './alert-store.js'
import { BASE_PATH, FOCUS_TTL_MS, createApiHandler, notifyPages } from './routes.js'
import { WidgetLauncher } from './widget-launcher.js'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VERSION = '0.3.7'

export const name = 'dsh-desktop-alerts'

const DEFAULTS = {
  enabled: true,
  debug: false,
  locale: 'zh',
  triggers: { approval: true, planReview: true, question: true, done: true, error: true },
  // 完成/出错时的庆祝信号（烟花 + 边闪）：cooldownMs 去抖，避免连续 await 刷屏
  celebrate: { enabled: true, cooldownMs: 800 },
  effects: { fireworks: true, edgeFlash: true },
  // 未读高亮：不自己记账，纯 CSS 跟着 DSH 自己的未读点走（见 client.js）
  unreadHighlight: { enabled: true },
  quietHours: { enabled: false, start: '23:00', end: '08:00' },
  sound: { enabled: false },
  pendingTtlMs: 300_000,
  overlay: { autoStart: true },
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merge(base, patch) {
  if (!isPlainObject(patch)) return { ...base }
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value
  }
  return out
}

function makeLog(ctx) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-desktop-alerts') : undefined
    if (logger && typeof logger.info === 'function') return (...args) => logger.info(...args)
    if (logger && typeof logger.debug === 'function') return (...args) => logger.debug(...args)
  } catch {}
  return () => {}
}

function clip(text, max = 400) {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

const ARG_KEYS = ['command', 'cmd', 'script', 'argv', 'path', 'file_path', 'filePath', 'target', 'pattern', 'query', 'url', 'prompt', 'description']

function summarizeArgs(args) {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') return clip(args)
  if (Array.isArray(args)) return clip(args.join(' '))
  if (typeof args === 'object') {
    for (const key of ARG_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return clip(value)
      if (Array.isArray(value) && value.length > 0) return clip(value.map(String).join(' '))
    }
    try {
      return clip(JSON.stringify(args))
    } catch {
      return ''
    }
  }
  return clip(String(args))
}

function pickReason(displayReason, fallback) {
  if (displayReason && typeof displayReason === 'object') {
    for (const key of ['zh', 'zh-CN', 'en']) {
      const value = displayReason[key]
      if (typeof value === 'string' && value.trim()) return clip(value)
    }
  }
  return clip(fallback ?? '')
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

export function apply(ctx, config) {
  let cfg
  try {
    cfg = merge(DEFAULTS, config ?? {})
  } catch {
    cfg = merge(DEFAULTS, {})
  }
  if (cfg.enabled === false) return

  const log = makeLog(ctx)

  // 只在 cfg.debug 打开时把事件写进 host.log（默认静默，零 IO）
  const trace = (() => {
    if (!cfg.debug) return () => {}
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const dir = join(base, 'dsh-desktop-alerts')
    const file = join(dir, 'host.log')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
    return (event, detail = '') => {
      try {
        appendFileSync(file, `${new Date().toISOString()}  ${event}  ${detail}\n`, 'utf8')
      } catch {}
    }
  })()

  const store = new AlertStore({ pendingTtlMs: cfg.pendingTtlMs })
  const token = randomBytes(16).toString('hex')
  // 页面半的上报状态。页面自己会渲染特效，只有在它看不到时才由原生覆盖层接管：
  // 所以这里既记焦点/可见性，也记页面窗口在屏幕上的矩形（光罩要跳过页面所在那块屏）。
  const focus = { pageFocused: false, hidden: false, at: 0, rect: null }
  const pageFocusFresh = () => focus.pageFocused === true && Date.now() - (focus.at ?? 0) < FOCUS_TTL_MS
  const toolArgs = new Map()
  const runningSince = new Map()

  /* ------------------------------------------------------------------------ *
   * 庆祝信号（烟花 / 出错红闪）
   *
   * 关键：这里**不判断**页面在前台还是后台——前台页面自己画，后台由原生覆盖层画，
   * 谁画由各自读 /state 决定。宿主只负责把"这一刻发生了"记下来并广播（SSE + 轮询兜底）。
   * ------------------------------------------------------------------------ */

  const CELEBRATE_TTL_MS = 15000
  const CELEBRATE_MAX = 10
  const celebrateQueue = []
  let celebrateSeq = 0
  let lastCelebrateAt = 0

  const listCelebrate = () => {
    const now = Date.now()
    while (celebrateQueue.length > 0 && now - celebrateQueue[0].at > CELEBRATE_TTL_MS) celebrateQueue.shift()
    return celebrateQueue.map((item) => ({ ...item }))
  }

  const pushCelebrate = (entry) => {
    try {
      if (cfg.celebrate?.enabled === false) return
      if (cfg.effects?.fireworks === false && cfg.effects?.edgeFlash === false) return
      const cooldownMs = Number(cfg.celebrate?.cooldownMs ?? 800)
      const now = Date.now()
      if (Number.isFinite(cooldownMs) && cooldownMs > 0 && now - lastCelebrateAt < cooldownMs) return
      lastCelebrateAt = now
      celebrateSeq += 1
      const item = {
        id: `x-${celebrateSeq.toString(36)}`,
        kind: entry?.kind === 'error' ? 'error' : 'done',
        sessionId: String(entry?.sessionId ?? ''),
        sessionTitle: String(entry?.sessionTitle ?? ''),
        detail: String(entry?.detail ?? ''),
        at: now,
      }
      celebrateQueue.push(item)
      while (celebrateQueue.length > CELEBRATE_MAX) celebrateQueue.shift()
      const pushed = notifyPages({ type: 'celebrate', item })
      trace('celebrate', `kind=${item.kind} session=${item.sessionId} pushed=${pushed}`)
    } catch (error) {
      log(`celebrate push failed: ${error?.message ?? error}`)
    }
  }

  const widget = new WidgetLauncher({ pkgRoot: PKG_ROOT, log })
  let origin = ''

  /* ------------------------------------------------------------------------ *
   * 会话信息（标题 / 工作目录）
   *
   * 未读高亮没有服务端记账：DSH 自己的列表里就有 `<span data-state="done">`，
   * 页面半用 CSS `:has()` 跟着它走，所以这里只留标题/目录这类只读查询。
   * ------------------------------------------------------------------------ */

  const service = (key) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
    } catch {
      return undefined
    }
  }

  const sessionOf = (agent) => {
    try {
      return service('sessions')?.get?.(agent?.id)
    } catch {
      return undefined
    }
  }

  const titleOf = (agent) => {
    try {
      const session = sessionOf(agent)
      if (!session) return ''
      const snapshot = service('sessionTitle')?.get?.(session)
      if (typeof snapshot === 'string') return snapshot
      if (snapshot && typeof snapshot.title === 'string') return snapshot.title
    } catch {}
    return ''
  }

  const cwdOf = (agent) => {
    try {
      const session = sessionOf(agent)
      if (!session) return ''
      const view = service('workingDirectory')?.get?.(session)
      if (typeof view === 'string') return view
      if (view && typeof view.path === 'string') return view.path
      if (view && typeof view.cwd === 'string') return view.cwd
    } catch {}
    return ''
  }

  const isRootAgent = (agent) => {
    try {
      const agents = service('agents')
      if (!agents || typeof agents.roots !== 'function') return true
      const roots = agents.roots()
      if (!Array.isArray(roots) || roots.length === 0) return true
      return roots.some((root) => String(root?.id) === String(agent?.id))
    } catch {
      return true
    }
  }

  const inQuietHours = () => {
    try {
      if (!cfg.quietHours?.enabled) return false
      const [startHour, startMinute] = String(cfg.quietHours.start ?? '23:00').split(':').map(Number)
      const [endHour, endMinute] = String(cfg.quietHours.end ?? '08:00').split(':').map(Number)
      if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) return false
      const now = new Date()
      const minutes = now.getHours() * 60 + now.getMinutes()
      const start = startHour * 60 + startMinute
      const end = endHour * 60 + endMinute
      return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
    } catch {
      return false
    }
  }

  // Getters so `/state` always reflects the current wall clock and config.
  const settings = {
    get quiet() {
      return inQuietHours()
    },
    get sound() {
      return cfg.sound?.enabled === true
    },
    get locale() {
      return cfg.locale ?? 'zh'
    },
    // 特效总开关：烟花受 celebrate.enabled + effects.fireworks 双重约束
    get fireworks() {
      return cfg.celebrate?.enabled !== false && cfg.effects?.fireworks !== false
    },
    get edgeFlash() {
      return cfg.effects?.edgeFlash !== false
    },
    // 未读整行深绿的高亮开关（纯 CSS 实现，见 client.js 的 unreadCss）
    get unreadHighlight() {
      return cfg.unreadHighlight?.enabled !== false
    },
  }

  const ensureWidget = () => {
    try {
      if (cfg.overlay?.autoStart === false) return
      if (!origin) return
      trace('overlay/ensure', `origin=${origin} running=${widget.running()}`)
      widget.ensure({
        origin,
        base: BASE_PATH,
        token,
        locale: cfg.locale ?? 'zh',
        version: VERSION,
      })
    } catch (error) {
      log(`overlay ensure failed: ${error?.message ?? error}`)
    }
  }

  // ---------------------------------------------------------------- tool args
  // `approval/request` only carries the tool name; the parsed arguments come
  // from the pre-execute waterfall, so cache them by call id.
  try {
    ctx.on(
      'tools/pre-execute',
      (exec, next) => {
        try {
          const callId = exec?.callId
          if (callId !== undefined && callId !== null) {
            toolArgs.set(String(callId), { name: exec?.name, args: exec?.arguments, at: Date.now() })
            trace('tools/pre-execute', `tool=${exec?.name} callId=${callId}`)
            if (toolArgs.size > 200) {
              const oldest = toolArgs.keys().next().value
              if (oldest !== undefined) toolArgs.delete(oldest)
            }
          }
        } catch {}
        return next()
      },
      { global: true },
    )
  } catch (error) {
    log(`tools/pre-execute attach failed: ${error?.message ?? error}`)
  }

  // ---------------------------------------------------------------- approvals
  try {
    ctx.on(
      'approval/request',
      async (req, next) => {
        let item
        try {
          trace(
            'approval/request',
            `tool=${req?.toolName} callId=${req?.callId} agent=${req?.agent?.id} quiet=${inQuietHours()} triggers=${cfg.triggers?.approval}`,
          )
          if (!cfg.triggers?.approval) return await next()
          if (inQuietHours()) return await next()
          const callId = req?.callId
          const cached = callId !== undefined && callId !== null ? toolArgs.get(String(callId)) : undefined
          const summary = summarizeArgs(cached?.args)
          item = store.addApproval({
            sessionId: req?.agent?.id ?? '',
            sessionTitle: titleOf(req?.agent),
            cwd: cwdOf(req?.agent),
            toolName: req?.toolName ?? cached?.name ?? '',
            summary,
            reason: pickReason(req?.displayReason, req?.reason),
          })
          ensureWidget()
        } catch (error) {
          log(`approval capture failed: ${error?.message ?? error}`)
          return await next()
        }

        // 请求被取消（页面批准/拒绝、超时）时把这条从待办里撤掉
        try {
          req?.signal?.addEventListener?.('abort', () => store.drop(item.id), { once: true })
        } catch {}
        try {
          return await next()
        } finally {
          store.drop(item.id)
        }
      },
      { global: true, prepend: true },
    )
  } catch (error) {
    log(`approval hook attach failed: ${error?.message ?? error}`)
  }

  // ------------------------------------------------------------- plan review
  try {
    ctx.on(
      'user-questions/request',
      async (request, next) => {
        let item
        try {
          // 这条事件不只承载「计划确认」，`ask_user_question`（让你选/填的那种提问）也走它：
          // 只要对话停在等你回答的地方，屏幕就该亮——否则切走页面就彻底没提醒了。
          const questions = Array.isArray(request?.questions)
            ? request.questions
            : (request?.question ? [request.question] : [])
          const planQuestion = questions.find((question) => question?.intent?.kind === 'plan-review')
          const first = planQuestion ?? questions[0]
          trace(
            'user-questions/request',
            `agent=${request?.agent?.id} n=${questions.length} plan=${Boolean(planQuestion)} quiet=${inQuietHours()}`,
          )
          if (first && !inQuietHours()) {
            const isPlan = Boolean(planQuestion)
            if (isPlan ? cfg.triggers?.planReview : cfg.triggers?.question) {
              item = store.addReadOnly({
                kind: isPlan ? 'plan-review' : 'question',
                sessionId: request?.agent?.id ?? '',
                sessionTitle: titleOf(request?.agent),
                cwd: cwdOf(request?.agent),
                summary: clip(first?.question ?? first?.header ?? ''),
                reason: clip(first?.detail ?? ''),
              })
              ensureWidget()
            }
          }
        } catch (error) {
          log(`user-questions capture failed: ${error?.message ?? error}`)
        }
        try {
          // 请求被取消（页面已答、超时）时撤掉，别让绿光一直亮着
          request?.signal?.addEventListener?.('abort', () => { if (item) store.drop(item.id) }, { once: true })
        } catch {}
        try {
          return await next()
        } finally {
          if (item) store.drop(item.id)
        }
      },
      { global: true, prepend: true },
    )
  } catch (error) {
    log(`user-questions hook attach failed: ${error?.message ?? error}`)
  }

  // ------------------------------------------------------- completion / error
  try {
    ctx.on(
      'agent/status',
      (payload) => {
        try {
          const agent = payload?.agent
          if (!agent?.id) return
          trace(
            'agent/status',
            `agent=${agent.id} status=${payload.status} root=${isRootAgent(agent)} focus=${focus.pageFocused} done=${cfg.triggers?.done}`,
          )
          const sessionId = String(agent.id)
          if (payload.status === 'running') {
            runningSince.set(sessionId, Date.now())
            return
          }
          const startedAt = runningSince.get(sessionId)
          runningSince.delete(sessionId)
          if (!cfg.triggers?.done) return
          if (!isRootAgent(agent)) return
          const durationMs = startedAt ? Date.now() - startedAt : null
          const sessionTitle = titleOf(agent)
          // 完成信号在任何门控之前生成：前台也放（页面画），后台更放（覆盖层画）
          if (!inQuietHours()) pushCelebrate({ kind: 'done', sessionId, sessionTitle, detail: formatDuration(durationMs ?? 0) })
          ensureWidget()
        } catch (error) {
          log(`status capture failed: ${error?.message ?? error}`)
        }
      },
      { global: true },
    )
  } catch (error) {
    log(`agent/status hook attach failed: ${error?.message ?? error}`)
  }

  try {
    ctx.on(
      'agent/error',
      (payload) => {
        try {
          if (!cfg.triggers?.error) return
          const agent = payload?.agent
          if (!agent?.id) return
          trace('agent/error', `agent=${agent.id} root=${isRootAgent(agent)} error=${String(payload?.error?.message ?? payload?.error ?? '').slice(0, 120)}`)
          if (!isRootAgent(agent)) return
          if (inQuietHours()) return
          const raw = payload?.error
          const text = typeof raw === 'string' ? raw : raw?.message ?? '未知错误'
          // 出错走一次性红闪（burst），不是烟花
          pushCelebrate({ kind: 'error', sessionId: String(agent.id), sessionTitle: titleOf(agent), detail: clip(text, 120) })
          ensureWidget()
        } catch (error) {
          log(`error capture failed: ${error?.message ?? error}`)
        }
      },
      { global: true },
    )
  } catch (error) {
    log(`agent/error hook attach failed: ${error?.message ?? error}`)
  }

  // -------------------------------------------------------------- HTTP surface
  try {
    ctx.inject(['webServer'], (scoped) => {
      try {
        const webServer = scoped.webServer
        try {
          origin = webServer?.getOrigin?.() ?? ''
        } catch {
          origin = ''
        }
        const handler = createApiHandler({
          store,
          widget,
          focus,
          token,
          settings,
          version: VERSION,
          getOrigin: () => origin,
          trace,
          celebrate: listCelebrate,
        })
        scoped.effect(() => webServer.register({ kind: 'prefix', path: BASE_PATH, handler }))
        scoped.effect(() =>
          scoped.on('webserver/index-inject', (table) => {
            try {
              if (!Array.isArray(table)) return
              table.push({
                kind: 'global',
                name: '__DSH_DESKTOP_ALERTS__',
                value: { origin, base: BASE_PATH, token },
              })
              // 把 origin/base/token 注入页面：页面半靠它直连本机 HTTP，不重复走 boot
              trace('index-inject', `rows=${table.length}`)
            } catch {} 
          }),
        )
        scoped.effect(() => {
          ensureWidget()
          return () => widget.stop()
        })
        log(`HTTP surface ready at ${origin}${BASE_PATH}`)
      } catch (error) {
        log(`webServer wiring failed: ${error?.message ?? error}`)
      }
    })
  } catch (error) {
    log(`webServer inject failed: ${error?.message ?? error}`)
  }
}

