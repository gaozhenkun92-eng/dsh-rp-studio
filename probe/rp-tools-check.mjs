// 权限设置探针：默认全关 + 总开关 + 六组白名单 + 「给予以上之外的其他完整权限」+ 未知工具名降级。
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'rp-studio-tools-'))
process.env.DSH_HOME = root

const plugin = await import('../lib/index.js')

let handler
let createdHook
const ctx = {
  webServer: { register: (route) => { handler = route.handler; return () => {} } },
  on: (name, fn) => { if (name === 'agent/created') createdHook = fn },
  tools: { register: () => () => {} },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  logger: { info: () => {}, warn: () => {} }
}
plugin.apply(ctx)
if (!handler) throw new Error('route not registered')
if (!createdHook) throw new Error('agent/created hook not registered')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/x-rp-studio`

let failed = 0
function check(label, ok, extra = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`)
}
async function get(path) {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}
async function send(path, method, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

// ---- 1. 默认：总开关关、六组全关、不给额外权限 ----
const initial = await get('/tools')
const groups = initial.body.toolGroups || {}
check('GET /tools enabled=false', initial.body.enabled === false)
check('GET /tools allowOthers=false', initial.body.allowOthers === false)
check('GET /tools 没有 denyOthers 字段', initial.body.denyOthers === undefined)
check('GET /tools groups', Object.keys(groups).length === 6, JSON.stringify(groups))
check('all groups off by default', Object.values(groups).every((v) => v === false), JSON.stringify(groups))

// ---- 2. 关着的时候完全不动工具面 ----
let captured = null
const restrictCalls = []
const fakeTools = {
  restrict: (filter) => {
    restrictCalls.push(filter)
    captured = filter
    return () => { captured = { released: true } }
  }
}
const agent1 = { id: 'agent-test-1', ctx: { tools: fakeTools } }
await createdHook({ agent: agent1 })
check('disabled -> restrict not called', restrictCalls.length === 0, JSON.stringify(restrictCalls))

// ---- 3. 打开总开关 + 六组全关 → 白名单为空，什么都拿不到 ----
const on = await send('/tools', 'POST', { enabled: true })
check('POST /tools enabled=true', on.body.enabled === true)
check('enabling reapplies to live agents', on.body.applied >= 1, String(on.body.applied))
check('enabled + 六组全关 -> allow 空表', Array.isArray(captured && captured.allow) && captured.allow.length === 0, JSON.stringify(captured))
check('白名单模式没有 deny', captured && captured.deny === undefined)

// ---- 4. 只开文件读写 ----
restrictCalls.length = 0
const fsOn = await send('/tools', 'POST', { toolGroups: { fs: true } })
check('POST /tools fs=true', fsOn.body.toolGroups.fs === true, JSON.stringify(fsOn.body.toolGroups))
check('fs 开 -> allow 就是那六个', Array.isArray(captured.allow) && captured.allow.join(',') === 'read,write,edit,read_image,glob,grep', JSON.stringify(captured.allow))

// ---- 5. 给予以上之外的其他完整权限 → 完全不限制 ----
restrictCalls.length = 0
const allowMode = await send('/tools', 'POST', { allowOthers: true })
check('POST /tools allowOthers=true', allowMode.body.allowOthers === true)
check('allowOthers 打开 -> 一次 restrict 都不调', restrictCalls.length === 0, JSON.stringify(restrictCalls))
check('allowOthers 打开 -> 旧过滤器被释放', captured && captured.released === true, JSON.stringify(captured))

// ---- 6. 收回来 → 又变白名单 ----
restrictCalls.length = 0
await send('/tools', 'POST', { allowOthers: false })
check('allowOthers 关回 -> 重新挂 allow', Array.isArray(captured.allow) && captured.allow.includes('read'), JSON.stringify(captured.allow))

// ---- 7. 未知工具名降级：restrict 抛错时按名字剔掉再重试 ----
const retryTools = {
  restrict: (filter) => {
    const names = filter.deny || filter.allow || []
    if (names.includes('bash')) {
      throw new Error('unknown global tool "bash"; known global tools: pwsh, read')
    }
    captured = filter
    return () => {}
  }
}
restrictCalls.length = 0
await send('/tools', 'POST', { toolGroups: { shell: true } })
await createdHook({ agent: { id: 'agent-test-2', ctx: { tools: retryTools } } })
check('unknown tool dropped and retried', Array.isArray(captured.allow) && captured.allow.includes('bash') === false, JSON.stringify(captured.allow))
check('其它 allow 保留', captured.allow.includes('pwsh') === true)

// ---- 8. 关掉总开关 → 释放，不再有过滤器 ----
const off = await send('/tools', 'POST', { enabled: false })
check('POST /tools enabled=false', off.body.enabled === false)
check('disabled 后 captured 变 released', captured && captured.released === true, JSON.stringify(captured))

// ---- 9. 400 分支 ----
const bad = await send('/tools', 'POST', {})
check('空 body 返回 400', bad.status === 400)

await rm(root, { recursive: true, force: true })
server.close()
console.log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 50).unref()
