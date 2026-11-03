/**
 * dsh-desktop-alerts · client 半（页面内特效：烟花 + 审批红闪）
 *
 * 契约见 ../CONTRACT.md §4 / §4.2：
 *  - 只注册 shell.overlay 槽，id = desk-alerts，不替换任何既有 UI；
 *  - token 来自 window.__DSH_DESKTOP_ALERTS__ = { origin, base, token }，不存在则向 /boot 自举；
 *  - 每 1500ms 上报 /focus（pageFocused + pageHidden）并取 /state；
 *  - 任务完成 → 烟花；审批/计划待处理 → 四边呼吸红闪；出错 → 一次性红闪；
 *  - 页面不可见时不渲染特效（由原生覆盖层接管），可见后补放一次被跳过的烟花；
 *  - 所有请求 2s 超时 + try/catch 静默失败，任何异常都不冒泡到页面。
 *
 * 本文件是纯 JS（无构建、无 TS），唯一外部依赖是 require('react')。
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-alerts',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */

    const DEFAULT_BASE = '/dsh-desktop-alerts/api';
    const POLL_MS = 1500;
    const REQUEST_TIMEOUT_MS = 2000;
    const FIREWORK_MS = 2200;
    const FIREWORK_BURST_MS = 2800;
    const EDGE_Z = '2147482990';
    const FX_Z = '2147482995';
    const SSE_RETRY_MS = 5000;

    /** 由 apply 创建、由特效组件订阅的轮询控制器 */
    let shared = null;
    /** apply 收到的 ctx，供组件自愈时补建 controller */
    let sharedCtx = null;

    /* ------------------------------------------------------------------ *
     * 配置：宿主注入的 window.__DSH_DESKTOP_ALERTS__
     * ------------------------------------------------------------------ */

    function readConfig() {
      try {
        const raw = window.__DSH_DESKTOP_ALERTS__;
        if (!raw || typeof raw !== 'object') return null;
        const base = typeof raw.base === 'string' && raw.base.trim() ? raw.base.trim() : DEFAULT_BASE;
        return {
          origin: typeof raw.origin === 'string' ? raw.origin.replace(/\/+$/, '') : '',
          base: base.replace(/\/+$/, ''),
          token: typeof raw.token === 'string' ? raw.token : '',
        };
      } catch (_) {
        return null;
      }
    }

    /** 同源兜底：注入缺失时向 /boot 要 token（只认本页 Origin，别的本地页面 403） */
    let bootCfg = null;
    let booting = false;

    async function ensureBoot() {
      if (bootCfg) return bootCfg;
      if (booting) return null;
      booting = true;
      try {
        const data = await bootFetch();
        if (data && typeof data === 'object' && typeof data.token === 'string' && data.token) {
          bootCfg = {
            origin: typeof data.origin === 'string' ? data.origin.replace(/\/+$/, '') : '',
            base:
              typeof data.base === 'string' && data.base.trim()
                ? data.base.trim().replace(/\/+$/, '')
                : DEFAULT_BASE,
            token: data.token,
          };
        }
      } catch (_) {
        /* 忽略 */
      } finally {
        booting = false;
      }
      return bootCfg;
    }

    function currentConfig() {
      return readConfig() || bootCfg;
    }

    /** 同源相对路径优先（不产生 CORS 问题），base 为绝对 URL 时原样使用 */
    function urlFor(cfg, path) {
      const base = cfg && cfg.base ? cfg.base : DEFAULT_BASE;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return base + path;
      if (base.charAt(0) === '/') return base + path;
      return (cfg && cfg.origin ? cfg.origin : '') + '/' + base + path;
    }

    function pickFetch() {
      try {
        if (typeof window !== 'undefined' && window && typeof window.fetch === 'function') {
          return function (url, options) {
            return window.fetch(url, options);
          };
        }
        if (typeof fetch === 'function') {
          return function (url, options) {
            return fetch(url, options);
          };
        }
      } catch (_) {
        /* 忽略 */
      }
      return null;
    }

    /** 诊断心跳：让宿主日志能区分「页面没重载」/「组件没挂载」。失败完全静默。 */
    function ping(stage) {
      try {
        const f = pickFetch();
        if (!f) return;
        const p = f(DEFAULT_BASE + '/ping?stage=' + encodeURIComponent(stage), {
          method: 'GET',
          cache: 'no-store',
          keepalive: true,
        });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (_) {
        /* 忽略 */
      }
    }

    /**
     * /boot 自举用的最小请求：不能复用控制器内部的 request()（那个在 createController
     * 作用域里，模块级调用会 ReferenceError 且被 catch 吞掉，导致「永远不轮询」）。
     */
    function bootFetch() {
      return new Promise(function (resolve) {
        let done = false;
        let timerId = null;
        const finish = function (value) {
          if (done) return;
          done = true;
          if (timerId !== null) {
            try {
              clearTimeout(timerId);
            } catch (_) {
              /* 忽略 */
            }
            timerId = null;
          }
          resolve(value);
        };
        const f = pickFetch();
        if (!f) {
          finish(null);
          return;
        }
        timerId = setTimeout(function () {
          finish(null);
        }, REQUEST_TIMEOUT_MS);
        try {
          const p = f(DEFAULT_BASE + '/boot', jsonInit({}));
          if (!p || typeof p.then !== 'function') {
            finish(null);
            return;
          }
          p.then(
            function (res) {
              try {
                const data = res && typeof res.json === 'function' ? res.json() : null;
                if (data && typeof data.then === 'function') {
                  data.then(finish, function () {
                    finish(null);
                  });
                  return;
                }
                finish(data);
              } catch (_) {
                finish(null);
              }
            },
            function () {
              finish(null);
            },
          );
        } catch (_) {
          finish(null);
        }
      });
    }

    function jsonInit(body) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    }

    /* ------------------------------------------------------------------ *
     * 页面可见性
     * ------------------------------------------------------------------ */

    function pageHidden() {
      try {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) return false;
        return doc.hidden === true || doc.visibilityState === 'hidden';
      } catch (_) {
        return false;
      }
    }

    function pageFocused() {
      try {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) return false;
        const focused = typeof doc.hasFocus === 'function' ? !!doc.hasFocus() : false;
        return focused && !pageHidden();
      } catch (_) {
        return false;
      }
    }

    /**
     * 谁来画特效：页面在前台 → 页面画（GPU 合成，最省）；否则交给原生覆盖层。
     * 只有原生层没在跑时才回落到页面画，避免"什么都没看到"。
     */
    function shouldRenderHere(snapshot) {
      try {
        const overlayRunning = snapshot && snapshot.overlay && snapshot.overlay.running === true;
        const here = !pageHidden() && pageFocused();
        if (here) return true;
        return !overlayRunning;
      } catch (_) {
        return true;
      }
    }

    function prefersReducedMotion() {
      try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (_) {
        return false;
      }
    }

    function detectDark() {
      try {
        const doc = typeof document !== 'undefined' ? document : null;
        if (doc && doc.documentElement && doc.documentElement.dataset) {
          const theme = doc.documentElement.dataset.dshTheme || doc.documentElement.dataset.theme;
          if (theme === 'dark') return true;
          if (theme === 'light') return false;
        }
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          return !!window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
      } catch (_) {
        /* 忽略 */
      }
      return true;
    }

    /* ------------------------------------------------------------------ *
     * 颜色
     * ------------------------------------------------------------------ */

    function makePalette(dark) {
      if (dark) {
        return ['#0A84FF', '#5E5CE6', '#BF5AF2', '#FF375F', '#FF9F0A', '#30D158', '#64D2FF', '#FFD60A'];
      }
      return ['#007AFF', '#4B47D6', '#9B3BD1', '#E0245E', '#F08C00', '#248A3D', '#0A84FF', '#C7A100'];
    }

    /**
     * 从快照算边缘闪光的语义层级：只维持一层
     * approval / question（深绿呼吸）> plan（琥珀呼吸）> 空。
     * question = `ask_user_question` 那种“等你选/填”，同样是要你处理，所以跟审批同色。
     */
    function edgeLevelOf(snapshot, now) {
      try {
        const pending = snapshot && Array.isArray(snapshot.pending) ? snapshot.pending : null;
        if (!pending || !pending.length) return '';
        let plan = false;
        for (let i = 0; i < pending.length; i += 1) {
          const item = pending[i];
          if (!item || typeof item !== 'object') continue;
          if (typeof item.expiresAt === 'number' && item.expiresAt > 0 && item.expiresAt < now) continue;
          if (item.kind === 'approval' || item.kind === 'question') return 'approval';
          if (item.kind === 'plan-review') plan = true;
        }
        return plan ? 'plan' : '';
      } catch (_) {
        return '';
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式（只包含特效需要的规则，无卡片）
     * ------------------------------------------------------------------ */

    const CSS_TEXT = [
      '@keyframes dsh-da-edge-breathe{0%,100%{opacity:.5}50%{opacity:1}}',
      '@keyframes dsh-da-edge-burst{0%{opacity:0}14%{opacity:.9}46%{opacity:.2}62%{opacity:.8}100%{opacity:0}}',
      '@keyframes dsh-da-glow{0%{opacity:0;transform:scale(.97)}30%{opacity:.85}100%{opacity:0;transform:scale(1.02)}}',
      [
        // 四条独立窄带（不是一圈径向渐变）：径向渐变在四个角会饱和成亮块，角上比边中亮得多。
        // 上下带撑满宽度，左右带从上下带内侧开始 ⇒ 角上只有一条带，四条边亮度一致。
        '.dsh-da-edge{position:fixed;inset:0;pointer-events:none;z-index:' + EDGE_Z + ';',
        'opacity:0;will-change:opacity;',
        'box-shadow:inset 0 0 0 var(--dsh-da-edge-line) var(--dsh-da-line);',
        'background:',
        'linear-gradient(to bottom,var(--dsh-da-band) 0,transparent 100%) top/100% var(--dsh-da-band-w) no-repeat,',
        'linear-gradient(to top,var(--dsh-da-band) 0,transparent 100%) bottom/100% var(--dsh-da-band-w) no-repeat,',
        'linear-gradient(to right,var(--dsh-da-band) 0,transparent 100%) left var(--dsh-da-band-w)/var(--dsh-da-band-w) calc(100% - var(--dsh-da-band-w) * 2) no-repeat,',
        'linear-gradient(to left,var(--dsh-da-band) 0,transparent 100%) right var(--dsh-da-band-w)/var(--dsh-da-band-w) calc(100% - var(--dsh-da-band-w) * 2) no-repeat;',
        'animation:dsh-da-edge-breathe var(--dsh-da-dur) ease-in-out infinite;}',
      ].join(''),
      '.dsh-da-edge[data-mode="burst"]{animation:dsh-da-edge-burst var(--dsh-da-dur) ease-out 1;}',
      '.dsh-da-fx-host{position:fixed;inset:0;pointer-events:none;z-index:' + FX_Z + ';}',
      '.dsh-da-fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;display:block;}',
      [
        '.dsh-da-fx-glow{position:fixed;inset:0;pointer-events:none;z-index:' + FX_Z + ';',
        'background:radial-gradient(60% 45% at 50% 32%,var(--dsh-da-fx-glow) 0%,transparent 70%);',
        'animation:dsh-da-glow 1300ms ease-out 1;}',
      ].join(''),
      '@media (prefers-reduced-motion: reduce){.dsh-da-edge{animation:none!important;opacity:.3}.dsh-da-fx-glow{animation:none!important;opacity:.5}}',
    ].join('\n');

    /* ------------------------------------------------------------------------ *
     * 会话列表未读高亮（纯 CSS）
     *
     * 直接读 DSH 自己的状态点：未读行的 leading 单元格里是
     *   <span class="_dot_1i3xo_2" data-state="done" aria-hidden="true">
     * 所以用 :has([data-state="done"]) 整行染色——DSH 什么时候把小点去掉，
     * 高亮就什么时候消失，不需要我们猜"读没读"。
     * 行的锚点是 data-row-key="session:<sessionId>"，不依赖任何哈希类名。
     * ------------------------------------------------------------------------ */

    function unreadCss(enabled) {
      if (!enabled) return '';
      const row = '[data-row-key^="session:"]:has([data-state="done"],[data-state="unread"])';
      return [
        // 深色主题：深绿底 + 左侧深绿竖条
        row + '{background-color:rgba(21,128,61,0.44)!important;',
        'box-shadow:inset 3px 0 0 0 #22C55E!important;border-radius:8px!important;}',
        row + ':hover{background-color:rgba(21,128,61,0.58)!important;}',
        // 浅色主题：降低透明度，保证深色文字还有对比度
        '@media (prefers-color-scheme: light){',
        row + '{background-color:rgba(21,128,61,0.24)!important;}',
        row + ':hover{background-color:rgba(21,128,61,0.34)!important;}}',
      ].join('');
    }

    /* ------------------------------------------------------------------ *
     * 边缘红闪层
     * ------------------------------------------------------------------ */

    function EdgeFlashLayer(props) {
      const level = props && props.level ? props.level : '';
      if (!level) return null;
      const burst = level === 'burst';
      const plan = level === 'plan';
      // 审批不再是刺眼的红：改成深绿（#15803D 系），出错保留红色但同样收窄
      const tint = plan ? '255,159,10' : burst ? '255,69,58' : '21,128,61';
      const style = {
        '--dsh-da-line': 'rgba(' + tint + ',0.55)',
        '--dsh-da-band': 'rgba(' + tint + ',0.45)',
        '--dsh-da-glow': 'rgba(' + tint + ',0.12)',
        '--dsh-da-band-w': '58px',
        '--dsh-da-edge-line': '1px',
        '--dsh-da-dur': burst ? '1400ms' : '1600ms',
      };
      return h('div', {
        className: 'dsh-da-edge',
        'data-mode': burst ? 'burst' : 'breathe',
        'data-level': level,
        style: style,
      });
    }

    /* ------------------------------------------------------------------ *
     * 烟花层
     * ------------------------------------------------------------------ */

    const SHOT_AT = [0, 470, 980];
    const SHOT_X = [0.3, 0.63, 0.46];
    const SHOT_Y = [0.27, 0.21, 0.34];
    const SHOT_COUNT = [175, 195, 165];
    const MAX_PARTICLES = 560;

    function FireworksLayer(props) {
      const hostRef = React.useRef(null);

      React.useEffect(
        function () {
          const doc = typeof document !== 'undefined' ? document : null;
          const host = hostRef.current;
          if (!doc || !host) return undefined;

          // 减少动效：只闪一次静态辉光，不跑粒子
          if (prefersReducedMotion()) {
            const glow = doc.createElement('div');
            glow.className = 'dsh-da-fx-glow';
            const rgba = detectDark() ? 'rgba(10,132,255,0.30)' : 'rgba(0,122,255,0.22)';
            glow.style.setProperty('--dsh-da-fx-glow', rgba);
            host.appendChild(glow);
            const timer = setTimeout(function () {
              try {
                host.removeChild(glow);
              } catch (_) {
                /* 忽略 */
              }
            }, 1400);
            return function cleanup() {
              try {
                clearTimeout(timer);
                host.removeChild(glow);
              } catch (_) {
                /* 忽略 */
              }
            };
          }

          const canvas = doc.createElement('canvas');
          canvas.className = 'dsh-da-fx';
          const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
          const width = Math.max(320, (typeof window !== 'undefined' && window.innerWidth) || 1280);
          const height = Math.max(240, (typeof window !== 'undefined' && window.innerHeight) || 800);
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
          host.appendChild(canvas);

          const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
          if (!ctx) {
            try {
              host.removeChild(canvas);
            } catch (_) {
              /* 忽略 */
            }
            return undefined;
          }

          const palette = makePalette(detectDark());
          const scale = Math.max(1, width / 1600);
          const particles = [];
          const startedAt = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
          let nextShot = 0;
          let raf = 0;
          let lastNow = startedAt;
          let stopped = false;

          function now() {
            return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
          }

          function spawn(cx, cy, count) {
            const a = palette[Math.floor(Math.random() * palette.length)];
            const b = palette[Math.floor(Math.random() * palette.length)];
            for (let i = 0; i < count; i += 1) {
              if (particles.length >= MAX_PARTICLES) return;
              const angle = Math.random() * Math.PI * 2;
              const speed = (0.9 + Math.random() * 4.1) * scale;
              const life = 680 + Math.random() * 820;
              particles.push({
                x: cx,
                y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 0.55 * scale,
                life: life,
                maxLife: life,
                size: (1.9 + Math.random() * 2.3) * scale,
                tint: Math.random() < 0.5 ? a : b,
              });
            }
          }

          function frame() {
            if (stopped) return;
            const t = now();
            const dt = Math.min(60, Math.max(0, t - lastNow));
            lastNow = t;
            const step = dt / 16.6667;
            const elapsed = t - startedAt;

            while (nextShot < SHOT_AT.length && elapsed >= SHOT_AT[nextShot]) {
              spawn(
                width * (SHOT_X[nextShot] + Math.random() * 0.1),
                height * (SHOT_Y[nextShot] + Math.random() * 0.08),
                SHOT_COUNT[nextShot],
              );
              nextShot += 1;
            }

            // 拖尾：用 destination-out 把上一帧擦淡，再由 lighter 叠加新粒子
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalCompositeOperation = 'lighter';

            const damping = Math.pow(0.986, step);
            for (let i = particles.length - 1; i >= 0; i -= 1) {
              const p = particles[i];
              p.vy += 0.055 * step;
              p.vx *= damping;
              p.vy *= damping;
              p.x += p.vx * step;
              p.y += p.vy * step;
              p.life -= dt;
              if (p.life <= 0) {
                particles.splice(i, 1);
                continue;
              }
              const alpha = Math.max(0, p.life / p.maxLife);
              ctx.globalAlpha = Math.min(1, alpha * 1.05);
              ctx.strokeStyle = p.tint;
              ctx.lineWidth = p.size * 1.1 * dpr;
              ctx.beginPath();
              ctx.moveTo((p.x - p.vx * 2.4) * dpr, (p.y - p.vy * 2.4) * dpr);
              ctx.lineTo(p.x * dpr, p.y * dpr);
              ctx.stroke();
              ctx.fillStyle = p.tint;
              ctx.beginPath();
              ctx.arc(p.x * dpr, p.y * dpr, p.size * 0.9 * dpr, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';

            if (elapsed > FIREWORK_MS + 500 || (elapsed > FIREWORK_MS && particles.length === 0)) {
              cleanup();
              return;
            }
            const rafFn = typeof window !== 'undefined' && window.requestAnimationFrame;
            if (typeof rafFn === 'function') raf = rafFn(frame);
            else raf = setTimeout(frame, 16);
          }

          function cleanup() {
            stopped = true;
            try {
              if (typeof window !== 'undefined' && window.cancelAnimationFrame && raf) {
                window.cancelAnimationFrame(raf);
              } else {
                clearTimeout(raf);
              }
            } catch (_) {
              /* 忽略 */
            }
            try {
              host.removeChild(canvas);
            } catch (_) {
              /* 忽略 */
            }
            if (props && typeof props.onDone === 'function') {
              try {
                props.onDone();
              } catch (_) {
                /* 忽略 */
              }
            }
          }

          const rafFn = typeof window !== 'undefined' && window.requestAnimationFrame;
          if (typeof rafFn === 'function') {
            raf = rafFn(frame);
          } else {
            frame();
          }

          return function teardown() {
            stopped = true;
            try {
              if (typeof window !== 'undefined' && window.cancelAnimationFrame && raf) {
                window.cancelAnimationFrame(raf);
              } else {
                clearTimeout(raf);
              }
            } catch (_) {
              /* 忽略 */
            }
            try {
              host.removeChild(canvas);
            } catch (_) {
              /* 忽略 */
            }
          };
        },
        [props && props.fxKey],
      );

      return h('div', { className: 'dsh-da-fx-host', ref: hostRef });
    }

    /* ------------------------------------------------------------------ *
     * 轮询控制器
     * ------------------------------------------------------------------ */

    function createController(ctx) {
      const listeners = new Set();
      let snapshot = null;
      let timer = null;
      let started = false;
      let disposed = false;
      let inflight = null;
      let sse = null;
      let sseRetry = null;
      let sseTried = false;

      function emit() {
        const list = [];
        listeners.forEach(function (fn) {
          list.push(fn);
        });
        for (let i = 0; i < list.length; i += 1) {
          try {
            list[i](snapshot);
          } catch (_) {
            /* 单个订阅者出错不影响其他订阅者 */
          }
        }
      }

      function request(path, init) {
        const cfg = currentConfig();
        if (!cfg || !cfg.token) return Promise.resolve(null);
        const f = pickFetch();
        if (!f) return Promise.resolve(null);
        let url = urlFor(cfg, path);
        const sep = url.indexOf('?') >= 0 ? '&' : '?';
        url = url + sep + 'token=' + encodeURIComponent(cfg.token);
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const options = Object.assign({}, init || {});
        if (controller) options.signal = controller.signal;
        options.cache = 'no-store';
        const timeoutId = setTimeout(function () {
          try {
            if (controller) controller.abort();
          } catch (_) {
            /* 忽略 */
          }
        }, REQUEST_TIMEOUT_MS);
        inflight = controller;
        return f(url, options)
          .then(function (res) {
            try {
              if (res && typeof res.json === 'function') return res.json();
            } catch (_) {
              /* 忽略 */
            }
            return null;
          })
          .catch(function () {
            return null;
          })
          .then(function (data) {
            clearTimeout(timeoutId);
            if (inflight === controller) inflight = null;
            return data;
          });
      }

      function focusFlags() {
        // 可见性随 /state 一起上报：值变了宿主要知道，没变也要刷新心跳，
        // 否则 12s 后宿主会认为"页面不可见"而让原生特效层接管，页面上重复渲染。
        try {
          return { focused: pageFocused() ? '1' : '0', hidden: pageHidden() ? '1' : '0' };
        } catch (_) {
          return { focused: '0', hidden: '0' };
        }
      }

      /**
       * 页面窗口在屏幕坐标系里的矩形（物理像素）。
       * 原生层用它判断"页面在哪块屏上"，从而只跳过那一块屏、其余屏幕照常提醒。
       * Electron 里隐藏/离屏窗口会给出 -32000 这类哨兵值，此时返回空串让宿主用保守默认。
       */
      function windowRectParam() {
        try {
          const x = Number(window.screenX);
          const y = Number(window.screenY);
          const w = Number(window.outerWidth) || Number(window.innerWidth) || 0;
          const h = Number(window.outerHeight) || Number(window.innerHeight) || 0;
          if (!isFinite(x) || !isFinite(y) || x < -20000 || y < -20000) return '';
          if (w <= 0 || h <= 0) return '';
          return '&wrect=' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(w) + ',' + Math.round(h);
        } catch (_) {
          return '';
        }
      }

      function run() {
        if (disposed) return;
        const flags = focusFlags();
        return request('/state?focused=' + flags.focused + '&hidden=' + flags.hidden + windowRectParam()).then(function (data) {
          if (disposed) return;
          if (data && typeof data === 'object') {
            snapshot = data;
            emit();
          }
        });
      }

      function schedule() {
        if (disposed) return;
        if (timer !== null) return;
        timer = setTimeout(function () {
          timer = null;
          run().then(function () {
            schedule();
          });
        }, POLL_MS);
      }

      function connectEvents() {
        if (disposed || sse) return;
        const cfg = currentConfig();
        if (!cfg || !cfg.token) return;
        const Ctor = (typeof window !== 'undefined' && window.EventSource) || null;
        if (!Ctor) {
          if (!sseTried) {
            sseTried = true;
            ping('sse:missing');
          }
          return;
        }
        try {
          const url = urlFor(cfg, '/events') + '?token=' + encodeURIComponent(cfg.token);
          sse = new Ctor(url);
          sse.onmessage = function (event) {
            try {
              const payload = event && event.data ? JSON.parse(event.data) : null;
              if (!payload) return;
              // 任何信号都立刻重跑一次：庆祝信号要即时，命令同理
              if (timer !== null) {
                clearTimeout(timer);
                timer = null;
              }
              run().then(function () {
                schedule();
              });
            } catch (_) {
              /* 忽略 */
            }
          };
          sse.onerror = function () {
            try {
              if (sse) sse.close();
            } catch (_) {
              /* 忽略 */
            }
            sse = null;
            if (!disposed) {
              sseRetry = setTimeout(function () {
                sseRetry = null;
                connectEvents();
              }, SSE_RETRY_MS);
            }
          };
          if (!sseTried) {
            sseTried = true;
            ping('sse:on');
          }
        } catch (_) {
          sse = null;
        }
      }

      function start() {
        if (started || disposed) return;
        started = true;
        ensureBoot().then(function () {
          if (disposed) return;
          connectEvents();
          run().then(function () {
            schedule();
          });
        });
      }

      function stop() {
        started = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }

      function dispose() {
        disposed = true;
        stop();
        try {
          if (sse) sse.close();
        } catch (_) {
          /* 忽略 */
        }
        sse = null;
        if (sseRetry !== null) {
          clearTimeout(sseRetry);
          sseRetry = null;
        }
        try {
          if (inflight) inflight.abort();
        } catch (_) {
          /* 忽略 */
        }
        inflight = null;
        listeners.clear();
      }

      function subscribe(fn) {
        listeners.add(fn);
        if (snapshot) {
          try {
            fn(snapshot);
          } catch (_) {
            /* 忽略 */
          }
        }
        start();
        return function unsubscribe() {
          listeners.delete(fn);
          if (listeners.size === 0) stop();
        };
      }

      return {
        subscribe: subscribe,
        start: start,
        stop: stop,
        dispose: dispose,
        getSnapshot: function () {
          return snapshot;
        },
      };
    }

    function ensureController() {
      if (shared) return shared;
      const controller = createController(sharedCtx);
      shared = controller;
      return controller;
    }

    /* ------------------------------------------------------------------ *
     * 特效组件（注册到 shell.overlay）
     * ------------------------------------------------------------------ */


    function Overlay() {
      const [state, setState] = React.useState({ snapshot: null, tick: 0 });
      const local = React.useRef(null);
      if (!local.current) {
        local.current = { seen: new Set(), seeded: false };
      }
      const [fx, setFx] = React.useState(null);
      const [burstUntil, setBurstUntil] = React.useState(0);
      const fxTimer = React.useRef(null);
      const burstTimer = React.useRef(null);

      // 订阅控制器；控制器不存在时自愈补建（插件重载后 HMR 不重挂的情况）
      React.useEffect(function () {
        const controller = ensureController();
        if (!controller) return undefined;
        const unsubscribe = controller.subscribe(function (snap) {
          setState(function (prev) {
            return { snapshot: snap, tick: prev.tick + 1 };
          });
        });
        return function cleanup() {
          try {
            unsubscribe();
          } catch (_) {
            /* 忽略 */
          }
        };
      }, []);

      function playFirework(why) {
        const id = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36);
        ping('effect:fw:' + (why || 'live'));
        setFx({ key: id });
        if (fxTimer.current !== null) {
          try {
            clearTimeout(fxTimer.current);
          } catch (_) {
            /* 忽略 */
          }
        }
        fxTimer.current = setTimeout(function () {
          fxTimer.current = null;
          setFx(null);
        }, FIREWORK_MS + 600);
      }

      function triggerBurst() {
        ping('effect:edge-burst');
        const now = Date.now();
        setBurstUntil(now + FIREWORK_BURST_MS);
        if (burstTimer.current !== null) {
          try {
            clearTimeout(burstTimer.current);
          } catch (_) {
            /* 忽略 */
          }
        }
        burstTimer.current = setTimeout(function () {
          burstTimer.current = null;
          setBurstUntil(0);
        }, FIREWORK_BURST_MS + 200);
      }

      // 消费庆祝信号：done → 烟花（页面不可见时攒一条），error → 一次性红闪
      React.useEffect(
        function () {
          const snap = state.snapshot;
          if (!snap) return;
          const store = local.current;
          const list = Array.isArray(snap.celebrate) ? snap.celebrate : [];
          const settings = snap.settings && typeof snap.settings === 'object' ? snap.settings : {};

          if (!store.seeded) {
            // 首帧里的历史信号一律记为已消费：刷新页面不补放旧烟花
            for (let i = 0; i < list.length; i += 1) {
              const item = list[i];
              if (item && item.id) store.seen.add(String(item.id));
            }
            store.seeded = true;
            return;
          }

          for (let i = 0; i < list.length; i += 1) {
            const item = list[i];
            if (!item || !item.id) continue;
            const id = String(item.id);
            if (store.seen.has(id)) continue;
            store.seen.add(id);
            if (item.kind === 'error') {
              if (settings.edgeFlash !== false) triggerBurst();
              continue;
            }
            if (settings.fireworks === false) continue;
            if (!shouldRenderHere(snap)) {
              // 页面不在前台：交给原生覆盖层，这里不画也不补放（避免同一发烟花被看两次）
              ping('fx:away');
              continue;
            }
            playFirework('live');
          }
          if (store.seen.size > 400) store.seen.clear();
        },
        [state.tick],
      );

      // 回到前台/重新获得焦点：立刻补跑一轮（后台标签页的计时器会被浏览器节流）
      React.useEffect(function () {
        function onVisibility() {
          if (pageHidden()) return;
          const controller = ensureController();
          if (controller) controller.start();
        }
        try {
          document.addEventListener('visibilitychange', onVisibility);
          window.addEventListener('focus', onVisibility);
        } catch (_) {
          /* 忽略 */
        }
        return function cleanup() {
          try {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', onVisibility);
          } catch (_) {
            /* 忽略 */
          }
        };
      }, []);

      // 卸载时清掉本地计时器
      React.useEffect(function () {
        return function cleanup() {
          try {
            if (fxTimer.current !== null) clearTimeout(fxTimer.current);
            if (burstTimer.current !== null) clearTimeout(burstTimer.current);
          } catch (_) {
            /* 忽略 */
          }
        };
      }, []);

      const snapshot = state.snapshot;
      const settings = snapshot && snapshot.settings && typeof snapshot.settings === 'object' ? snapshot.settings : {};
      const now = Date.now();
      // 一次特效只由一层负责：页面在前台（或原生层没跑）才由页面画
      const renderHere = shouldRenderHere(snapshot);
      const pendingLevel = !renderHere || settings.edgeFlash === false ? '' : edgeLevelOf(snapshot, now);
      const burstLevel = burstUntil > now ? 'burst' : '';
      const edgeLevel = pendingLevel || burstLevel;
      const showFx = !!fx && settings.fireworks !== false && renderHere;

      const children = [];
      if (edgeLevel) children.push(h(EdgeFlashLayer, { key: 'edge', level: edgeLevel }));
      if (showFx) children.push(h(FireworksLayer, { key: 'fx' + (fx ? fx.key : ''), fxKey: fx ? fx.key : '', onDone: undefined }));
      // 样式表常驻（未读高亮不依赖任何特效层渲染）
      return h(React.Fragment, null, h('style', { key: 'style' }, CSS_TEXT + unreadCss(settings.unreadHighlight !== false)), ...children);
    }

    /* ------------------------------------------------------------------ *
     * 插件导出
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      try {
        if (shared) return;
        sharedCtx = ctx;
        shared = createController(ctx);

        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function cleanup() {
              const controller = shared;
              shared = null;
              if (controller) {
                try {
                  controller.dispose();
                } catch (_) {
                  /* 忽略 */
                }
              }
            };
          });
        }

        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({ name: 'shell.overlay', id: 'desk-alerts', order: 100 }, Overlay);
          });
          ping('apply');
          ping('hidden:' + (pageHidden() ? 'yes' : 'no'));
        }
      } catch (_) {
        /* 注册失败也不冒泡到页面 */
      }
    }

    return { inject: ['slots'], apply: apply };
  },
});
