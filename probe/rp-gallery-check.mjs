// 图库探针：改名 / 显示名 / rp_gallery 工具 / 排列字段
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'rp-studio-gallery-'))
process.env.DSH_HOME = root

// 造几张假图：工坊图库两张、roleplay 全局一张
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AH+2m2nAAAAAElFTkSuQmCC',
  'base64'
)
await mkdir(join(root, 'rp-studio', 'images'), { recursive: true })
await writeFile(join(root, 'rp-studio', 'images', 'rain.png'), png)
await writeFile(join(root, 'rp-studio', 'images', 'sunset.png'), png)
await mkdir(join(root, 'roleplay', 'images'), { recursive: true })
await writeFile(join(root, 'roleplay', 'images', 'gen-001.png'), png)

const plugin = await import('../lib/index.js')

let handler
let createdHook
let toolDef
const ctx = {
  webServer: { register: (route) => { handler = route.handler; return () => {} } },
  on: (name, fn) => { if (name === 'agent/created') createdHook = fn },
  tools: { register: (def) => { toolDef = def; return () => {} } },
  logger: { info: () => {}, warn: () => {} }
}
plugin.apply(ctx)
if (!handler) throw new Error('route not registered')
if (!toolDef) throw new Error('rp_gallery not registered')

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

// ---- 工具注册面 ----
check('tool name', toolDef.name === 'rp_gallery', toolDef.name)
check('tool output.render is function', typeof toolDef.output.render === 'function')
check('tool parameters has name filter', Boolean(toolDef.parameters.properties.name))

// ---- 列表与显示名 ----
const list1 = await get('/gallery')
check('gallery lists three images', list1.body.images.length === 3, `${list1.body.images.length}`)
const rain = list1.body.images.find((image) => image.fileName === 'rain.png')
check('default display name falls back to filename stem', rain && rain.name === 'rain', rain && rain.name)
check('list row carries url for tool', Boolean(rain && rain.url && rain.url.startsWith('/x-rp-studio/gallery/')))

const renamed = await send('/gallery/studio/rain.png/rename', 'POST', { name: '雨夜的阳台' })
check('rename returns new display name', renamed.status === 200 && renamed.body.name === '雨夜的阳台', renamed.body.name)
const list2 = await get('/gallery')
const rain2 = list2.body.images.find((image) => image.fileName === 'rain.png')
check('gallery list shows custom name', rain2 && rain2.name === '雨夜的阳台', rain2 && rain2.name)
check('file on disk keeps its name', Boolean(rain2 && rain2.fileName === 'rain.png'))

const cleared = await send('/gallery/studio/sunset.png/rename', 'POST', { name: '   ' })
check('blank rename clears back to filename', cleared.body.name === 'sunset', cleared.body.name)

// ---- rp_gallery 工具执行 ----
const all = await toolDef.execute({})
check('tool sees every image', all.count === 3, `${all.count}`)
check('tool rows are name/fileName/source', Object.keys(all.images[0]).sort().join(',') === 'bytes,createdAt,fileName,name,source', Object.keys(all.images[0]).join(','))
const byName = await toolDef.execute({ name: '阳台' })
check('tool filters by custom name', byName.count === 1 && byName.images[0].fileName === 'rain.png', `${byName.count}`)
const byFile = await toolDef.execute({ name: 'gen-001' })
check('tool filters by filename', byFile.count === 1 && byFile.images[0].source === 'roleplay0', `${byFile.count}`)
const bySource = await toolDef.execute({ source: 'studio' })
check('tool filters by source', bySource.count === 2, `${bySource.count}`)
const rendered = toolDef.output.render({}, all)
check('render lists names in Chinese', rendered.includes('图库里共 3 张图') && rendered.includes('雨夜的阳台') && rendered.includes('gen-001'), rendered.split('\n')[0])

// ---- 删图会带走显示名 ----
const removed = await send('/gallery/studio/rain.png', 'DELETE', {})
check('delete studio image', removed.status === 200)
const afterDelete = await get('/gallery')
check('deleted image leaves the list', afterDelete.body.images.length === 2, `${afterDelete.body.images.length}`)
const indexRaw = await get('/gallery')
check('index kept for remaining image', Boolean(indexRaw.body.images.find((image) => image.fileName === 'sunset.png')))

console.log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
server.close()
await rm(root, { recursive: true, force: true })
if (failed !== 0) process.exitCode = 1
