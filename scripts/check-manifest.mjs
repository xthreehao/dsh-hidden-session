#!/usr/bin/env node
/**
 * dsh-hidden-session —— 清单自检（零依赖，本地与 CI 跑同一份）。
 *
 * 校验的是「加载管线的硬性要求」，不是风格：
 *   - `dsh.client.platform` 必须是 "web"
 *   - `exports["./client"]` 必须存在（可为字符串或 { default: string }）
 *     且指向的文件必须真的在磁盘上（缺失会让宿主启动时报 MissingClientBundleError）
 *   - `dsh.bundle.patch` 与 `main` 必须指向真实文件
 *   - `lib/client.js` 里注册的模块 id 必须等于包名
 *     （dsh-client-modules 要求「注册 id == 图行 id」，否则报 loaded without registering）
 *   - `cordis.patch.yml` 必须是「插入本包名」的形状
 *
 * 用法：node scripts/check-manifest.mjs [包目录，默认取本脚本的上级目录]
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv[2] || join(here, '..'))

let failures = 0

/** 断言并打印。 */
function check(label, ok, detail) {
  if (ok) {
    console.log('  ok    ' + label)
  } else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

/** 把 exports["./client"] 的两种合法形态归一成相对路径。 */
function clientExportPath(exportsField) {
  const value = exportsField && exportsField['./client']
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.default === 'string') return value.default
  return undefined
}

const pkgPath = join(root, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('找不到 package.json：' + pkgPath)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

console.log('包目录：' + root)
console.log('包名  ：' + pkg.name)

// 1. dsh.client 声明
const client = pkg.dsh && pkg.dsh.client
check('dsh.client 存在', Boolean(client))
check('dsh.client.platform === "web"', client && client.platform === 'web', client && client.platform)
check(
  'dsh.client.inject 是字符串数组（可选但存在时必须是）',
  client === undefined || client.inject === undefined
    || (Array.isArray(client.inject) && client.inject.every((x) => typeof x === 'string')),
)

// 2. 浏览器半入口
const rel = clientExportPath(pkg.exports)
check('exports["./client"] 可解析', Boolean(rel), JSON.stringify(pkg.exports && pkg.exports['./client']))
if (rel) check('浏览器半文件存在：' + rel, existsSync(join(root, rel)))

// 3. bundle patch 与宿主半
const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
const patchRel = Array.isArray(patch) ? patch[0] : patch
check('dsh.bundle.patch 可解析', typeof patchRel === 'string', JSON.stringify(patch))
if (typeof patchRel === 'string') check('patch 文件存在：' + patchRel, existsSync(join(root, patchRel)))
check('main 指向的文件存在：' + pkg.main, typeof pkg.main === 'string' && existsSync(join(root, pkg.main)))

// 4. 模块注册 id 必须等于包名
if (rel && existsSync(join(root, rel))) {
  const source = readFileSync(join(root, rel), 'utf8')
  const match = source.match(/__ModuleLoader__\.load\(\s*\{[\s\S]{0,200}?id:\s*['"]([^'"]+)['"]/)
  check(
    '浏览器半注册的模块 id 等于包名',
    Boolean(match) && match[1] === pkg.name,
    match ? match[1] : '未找到 __ModuleLoader__.load({ id })',
  )
}

// 5. patch 形状：插入本包名
if (typeof patchRel === 'string' && existsSync(join(root, patchRel))) {
  const yaml = readFileSync(join(root, patchRel), 'utf8')
  check('patch 含 insert', /insert\s*:/.test(yaml))
  check('patch 引用了包名 ' + pkg.name, yaml.includes(pkg.name))
}

console.log(failures === 0 ? '\n清单自检通过。' : '\n失败 ' + failures + ' 项。')
process.exit(failures === 0 ? 0 : 1)
