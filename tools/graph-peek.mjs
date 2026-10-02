/**
 * 读取运行中 DSH 的客户端插件图（SSE 首帧）以确认某插件的浏览器半是否已注册。
 *
 * 用法：node graph-peek.mjs [url] [idFilter]
 *   node graph-peek.mjs                                  # 默认 http://127.0.0.1:19387/plugins/events
 *   node graph-peek.mjs http://127.0.0.1:19387/plugins/events dsh-hidden-session
 *
 * 说明：/plugins/events 是 dsh-client-hmr 注册的 exact 路由（不在 /api 的鉴权栅栏后），
 * 连接建立时会先发一帧 {type:"graph", graph:{entries:[{id,url,rev,...}]}}。
 */

const url = process.argv[2] || 'http://127.0.0.1:19387/plugins/events'
const filter = process.argv[3]

const res = await fetch(url, { headers: { accept: 'text/event-stream' } })
if (!res.ok) {
  console.log('STATUS ' + res.status + '（SSE 不可用）')
  process.exit(1)
}

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const deadline = Date.now() + 8000

while (Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  if (buffer.includes('\n\n')) break
}
try { reader.cancel() } catch {}

const frame = buffer.split('\n\n').find((part) => part.includes('data:')) || buffer
const payloadLine = frame.split('\n').find((line) => line.startsWith('data:')) || ''
let graph = null
try {
  graph = JSON.parse(payloadLine.slice(5).trim())
} catch {
  console.log('原始帧：')
  console.log(buffer.slice(0, 2000))
  process.exit(0)
}

const entries = (graph && graph.graph && graph.graph.entries) || graph.entries || []
console.log('frame.type = ' + graph.type + '，entries = ' + entries.length)
for (const entry of entries) {
  const mark = filter && entry.id === filter ? '   <== 目标' : ''
  console.log('  - ' + entry.id + '  rev=' + entry.rev + (entry.immediately ? ' immediately' : '') + mark)
}
if (filter) {
  const hit = entries.find((entry) => entry.id === filter)
  console.log(hit ? '\n结论：' + filter + ' 的浏览器半已注册 => ' + hit.url : '\n结论：图中没有 ' + filter)
}
process.exit(0)
