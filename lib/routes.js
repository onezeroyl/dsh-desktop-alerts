/**
 * HTTP surface shared by the WPF widget and the in-page overlay.
 *
 * Every mutating route is loopback-only and token-gated: a wrong token must
 * never be able to produce an approval decision.
 */

export const BASE_PATH = '/dsh-desktop-alerts/api'


/** 页面焦点多久没上报就当作「不在前台」：宁可多弹一次，也不要因为页面半挂了而永远静默 */
export const FOCUS_TTL_MS = 12000

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost'])

/* -------------------------------------------------------------------------- *
 * SSE 推送
 *
 * 页面被其他窗口遮挡时，Chromium 会把页面里的定时器节流到 ~1 分钟一次，
 * 只靠 1500ms 轮询去取 open 命令就会出现「点了半天没反应」。
 * 这里用事件流把命令即时推过去；轮询保留为兜底。
 * -------------------------------------------------------------------------- */

const sseClients = new Set()

/** 推给所有已连接的页面（命令在这里只是「有新东西」的信号，页面仍走自己的轮询取数）。 */
export function notifyPages(payload) {
  if (sseClients.size === 0) return 0
  const text = `data: ${JSON.stringify(payload)}\n\n`
  let sent = 0
  for (const entry of [...sseClients]) {
    try {
      entry.res.write(text)
      sent += 1
    } catch {
      try {
        clearInterval(entry.timer)
      } catch {}
      sseClients.delete(entry)
    }
  }
  return sent
}

export function pageSubscriberCount() {
  return sseClients.size
}

function send(res, status, payload) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': 'null',
    })
    res.end(JSON.stringify(payload))
  } catch {
    try {
      res.end()
    } catch {}
  }
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    const finish = (value) => {
      try {
        resolve(value)
      } catch {}
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        try {
          req.destroy()
        } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => finish(undefined))
    req.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
  })
}

function headerToken(req) {
  const raw = req.headers['x-alerts-token']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return undefined
}

export function createApiHandler(deps) {
  const { store, widget, focus, token, settings, version = '0.1.0', getOrigin, trace, celebrate } = deps
  const note = typeof trace === 'function' ? trace : () => {}
  // 引导日志只在前几次带 UA，避免刷屏；同理 /focus 只在值变化时记一行。
  let bootLogCount = 0
  let lastFocus
  const focusSignature = () => `pageFocused=${focus.pageFocused === true} hidden=${focus.hidden === true}`

  return async function handle(req, res) {
    try {
      const remote = String(req.socket?.remoteAddress ?? '')
      if (!LOOPBACK.has(remote)) return send(res, 403, { ok: false, error: 'loopback' })

      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      let route = url.pathname
      if (route.startsWith(BASE_PATH)) route = route.slice(BASE_PATH.length) || '/'
      const method = String(req.method ?? 'GET').toUpperCase()

      if (route === '/health' && method === 'GET') {
        return send(res, 200, {
          ok: true,
          version,
          origin: getOrigin?.() ?? '',
          overlay: { running: widget.running(), pid: widget.pid ?? null },
        })
      }

      // 诊断心跳：页面半每次跑起来都会打一发，用来区分「页面没重载」和「组件没挂载」。
      if (route === '/ping' && (method === 'GET' || method === 'POST')) {
        note('http/ping', `stage=${url.searchParams.get('stage') ?? '-'} ref=${String(req.headers.referer ?? '-').slice(0, 60)}`)
        return send(res, 200, { ok: true })
      }

      // 同源引导：页面半在注入缺失（页面比插件早渲染）时靠它拿 token。
      // 判定放宽到「POST 且没有 Origin/Referer」：本机 Electron 渲染进程的同源 POST
      // 可能两个头都不带（实测 origin=-），而 loopback 已经在本函数开头校验过。
      // 别的网页发 POST 一定带自己的 Origin（≠ expected）→ 仍然 403；
      // 无头的 GET（no-cors 探测）不放行。token 本身就在本机 widget.json 里可读，
      // 因此这里不放宽到「任何来源」、也没必要再严。
      if (route === '/boot' && (method === 'POST' || method === 'GET')) {
        const expected = String(getOrigin?.() ?? '').replace(/\/+$/, '')
        const originHeader = String(req.headers.origin ?? '')
        const referer = String(req.headers.referer ?? '')
        const headerless = originHeader === '' && referer === ''
        const sameOrigin =
          expected !== '' &&
          (originHeader === expected || referer.startsWith(expected + '/') || (headerless && method === 'POST'))
        bootLogCount += 1
        note(
          'http/boot',
          `sameOrigin=${sameOrigin} method=${method} origin=${originHeader || '-'} ref=${referer ? referer.slice(0, 48) : '-'}`
            + (bootLogCount <= 3 ? ` ua=${String(req.headers['user-agent'] ?? '-').slice(0, 40)}` : ''),
        )
        if (!sameOrigin) return send(res, 403, { ok: false, error: 'origin' })
        return send(res, 200, { ok: true, origin: expected, base: BASE_PATH, token })
      }

      // Same-origin, side-effect free: the page reports whether it currently has focus.
      let body
      if (method === 'POST') body = await readJson(req)

      if (route === '/focus' && method === 'POST') {
        // pageHidden 来自 document.hidden：窗口被最小化/被遮住/切到别的标签页都算"看不到"
        let changed = false
        if (body && typeof body.pageFocused === 'boolean') {
          if (focus.pageFocused !== body.pageFocused) changed = true
          focus.pageFocused = body.pageFocused
          focus.at = Date.now()
        }
        if (body && typeof body.pageHidden === 'boolean') {
          if (focus.hidden !== body.pageHidden) changed = true
          focus.hidden = body.pageHidden
        }
        if (changed && lastFocus !== focusSignature()) {
          lastFocus = focusSignature()
          note('http/focus', `${lastFocus} (页面半已连上)`)
        }
        return send(res, 200, { ok: true })
      }

      const provided =
        headerToken(req) ??
        url.searchParams.get('token') ??
        (body && typeof body.token === 'string' ? body.token : undefined)
      if (!provided || provided !== token) return send(res, 401, { ok: false, error: 'token' })

      // 事件流：页面开着就常驻，宿主有命令时即时推送（页面收到后立刻跑一轮轮询）
      if (route === '/events' && method === 'GET') {
        const entry = sseAttach(req, res)
        if (!entry) return send(res, 500, { ok: false, error: 'sse' })
        note('http/events', `attached subscribers=${sseClients.size}`)
        return undefined
      }

      if (route === '/state' && method === 'GET') {
        // 可见性随 /state 心跳上报（focused=1/0 & hidden=1/0）：只记变化日志，
        // 但每次都要刷新时间戳，否则页面开着也会被判成"不可见"。
        const focusedParam = url.searchParams.get('focused')
        const hiddenParam = url.searchParams.get('hidden')
        if (focusedParam !== null || hiddenParam !== null) {
          if (focusedParam !== null) focus.pageFocused = focusedParam === '1'
          if (hiddenParam !== null) focus.hidden = hiddenParam === '1'
          focus.at = Date.now()
          if (lastFocus !== focusSignature()) {
            lastFocus = focusSignature()
            note('http/focus', `${lastFocus} (页面半已连上)`)
          }
        }
        // 页面窗口的屏幕矩形：原生层据此判断页面在哪块屏上，其余屏幕继续放特效
        const rectParam = url.searchParams.get('wrect')
        if (rectParam !== null) {
          const parts = rectParam.split(',').map((value) => Number.parseFloat(value))
          if (parts.length === 4 && parts.every((value) => Number.isFinite(value)) && parts[2] > 0 && parts[3] > 0) {
            focus.rect = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
          } else {
            focus.rect = null
          }
        }
        const fresh = Date.now() - (focus.at ?? 0) < FOCUS_TTL_MS
        // 页面自己会渲染特效；只有"页面看不到"时才由原生特效层接管
        const pageVisible = fresh && focus.pageFocused === true && focus.hidden !== true
        const snapshot = store.snapshot({
          overlay: { running: widget.running(), pid: widget.pid ?? null },
          page: {
            visible: pageVisible,
            focused: fresh && focus.pageFocused === true,
            hidden: focus.hidden === true,
            at: focus.at ?? 0,
            rect: fresh && focus.rect ? focus.rect : null,
          },
          focus: { pageFocused: fresh && focus.pageFocused === true },
          settings,
          // 庆祝信号：SSE 断线时页面靠轮询也能补放
          celebrate: typeof celebrate === 'function' ? celebrate() : [],
        })
        return send(res, 200, snapshot)
      }

      if (route === '/answer' && method === 'POST') {
        // 兼容端点：卡片已经删掉，页面/工具不该再调它；留着只为老版本页面不 404。
        return send(res, 410, { ok: false, error: 'gone: 审批请在 DSH 页面处理' })
      }

      if (route === '/open' && method === 'POST') {
        return send(res, 410, { ok: false, error: 'gone: 卡片已移除' })
      }

      if (route === '/ack' && method === 'POST') {
        return send(res, 410, { ok: false, error: 'gone: 卡片已移除' })
      }

      return send(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      return send(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
    }
  }
}