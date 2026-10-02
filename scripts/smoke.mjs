#!/usr/bin/env node
/**
 * dsh-hidden-session —— 宿主侧自检脚本（零依赖，Node 18+）。
 *
 * 只验证「宿主半」：路由是否挂上、状态是否真的持久化、校验是否拒绝非法 id。
 * 浏览器半（菜单项 / CSS 隐藏 / 设置卡片）需要人工在界面里点一遍。
 *
 * 用法：
 *   node scripts/smoke.mjs                         # 默认 http://127.0.0.1:3080
 *   node scripts/smoke.mjs 19387                   # 只给端口
 *   node scripts/smoke.mjs http://127.0.0.1:19387  # 或直接给基地址
 *
 * 安全：脚本只用一个假 id（smoke-test-0000）做增删，结束时恢复运行前的隐藏集合。
 * /show-all 只有在运行前集合为空时才会被测试，避免抹掉你真实的隐藏列表。
 */

const PROBE_ID = 'smoke-test-0000'
const INVALID_ID = '../evil" injection'

/** 解析目标基地址。 */
function resolveBase() {
  const arg = process.argv[2]
  if (!arg) return 'http://127.0.0.1:3080'
  if (/^https?:\/\//.test(arg)) return arg.replace(/\/+$/, '')
  return 'http://127.0.0.1:' + arg
}

const BASE = resolveBase() + '/api/dsh-hidden-session'

let failures = 0

/** 调用一次接口，返回 { status, body }。 */
async function call(method, path, body) {
  const options = { method }
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' }
    options.body = JSON.stringify(body)
  }
  const res = await fetch(BASE + path, options)
  let parsed = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

/** 断言并打印。 */
function check(label, ok, detail) {
  if (ok) {
    console.log('  PASS  ' + label)
  } else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

async function main() {
  console.log('dsh-hidden-session smoke test → ' + BASE)

  // 1. 读状态
  let state
  try {
    state = await call('GET', '/state')
  } catch (err) {
    console.log('  FAIL  GET /state 无法连接 — ' + (err && err.message ? err.message : String(err)))
    console.log('\n结论：宿主半没有响应。请确认 DSH 已重启、bundles 含 dsh-hidden-session、端口正确。')
    process.exit(1)
  }
  check('GET /state 返回 200', state.status === 200, 'status=' + state.status)
  const original = state.body && Array.isArray(state.body.hidden) ? state.body.hidden : null
  check('GET /state 返回 hidden 数组', Array.isArray(original), JSON.stringify(state.body))

  // 2. 隐藏一个假 id
  const hide = await call('POST', '/hide', { sessionId: PROBE_ID })
  check('POST /hide 返回 200', hide.status === 200, 'status=' + hide.status)
  check('隐藏后集合包含探针 id', !!hide.body && Array.isArray(hide.body.hidden) && hide.body.hidden.includes(PROBE_ID))

  // 3. 重新读取，确认落盘可见
  const reread = await call('GET', '/state')
  check('重新读取仍包含探针 id（持久化生效）', !!reread.body && Array.isArray(reread.body.hidden) && reread.body.hidden.includes(PROBE_ID))

  // 4. 非法 id 必须被拒
  const bad = await call('POST', '/hide', { sessionId: INVALID_ID })
  check('非法 id 被拒（400）', bad.status === 400, 'status=' + bad.status + ' body=' + JSON.stringify(bad.body))

  // 5. 恢复探针 id
  const show = await call('POST', '/show', { sessionId: PROBE_ID })
  check('POST /show 返回 200', show.status === 200, 'status=' + show.status)
  check('恢复后集合不含探针 id', !!show.body && Array.isArray(show.body.hidden) && !show.body.hidden.includes(PROBE_ID))

  // 6. /show-all 只在安全前提下测试
  if (original !== null && original.length === 0) {
    const all = await call('POST', '/show-all', {})
    check('POST /show-all 返回 200', all.status === 200, 'status=' + all.status)
  } else {
    console.log('  SKIP  POST /show-all（运行前已有 ' + (original === null ? '?' : original.length) + ' 个隐藏会话，跳过以免清空）')
  }

  // 7. 还原运行前的隐藏集合
  if (original !== null && original.length > 0) {
    const restore = await call('POST', '/hide', { sessionIds: original })
    check('运行前的隐藏集合已还原', !!restore.body && Array.isArray(restore.body.hidden) && original.every((id) => restore.body.hidden.includes(id)))
  }

  console.log(failures === 0 ? '\n全部通过。' : '\n失败 ' + failures + ' 项。')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('smoke test 异常：', err)
  process.exit(1)
})
