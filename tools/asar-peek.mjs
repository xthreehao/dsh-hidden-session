/**
 * 从 app.asar 里读取单个文件 / 检索内容（零依赖）。
 *
 * 用法：
 *   node tools/asar-peek.mjs <asar> <内部路径> [grep 正则]
 * 例（桌面版把 asar 装在 <安装目录>\resources\app.asar，DSH 包在其 dsh\ 子目录下）：
 *   node tools/asar-peek.mjs "<安装目录>\resources\app.asar" "dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js" "data-row-key"
 *
 * asar 布局（与 @electron/asar 的 reader 一致，自校验）：
 *   [0..3]   UInt32 = sizePickle 的 payload 长度（=4）
 *   [4..7]   UInt32 = headerBuf 长度 H
 *   [8..8+H) headerBuf = [UInt32 payloadSize][UInt32 字符串长度][header JSON][padding]
 *   dataStart = 8 + H，文件内容偏移 = dataStart + Number(entry.offset)
 */

import { openSync, readSync, closeSync } from 'node:fs'

const [, , asarPath, innerPath, pattern] = process.argv
if (!asarPath || !innerPath) {
  console.error('用法: node asar-peek.mjs <asar> <内部路径> [grep 正则]')
  process.exit(2)
}

const fd = openSync(asarPath, 'r')
try {
  const sizeBuf = Buffer.alloc(8)
  if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('读不到 asar 头部')
  const declared = sizeBuf.readUInt32LE(0)
  const headerLen = sizeBuf.readUInt32LE(4)
  if (declared !== 4) throw new Error('asar sizePickle 异常: ' + declared)

  const headerBuf = Buffer.alloc(headerLen)
  if (readSync(fd, headerBuf, 0, headerLen, 8) !== headerLen) throw new Error('读不到 asar header')
  const stringLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.subarray(8, 8 + stringLen).toString('utf8'))
  const dataStart = 8 + headerLen

  // 走目录树找到目标文件
  const parts = innerPath.split('/').filter(Boolean)
  let node = header
  for (let i = 0; i < parts.length; i++) {
    const files = node.files
    if (!files || !files[parts[i]]) throw new Error('asar 内找不到: ' + parts.slice(0, i + 1).join('/'))
    node = files[parts[i]]
  }
  if (node.files) throw new Error('目标是目录，不是文件: ' + innerPath)
  if (typeof node.offset !== 'string') throw new Error('目标缺少 offset 字段（asar 目录项）')

  const size = Number(node.size)
  const offset = dataStart + Number(node.offset)
  const out = Buffer.alloc(size)
  if (readSync(fd, out, 0, size, offset) !== size) throw new Error('读不到文件内容')
  const text = out.toString('utf8')

  console.log('# ' + innerPath + '  size=' + size)
  if (!pattern) {
    process.stdout.write(text)
  } else {
    const re = new RegExp(pattern, 'g')
    const lines = text.split('\n')
    let hits = 0
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      re.lastIndex = 0
      hits++
      if (hits <= 40) console.log((i + 1) + ': ' + lines[i].trim().slice(0, 400))
    }
    console.log('# 命中 ' + hits + ' 行')
  }
} finally {
  closeSync(fd)
}
