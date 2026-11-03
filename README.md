# dsh-desktop-alerts

> Desktop effect alerts for [dsh](https://github.com/deepseek-ai/deepseek-harness): full-screen fireworks when a turn
> finishes, a thin deep-green breathing border while an approval or question waits on you, and a green highlight on
> unread session rows. No popups, no cards, no sounds — you notice it out of the corner of your eye and come back.

一个**纯氛围**提醒插件：会话**完成**时在屏幕上放烟花，**需要你审批**时屏幕四周深绿呼吸闪，
回答完了还没看过的会话**在会话列表里整行深绿高亮**。
没有弹窗、没有卡片、没有通知横幅、没有声音——不用点、不用读，抬头看一眼就知道该回来看一眼了。

而且**页面不在前台也照放**：DSH 页面在前台由页面自己画（GPU 合成，最省电）；
页面被切走、被遮挡、整个 DSH 窗口最小化时，交给 Windows 上的一个**点击穿透透明覆盖层**画在同一块屏幕上。

> 需要 **Windows 10/11 + .NET Framework 4.x**（系统自带，用来编译原生覆盖层）。
> 其他系统上插件照常安装、页面内烟花与边闪照常工作，只是没有跨窗口的那一层。

## 它长什么样

- 任务完成 → 全屏烟花，3 次爆发、约 600 颗、拖尾 + 辉光；深色主题霓虹色板，浅色主题更饱和。
- 需要审批 / 等你回答提问（`ask_user_question`）→ 屏幕四边**深绿**（`#15803D`）呼吸，
  只有贴边 58px 的一圈、四角与四边一样淡：看得见但不刺眼，中间内容一个像素都不压。
- 计划待确认 → 同样的边闪，琥珀色。
- 出错 → 一次性红闪「受击」效果，自己停。
- **双屏（多显示器）时每块屏都提醒**：烟花在每块屏各放一轮、深绿光罩每块屏各贴一圈；
  页面在前台时它只画自己那块屏，剩下的屏由覆盖层补位，不会出现"只有一块屏亮"。
- 回答完了还没看 → 左侧会话列表里那个会话**整行变深绿**（比小绿点显眼得多）；
  跟着 DSH 自己的"未读点"走：你点开它、点没了，高亮也就没了。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| Host 半 | `lib/index.js` | 拦截 `approval/request`、`user-questions/request`（计划确认）、`agent/status`、`agent/error`；维护待办队列与庆祝信号；提供 loopback HTTP 路由；编译并拉起原生覆盖层 |
| 页面特效层 | `lib/client.js` | 注册 `shell.overlay`；上报「我能不能画」+ 自己窗口在屏幕上的矩形；页面在前台时用 canvas / CSS 画烟花与边闪 |
| 原生覆盖层 | `widget/DshDesktopAlertsFx.cs` | 单文件 C#（WPF）跨全部显示器、透明、置顶、点击穿透、不抢焦点；1.5s 轮询 `/state`，补齐页面没覆盖到的屏幕 |
| 契约 | `CONTRACT.md` | 端点、`StateSnapshot`、两层的渲染归属与语义 |

> 为什么覆盖层是编译出来的 exe 而不是 PowerShell + WPF：部分受管 Windows 机器在 HKLM 设了 `__PSLockdownPolicy=4`，
> **所有** PowerShell 进程都会进 ConstrainedLanguage，WPF 加载不起来。编译型 exe 不受该策略影响，
> 所以宿主在首次运行时用系统自带的 `csc.exe`（.NET Framework 4.x）把单文件 C# 编译成 exe 再跑——
> 运行期不依赖 PowerShell。

## 安装

从插件市场（Discover → 索引源 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）搜索
`dsh-desktop-alerts` 一键安装，或者：

```sh
dsh plugin --profile web add dsh-desktop-alerts
```

已经下载到本地时，也可以在 DSH 会话里让 agent 执行：

```
plugin_manager  action: install_bundle
                target: <本目录绝对路径>
```

安装后**重启 DSH**（或等 profile 热加载完成）生效。装好后可以用 `cordis_inspect_query` 确认 `dsh-desktop-alerts` 这一行状态为 `schema`。

## 平台要求

| 平台 | 页面内烟花 / 边闪 / 未读高亮 | 页面不在前台时的原生覆盖层 |
|---|---|---|
| Windows 10/11（装有 .NET Framework 4.x，系统自带） | ✅ | ✅ 跨全部显示器 |
| Windows 且系统精简掉了 `csc.exe` | ✅ | ❌ 自动降级，日志写进 `host.log` |
| macOS / Linux | ✅ | ❌ 自动降级（平台不支持） |

## 配置

写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-desktop-alerts
  name: dsh-desktop-alerts
  config:
    enabled: true
    debug: true                      # 写 host.log，排查"为什么没放"时开
    triggers: { approval: true, planReview: true, done: true, error: true }
    celebrate: { enabled: true, cooldownMs: 800 }   # 连续完成的最小间隔
    effects: { fireworks: true, edgeFlash: true }   # 想清静时关掉烟花/边闪
    unreadHighlight: { enabled: true }              # 会话列表里未读会话整行深绿
    overlay: { autoStart: true }     # 原生覆盖层（页面不在前台时的兜底渲染）
    quietHours: { enabled: false, start: "23:00", end: "08:00" }
    sound: { enabled: false }
    pendingTtlMs: 300000             # 待审批项在状态里留多久（只影响边闪亮多久）
```

免打扰（`quietHours`）只挡烟花和边闪，**不挡未读高亮**：高亮是"回来要看一眼"的书签，不是打扰。

## 安全边界

- 插件**不碰审批答复**：没有 `/answer`、没有代答、没有"本次会话都允许"这类放宽容错。
  红闪只是提醒，答复永远在官方卡片上完成。
- HTTP 路由**只监听 loopback**，`/state` 等端点需要每次启动重新生成的随机 token；
  `/boot` 只认本机 GUI 的同源 `Origin`/`Referer`。
- 覆盖层是 `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` 的点击穿透窗口：
  不抢焦点、不挡鼠标、不进任务栏和 Alt-Tab。
- 插件任何环节出错都静默降级（特效没有、官方链路照常），不会影响审批本身。

## 文件与日志

- `%LOCALAPPDATA%\dsh-desktop-alerts\widget.json` —— 覆盖层读的 token/origin（宿主每次启动重写）
- `%LOCALAPPDATA%\dsh-desktop-alerts\DshDesktopAlertsFx.exe` —— 编译产物，源码更新后自动重编译
- `%LOCALAPPDATA%\dsh-desktop-alerts\widget.pid` —— 覆盖层进程号，用于单实例
- `%LOCALAPPDATA%\dsh-desktop-alerts\overlay.log` —— 覆盖层日志（窗口尺寸、`surface visible|hidden`、`edge approval`、`celebrate done`）
- `%LOCALAPPDATA%\dsh-desktop-alerts\host.log` —— 宿主日志（`http/*`、`approval/request`、`agent/status`、`celebrate kind=done`）

手动验收技巧（不依赖真实任务）：

```powershell
# 放一次假烟花 / 闪一次红边，3 秒后退出
& "$env:LOCALAPPDATA\dsh-desktop-alerts\DshDesktopAlertsFx.exe" -ConfigPath "$env:LOCALAPPDATA\dsh-desktop-alerts\widget.json" -Preview 4
& "$env:LOCALAPPDATA\dsh-desktop-alerts\DshDesktopAlertsFx.exe" -ConfigPath "$env:LOCALAPPDATA\dsh-desktop-alerts\widget.json" -EdgePreview
```

## 已知限制

- 原生覆盖层仅 Windows，且需要 .NET Framework 4.x 的 `csc.exe`（Win10/11 自带）；
  没有它时自动降级成"只在页面里画"，不影响 DSH 本身。
- **独占全屏**（全屏游戏、部分 DRM 视频）会遮挡覆盖层——Windows 的层级规则，绕不过去。
- 覆盖层不跟随系统「减少动效」设置（页面内特效跟随）。
- 覆盖层是宿主进程的子进程：DSH 退出它跟着退出；被单独杀掉时，页面会在下一次 `/state` 发现
  `overlay.running === false` 并接管渲染（特效退化为"只在页面里"）。

## 隐私

- 只在本机工作：没有遥测、没有远程请求；HTTP 路由只监听 loopback，且需要每次启动重新生成的随机 token。
- 宿主日志（`host.log`）默认关闭（`debug: false`）；打开后只记事件名与会话 id，不记对话内容。
- 覆盖层窗口不截图、不读屏、不抓键鼠：它只在自己那块透明画布上画烟花和边。

## 卸载

```
plugin_manager  action: remove_bundle  target: dsh-desktop-alerts
```

卸载后重启 DSH；覆盖层会因 DSH 退出自动结束，`%LOCALAPPDATA%\dsh-desktop-alerts` 可手动删除。