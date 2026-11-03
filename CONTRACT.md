# dsh-desktop-alerts · 接口契约（宿主 ↔ 页面特效 ↔ 原生覆盖层）

这个插件不弹卡片、不出通知、不代答：它只做两件事——**任务完成时放烟花**、**需要你审批时页面四周红闪**。
同一发特效永远只由一层负责：DSH 页面在前台就页面画，否则由 Windows 上的透明覆盖层画。

宿主半是唯一数据源。页面特效层（client 半）和原生覆盖层（WPF）都**只读** `/state`，
外加一条同源心跳把「我现在能不能画」告诉宿主；两侧都不做业务判断、不写任何状态。

## 1. 端点

`base` = `/dsh-desktop-alerts/api`，与 DSH Web GUI 同源（例如 `http://127.0.0.1:56819`）。

所有端点只接受 **loopback**（127.0.0.1 / ::1）。除 `/boot`、`/ping`、`/health` 外都必须带 token。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/state` | `?token=[&focused=1|0][&hidden=1|0][&wrect=x,y,w,h]` | `StateSnapshot` |
| GET | `/events` | `?token=` | `text/event-stream` |
| POST | `/boot` | 同源，无 token | `{ok, origin, base, token}` |
| GET/POST | `/ping` | `?stage=`，无 token | `{ok:true}`（只写日志） |
| GET | `/health` | — | `{ok, version, origin, overlay:{running,pid}}` |
| POST | `/focus` | `{pageFocused, pageHidden}` 同源无 token | `{ok:true}`（兼容保留，页面半已改用 `/state` 参数） |

token 位置：`?token=` 查询参数，或请求头 `x-alerts-token`。错误响应：`401 {ok:false,error:"token"}`、
`403 {ok:false,error:"loopback"|"origin"}`、`404 {ok:false,error:"not-found"}`。

`/answer`、`/open`、`/ack` **已下线**（卡片删除后不再有调用方），现在返回 `410 gone`；
审批永远在 DSH 官方页面处理。

## 2. StateSnapshot

```json
{
  "version": 2,
  "now": 1761650000000,
  "overlay": { "running": true, "pid": 37556 },
  "page": {
    "visible": false,
    "focused": false,
    "hidden": true,
    "at": 1761650000000,
    "rect": { "x": 0, "y": 0, "w": 2560, "h": 1440 }
  },
  "focus": { "pageFocused": false },
  "settings": {
    "quiet": false,
    "fireworks": true,
    "edgeFlash": true,
    "unreadHighlight": true,
    "locale": "zh"
  },
  "pending": [
    {
      "id": "p-9f3a",
      "kind": "approval",
      "sessionId": "session-...",
      "sessionTitle": "修一下构建脚本",
      "cwd": "C:\\Users\\alice\\projects\\demo",
      "toolName": "pwsh",
      "summary": "pwsh -Command \"Get-ChildItem C:\\Users\\alice\\projects\"",
      "reason": "需要你的批准才能执行命令",
      "createdAt": 1761650000000,
      "expiresAt": 1761650300000,
      "canDecide": true
    }
  ],
  "celebrate": [
    { "id": "e-12bd", "kind": "done", "sessionId": "session-...", "sessionTitle": "修一下构建脚本", "detail": "耗时 2m 14s", "at": 1761650000000 }
  ],
  "unread": [
    { "sessionId": "session-...", "kind": "done", "at": 1761650000000 }
  ]
}
```

约定：

- `pending[].kind`：
  - `"approval"`（工具授权确认）→ 深绿边闪，`canDecide:true`；
  - `"question"`（`ask_user_question` 之类等你选/填的提问）→ 同样深绿边闪，`canDecide:false`；
  - `"plan-review"`（计划确认）→ 琥珀边闪，只读。
  `expiresAt` 到期后宿主自行摘除；**绝不代答**。
- `pending` 只用来决定"边缘闪什么颜色"，没有任何可点击内容。
- `celebrate[]`：任务完成/出错的庆祝信号，环形队列 ≤10、TTL 15s；`kind` 为 `"done" | "error"`。
  同时经 SSE 以 `{type:'celebrate', item}` 即时推送。
- `page.visible`：页面半在 `FOCUS_TTL_MS`（12s）内上报过 `focused=1&hidden=0` 才算 "true"。
  页面没加载、标签页在后台、或上报过期 → `false`，由原生覆盖层接管。
- `page.rect`：页面窗口在屏幕坐标系里的矩形（`window.screenX/screenY/outerWidth/outerHeight`），
  随每次 `/state` 心跳一起上报（`&wrect=x,y,w,h`）；离屏哨兵值（-32000）或缺失时为 `null`。
  原生层靠它决定"跳过哪块屏"——页面所在屏由页面自己画，其余屏由原生层画。
- `overlay.running`：原生覆盖层进程是否存活。页面侧在它为 `false` 时**接管渲染**（避免什么都没看到）。
- `settings.quiet === true`（`quietHours` 命中）时：不发 celebrate、不闪边缘。
- **没有** `unread[]` 之类的服务端未读记账：未读语义完全交给 DSH 自己
  （会话行的 `data-state="done"` 状态点），页面半用 CSS `:has()` 读它，见 §4。
  早期版本曾在宿主内存里记"谁答完了还没看"，实测不可靠（插件重载即清空，
  重载前就答完的会话永远标不上），已删除。

## 3. 原生覆盖层（WPF，纯特效）

源码 `widget/DshDesktopAlertsFx.cs`（单文件 C# 5，零第三方依赖）。宿主动手前用
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译成
`%LOCALAPPDATA%\dsh-desktop-alerts\DshDesktopAlertsFx.exe`（源码比 exe 新才重编），然后直接运行。

> 为什么是编译出来的 exe 而不是 PowerShell + WPF：部分受管 Windows 机器在 HKLM 设了 `__PSLockdownPolicy=4`，
> 所有 PowerShell 进程都被强制成 ConstrainedLanguage，加载不了 WPF；编译型 exe 不受该策略影响
> （不涉及任何绕过，只是换运行时）。

- 启动参数：`-ConfigPath <path>`；该 JSON 由宿主写入，每次轮询都重读（宿主重启会换 token/origin）：
  `{ "origin": "http://127.0.0.1:56819", "base": "/dsh-desktop-alerts/api", "token": "<hex>", "locale": "zh", "version": "..." }`。
- 诊断参数：`-Preview <秒>`（假数据放一次烟花）、`-EdgePreview`（假数据闪一次红边），供验收用。
- 轮询：`GET {origin}{base}/state?token=...`，间隔 1500ms，单次超时 2.5s；失败继续重试（不清空、不退出）。
- 窗口：**铺满整个虚拟桌面**（多显示器时 `SystemParameters.VirtualScreenLeft/Top/Width/Height`，
  例如主屏 2560×1440 + 右侧副屏 1440×900 时虚拟桌面为 `0,-195 4000x1635`）、无边框、`AllowsTransparency`、
  `Topmost`、**点击穿透且永不抢焦点**（`WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` +
  `ShowActivated=false` + `IsHitTestVisible=false`）。
- 每块屏一套视觉：光罩是 `Canvas` 里按屏幕矩形摆放的**四条窄带 `Rectangle` + 一圈 1px 描边**，
  烟花按屏撒点（每发爆发在每块屏各来一轮）。屏幕增删/换分辨率后自动重建（`edge layer rebuilt for N screen(s)`）。
- 空闲即隐藏：窗口默认 `Visibility.Hidden`，没有任何正在播放的特效时**不做任何绘制**（零 CPU），
  有特效才 `Visible`。
- **zone 判定**（哪几块屏该画）：
  | 情况 | 画在哪 |
  |---|---|
  | 页面在前台，`page.rect` 落在第 k 块屏 | 除第 k 块外的所有屏（第 k 块由页面自己画） |
  | 页面在前台，但没报 `page.rect` | 除主屏外的所有屏（保守默认：认为页面在主屏） |
  | 页面不在前台 / 没有页面 | 全部屏 |
  | 单屏且页面在前台 | 一块都不画，窗口隐藏（页面画） |
- 其余情况按快照决定：
  - `pending` 有 `approval`（工具授权）或 `question`（`ask_user_question` 等你选/填）→ 四边**深绿**（`#15803D`）
    渐变 + 1px 描边，`1.6s` 呼吸（`0.50→1.00`，`SineEase` 往复）；
    只有 `plan-review` → 换成琥珀色；多条只维持一层。
  - 光罩是**四条独立窄带**（每块屏 4 个 `Rectangle` + 1 圈描边），不是一圈径向渐变：
    上下带撑满宽度、左右带从上下带内侧起算，所以角上只有一条带、四条边亮度完全一致；
    带宽 `min(58px, 屏高×5.5%)`（1440 高的屏上约 58px），带内线性淡出。
  - 峰值不透明度 45%（再乘呼吸 0.50–1.00 ⇒ 屏上实际约 22%–45%），中间内容一个像素都不动。
    实测（深色桌面最亮帧，屏幕左侧向内）：贴边绿偏移 `+65`、2px `+45`、10px `+35`、20px `+14`、
    **约 30–58px 归零**；四角与四边中点一致（`+41 / +39 / +40`）——**角上不再更亮**。
    历史取舍：70%×300px 宽带（太显眼）→ 15%（完全看不到）→ 现在 45%×58px 窄带（看得见且不刺眼）。
  - 新的 `celebrate`（按 id 去重）`done` → 全屏烟花；`error` → 一次性红闪 `burst`（`360ms × 2` 后自停，仍为红）。
  - 首帧快照里的历史 celebrate 全部记成"已看过"，重开程序不会补放旧烟花。
- 烟花渲染：单个 `FrameworkElement.OnRender` + `CompositionTarget.Rendering` 驱动；
  3 次爆发（0 / 470 / 980ms，共约 600 颗），重力 + 空气阻力 + 拖尾线 + 辉光晕；
  尺寸/速度按 `max(1, 最宽屏/1600)` 缩放（2560 屏上约 1.6×）；粒子上限 1300，双屏时每屏仍保有完整密度。
- 坐标口径：`expiresAt` / `at` 都是 **Unix 毫秒**（与 `Date.now()` 一致）。
- 日志：`%LOCALAPPDATA%\dsh-desktop-alerts\overlay.log`（`overlay start` / `window loaded WxH` /
  `surface visible|hidden` / `edge approval|plan|burst|off` / `celebrate done|error` / `poll failed`）。

## 4. 页面特效层（client 半）

- 只注册 `shell.overlay` 槽，id `desk-alerts`，`order:100`；不替换任何既有 UI。
- token 优先取 `window.__DSH_DESKTOP_ALERTS__ = { origin, base, token }`（宿主经 `webserver/index-inject` 注入）；
  注入缺失时同源自举 `POST {base}/boot`（只认本机 GUI 的 `Origin`/`Referer`，其它本地页面 403）。
- 每 1500ms：`GET {base}/state?token=…&focused=…&hidden=…`——**可见性随心跳上报**，
  每次都刷新时间戳（否则 12s 后会被判成"页面不可见"而让原生层接管，页面上重复渲染）。
- 渲染归属：页面在前台（`document.hasFocus() && !document.hidden`）才自己画；
  否则不画（原生层负责）；只有 `overlay.running === false` 时才兜底自己画。
- 特效开关：`settings.fireworks` / `settings.edgeFlash`。
- 页面半还上报**自己窗口在屏幕上的矩形**（`&wrect=x,y,w,h`）：原生层据此绕开页面所在那块屏。
  页面只能画在自己的窗口里，所以双屏时另一块屏始终由原生层补——不会出现"只有一块屏亮"。
- 首帧快照里的历史 celebrate 记成"已看过"：刷新页面不补放旧烟花；`error` → 一次性红闪。
- 样式只用 CSS（无卡片）：四边用**四条分层 `linear-gradient` 窄带**（不是径向渐变，避免四个角堆成亮块），
  **深绿**呼吸且只覆盖最外侧 58px，峰值合成不透明度约 0.45（呼吸 0.5–1.0）；全屏 `<canvas>` 烟花。
- 会话列表未读高亮（`settings.unreadHighlight`，纯 CSS，无 JS 状态）：
  DSH 自己的未读状态点是行内 `<span data-state="done">`，所以规则是
  `[data-row-key^="session:"]:has([data-state="done"])` → 整行深绿底 + 左侧 3px 深绿竖条。
  DSH 去掉那个点（你点开会话）高亮自动消失——**不需要插件判断"读没读"**。
  锚点是 `data-row-key` 与 `data-state`，均非哈希类名。
- `prefers-reduced-motion: reduce`：烟花降级为 1.3s 静态辉光，红闪改为常亮静态边光。
- 诊断心跳：`GET {base}/ping?stage=apply|hidden:yes|hidden:no|sse:on|sse:missing|effect:fw:*|effect:edge-burst|fx:away`，
  只写宿主日志、无副作用，用来区分「页面没重载」「没上报可见性」「特效被跳过」三种静默失效。
- 资源清理：`ctx.effect` 管定时器；组件卸载停轮询、关事件流；控制器被释放后挂载会自愈重建。

## 4.1 事件推送（SSE）

- `GET {base}/events?token=...`：`text/event-stream`，25s 心跳注释行，客户端断开自动清理。
- 页面半在拿到 token 后建立常驻事件流（受限作用域里必须写 `window.EventSource`，裸 `EventSource` 取不到）。
- 宿主发 celebrate 时立刻 `notifyPages({type:'celebrate', item})`；页面收到即跑一轮轮询。
- 存在的理由：页面被遮挡或在后台时，Chromium 会把页面内定时器节流到 ~1 分钟一次，
  纯轮询会让烟花迟到；轮询保留为兜底，事件流是主通道。
- 断线重连：`onerror` 关闭后 5s 重试；`dispose()` 关流并清掉重试计时器。

## 4.2 特效语义（一目了然）

| 触发 | 页面在前台 | 页面不在前台 |
|---|---|---|
| 任务完成（root agent 变 idle） | 页面 canvas 烟花 + 其余屏原生烟花 | 每块屏原生烟花 |
| 需要审批（pending approval） | 页面四边深绿呼吸 + 其余屏原生深绿呼吸 | 每块屏原生深绿呼吸 |
| 等你回答提问（pending question） | 同上（深绿，与审批同色） | 每块屏原生深绿呼吸 |
| 计划待确认（plan-review） | 页面四边琥珀呼吸 + 其余屏原生琥珀呼吸 | 每块屏原生琥珀呼吸 |
| 出错（agent/error） | 一次性红闪 burst（页面 + 其余屏） | 每块屏一次性红闪 burst |
| 有未读回答的会话（列表行） | 该行整行深绿（跟 DSH 自己的未读点同生共死） | 同左（列表只在页面里，原生层不画） |

- 完成信号在**任何门控之前**生成：前台也放，后台更放；`celebrate.cooldownMs`（默认 800ms）去抖。
- 同一块屏上同一发烟花不会既在页面又在覆盖层播放（按屏互斥，见 §3 的 zone 判定）。
- 双屏时"两块屏都能看到提醒"是硬要求：页面只负责自己那块屏，其余屏永远由原生层补位。

## 5. 已知限制（平台级，不是 bug）

- **独占全屏**（全屏游戏、部分 DRM 视频）会遮挡任何叠加层——Windows 的层级规则，无法绕过。
- 多屏**缩放率不同**时（例如主屏 150%、副屏 100%），副屏上的光罩会有几像素错位；不影响"两块屏都亮"。
- 覆盖层是**一个跨所有屏幕的窗口**，不是每屏一个；因此任务管理器里只有一个进程、一个窗口。
- 覆盖层不跟随系统「减少动效」设置（页面侧跟随）。
- 覆盖层进程若被杀，页面会在下一次 `/state` 发现 `overlay.running === false` 并接管渲染（特效退化为"只在页面里"）。

## 6. 安全与失败语义

- 审批答复链路完全不经过本插件：没有 `/answer`，没有代答，`pending` 到期也不会自动拒绝/允许。
- 覆盖层与页面层任何异常都**不得**影响宿主：全部请求带 2s 超时、全链路 try/catch，失败静默。
- 覆盖层是点击穿透窗口：不会抢焦点、不会挡住鼠标、不会出现在任务栏/Alt-Tab。