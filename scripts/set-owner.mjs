#!/usr/bin/env node
/**
 * 把仓库里的 OWNER 占位替换成真实 GitHub 用户名。
 *
 *   node scripts/set-owner.mjs <github-username>
 *
 * 只改三处文本：package.json 的 repository/homepage/bugs、
 * market/awesome-dsh-plugin.yml 的 url/name/icon、PUBLISHING.md 里的示例命令。
 * 幂等：重复跑同一个用户名的结果一样。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const owner = (process.argv[2] || '').trim()

if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error('用法: node scripts/set-owner.mjs <github-username>')
  console.error('GitHub 用户名只能包含字母、数字和连字符，且不能以连字符开头或结尾。')
  process.exit(1)
}

const files = ['package.json', 'market/awesome-dsh-plugin.yml', 'PUBLISHING.md']
const touched = []

for (const rel of files) {
  const path = join(ROOT, rel)
  const before = readFileSync(path, 'utf8')
  let after = before.replaceAll('OWNER', owner)
  // 之前已经跑过一次时，把上一个用户名换掉：只认这三类 URL 里的路径段
  after = after.replace(/(github\.com\/)[A-Za-z0-9-]+(\/dsh-desktop-alerts)/g, `$1${owner}$2`)
  if (after !== before) {
    writeFileSync(path, after, 'utf8')
    touched.push(rel)
  }
}

// package.json 里再保险一次：确保 repository/homepage/bugs 指向真实地址
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.repository = { type: 'git', url: `git+https://github.com/${owner}/dsh-desktop-alerts.git` }
pkg.homepage = `https://github.com/${owner}/dsh-desktop-alerts#readme`
pkg.bugs = { url: `https://github.com/${owner}/dsh-desktop-alerts/issues` }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
if (!touched.includes('package.json')) touched.push('package.json')

console.log(`已把 OWNER 换成 ${owner}`)
console.log(`改动文件: ${touched.join(', ')}`)
console.log('\n下一步:')
console.log(`  git add -A && git commit -m "chore: 指向 github.com/${owner}/dsh-desktop-alerts"`)
console.log(`  git remote add origin git@github.com:${owner}/dsh-desktop-alerts.git`)
console.log('  git push -u origin main')
console.log('  npm publish --access public')
console.log(`  把 market/awesome-dsh-plugin.yml 复制到 fork 的 data/plugins/${owner}__dsh-desktop-alerts.yml 并提 PR`)