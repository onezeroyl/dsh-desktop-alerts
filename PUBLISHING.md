# 提交到 DSH 插件市场（awesome-dsh-plugin / dsh-plugin-catalog）

市场索引是 npm 包 `dsh-plugin-catalog`（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`），
数据源是 GitHub 仓库 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的 `data/plugins/*.yml`。**索引只收录已发布到 npm 的插件**，所以顺序是：

1. 建公开仓库并推代码
2. `npm publish`
3. 给 awesome 仓库提一个 PR，只加一个 YAML 文件

下面命令里的 `onezeroyl` 换成 GitHub 用户名。

## 0. 一条命令填好仓库地址

```sh
node scripts/set-owner.mjs <你的GitHub用户名>
```

它会把 `package.json` 的 repository/homepage/bugs、`market/awesome-dsh-plugin.yml` 的
url/name/icon、以及本文件下面的示例命令里的 `onezeroyl` 全部替换掉（可重复执行）。

## 1. 公开仓库

```sh
git init -b main
git add -A
git commit -m "feat: dsh-desktop-alerts 0.3.7 — fireworks, green edge flash, unread rows"
# 先在 GitHub 网页建空仓库 dsh-desktop-alerts，然后：
git remote add origin git@github.com:onezeroyl/dsh-desktop-alerts.git
git push -u origin main
```

> 提交前确认 `git config user.email` 不是不想公开的公司邮箱；GitHub 可用
> `USERNAME@users.noreply.github.com` 作为提交邮箱。

## 2. 发布 npm

```sh
npm login                 # 浏览器里登录一次
npm publish --access public
```

校验：

```sh
npm view dsh-desktop-alerts version dist.tarball
```

## 3. 提交市场条目

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 把仓库里 `market/awesome-dsh-plugin.yml` 复制过去，改名为
   `data/plugins/onezeroyl__dsh-desktop-alerts.yml`
3. 提 PR（一个文件，title 例：`Add dsh-desktop-alerts`）

合并后索引由维护者每天重跑，`dsh-plugin-catalog` 发新版本，DSH 的 Discover 里就能搜到并一键安装。

## 收录检查清单（对照 contributing.md）

- [x] `package.json` 声明 `dsh.bundle.patch`（`dsh.client` 单独存在不算可安装）
- [x] `cordis.patch.yml` 存在且能解析，默认 `debug: false`
- [x] 有 `README.md`、`LICENSE`（MIT）、`icon.svg` + `assets/icon-180.png`
- [x] **仓库里没有任何真实桌面截图**：对外素材只用合成示意图或纯效果区域截图。整屏截图会带上窗口标题、文件名、对话内容、其他应用，等于把本机隐私公开出去，且一旦 push 过就进了历史，删文件也抹不掉（只能删库重建）
- [x] 已发布到 npm（索引只收 npm 上已有版本的条目）
- [x] 在别的平台上不炸：没有 `csc.exe` / 非 Windows 时自动降级成"只在页面里画"
- [x] 描述是**一句英文**、以句号结尾（含 `: ` 必须加引号）
- [x] `category: notify`（通知与集成）

## 版本发布流程（后续迭代）

```sh
# 1. 改 lib/ 或 widget/ 里的源码
# 2. 升版本（package.json + lib/index.js 的 VERSION 两处）
# 3. 本地验证：node --check lib/*.js，并在本机跑一遍真实特效
npm version patch --no-git-tag-version
npm publish
git commit -am "release: v0.3.x" && git push
```

市场索引按 npm 上的最新版本显示，不需要重新提 PR。