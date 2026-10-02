/**
 * dsh-hidden-session —— 宿主侧（Host half）。
 *
 * 职责：把「已隐藏会话 id 集合」持久化到磁盘，并通过一组本地回环 HTTP 路由
 * 暴露给浏览器侧。隐藏本身只是显示层筛选，因此本插件**不触碰**任何会话数据：
 * 不移动、不删除、不改写会话日志，也不碰 workspace.json / session_projcache.json。
 *
 * 路由（均为 loopback-only + 同源校验，与 DSH /api 网关的信任栅栏一致）：
 *   GET  /api/dsh-hidden-session/state     — 读取隐藏集合
 *   POST /api/dsh-hidden-session/hide      — 隐藏 { sessionId } 或 { sessionIds: [] }
 *   POST /api/dsh-hidden-session/show      — 恢复 { sessionId } 或 { sessionIds: [] }
 *   POST /api/dsh-hidden-session/show-all  — 清空隐藏集合
 * 每个写操作都返回写入后的完整状态，浏览器侧据此刷新。
 *
 * 状态文件：~/.dsh/storages/dsh-hidden-session.json（原子写，权限 0600）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 稳定的 cordis 插件名。 */
export const name = 'dsh-hidden-session'

/** 只需要宿主 Web 服务器服务；刻意不依赖 workspaceRegistry / 会话存储。 */
export const inject = ['webServer']

/** API 路径前缀。 */
const API_PREFIX = '/api/dsh-hidden-session'

/** 请求体上限（只传 id，很小）。 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** 状态文件 schema 版本。 */
const STORE_VERSION = 1

/**
 * 允许的会话 id 形态：DSH 的会话 id 是 UUID（可能带 `session-` 前缀），
 * 白名单化可以顺手挡掉路径穿越与 CSS 选择器注入。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** DSH home 目录。 */
function dshHome() {
  return join(homedir(), '.dsh')
}

/** 状态文件路径。 */
function storePath() {
  return join(dshHome(), 'storages', 'dsh-hidden-session.json')
}

/** 安全读取并解析 JSON；任何异常都退化为 undefined。 */
function readJsonFile(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/** 原子写 JSON（tmp + rename），目录按需创建。 */
function writeJsonFile(filePath, data) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}

/** 把任意输入规整为合法的 id 数组（去重、保序）。 */
function normalizeIds(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!SESSION_ID_PATTERN.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 读取当前持久化状态；损坏或缺失时返回空集合。 */
function loadState() {
  const raw = readJsonFile(storePath())
  const hidden = raw === undefined ? [] : normalizeIds(raw.hidden)
  return {
    version: STORE_VERSION,
    hidden,
    updatedAt: raw !== undefined && typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

/** 持久化一份新状态并返回它。 */
function saveState(state) {
  const next = {
    version: STORE_VERSION,
    hidden: normalizeIds(state.hidden),
    updatedAt: Date.now(),
  }
  writeJsonFile(storePath(), next)
  return next
}

/** 回环地址检查 + 浏览器同源标记（与 DSH 官方插件同一套判定）。 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读取 JSON 请求体；超限或非法时返回 undefined。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 挂载隐藏集合的 HTTP 路由。
 * @param ctx - cordis 宿主上下文（需要 webServer 服务）。
 */
export function apply(ctx) {
  const stateRoute = {
    kind: 'exact',
    path: API_PREFIX + '/state',
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        writeJson(res, 200, loadState())
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const hideRoute = {
    kind: 'exact',
    path: API_PREFIX + '/hide',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const ids = normalizeIds(Array.isArray(body.sessionIds) ? body.sessionIds : body.sessionId)
      if (ids.length === 0) {
        writeJson(res, 400, { error: 'sessionId (string) or sessionIds (array) is required' })
        return
      }
      try {
        const current = loadState()
        const merged = current.hidden.slice()
        const known = new Set(merged)
        for (const id of ids) {
          if (known.has(id)) continue
          known.add(id)
          merged.push(id)
        }
        const next = saveState({ hidden: merged })
        writeJson(res, 200, { ...next, changed: merged.length - current.hidden.length })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const showRoute = {
    kind: 'exact',
    path: API_PREFIX + '/show',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const ids = normalizeIds(Array.isArray(body.sessionIds) ? body.sessionIds : body.sessionId)
      if (ids.length === 0) {
        writeJson(res, 400, { error: 'sessionId (string) or sessionIds (array) is required' })
        return
      }
      try {
        const current = loadState()
        const drop = new Set(ids)
        const kept = current.hidden.filter((id) => !drop.has(id))
        const next = saveState({ hidden: kept })
        writeJson(res, 200, { ...next, changed: current.hidden.length - kept.length })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const showAllRoute = {
    kind: 'exact',
    path: API_PREFIX + '/show-all',
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        const current = loadState()
        const next = saveState({ hidden: [] })
        writeJson(res, 200, { ...next, changed: current.hidden.length })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const routes = [stateRoute, hideRoute, showRoute, showAllRoute]

  // 路由的生命周期跟随 fiber：dispose 时全部注销。
  // 逐条 try/catch：applyEntryPatches 的 insert 是无条件 append（不去重），如果同一个 profile
  // 里被两条安装路径同时插入（bundle 层的 cordis.patch.yml + profile 自己的 patch 层），
  // 第二份实例会撞上 webserver 的 "duplicate exact route" 判定。宁可少注册一条，也绝不能让
  // 启动/热重载失败——那种情况下第一份实例的注册仍然完整可用。
  ctx.effect(
    () => {
      const disposers = []
      for (const route of routes) {
        try {
          disposers.push(ctx.webServer.register(route))
        } catch (err) {
          console.warn(
            '[dsh-hidden-session] 跳过重复路由 ' + route.path + '：'
            + (err instanceof Error ? err.message : String(err)),
          )
        }
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-hidden-session: routes',
  )
}
