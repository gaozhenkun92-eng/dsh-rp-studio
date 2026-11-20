// 宿主入口：把角色卡、提示词预览、会话记录暴露成 /x-rp-studio/* 的本地接口。
// 客户端 bundle 只负责画界面；数据全部落在 $DSH_HOME/rp-studio/。
import { join } from 'node:path'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import {
  ensureDirs,
  paths,
  readJson,
  writeJson,
  listFiles,
  removeFile,
  loadSettings,
  saveSettings
} from './store.js'
import {
  parseCardBuffer,
  exportPng,
  cardPlainText,
  cardFromText,
  normalizeCard,
  toV2,
  toV3,
  minimalPng,
  isPng
} from './card.js'
import { assemblePrompt } from './prompt.js'
import {
  listChats,
  loadChat,
  saveChat,
  createChat,
  deleteChat,
  appendMessage,
  addVariant,
  selectVariant,
  editMessage
} from './session.js'
import { buildRoleplaySystem } from './agent.js'

export const name = 'dsh-rp-studio'
export const inject = ['webServer', 'systemPrompt', 'tools']

const PREFIX = '/x-rp-studio'

// 全局人格段：注册在**部署层**（不是某个 preset 里），所以每一个会话、每一个
// 预设都会带上它 —— 不需要「选一个角色扮演模式」。
//
// 名字特意不叫 'deployment:persona-prefix'：那个名字已经被 system-prompt 自己的
// 部署层条目占着，同一层重名会直接抛错。用 0.5 这个 order 把它插在部署层
// persona（0）之后、plan policy（500）之前，位置等价。
const PERSONA_SECTION = 'rp-studio:persona'
const PERSONA_ORDER = 0.5

// 清洗设置：每一个开关对应一组工具名。关掉的那组在 agent 创建时用
// agent.ctx.tools.restrict({ deny }) 摘掉 —— 这是运行时的真开关，不是摆设。
const TOOL_GROUPS = {
  fs: ['read', 'write', 'edit', 'read_image', 'glob', 'grep'],
  shell: ['pwsh', 'bash', 'job_output', 'job_kill', 'job_list'],
  web: ['web_search', 'web_fetch'],
  subagent: ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'workflow'],
  skill: ['skill', 'present', 'todo_write', 'create_goal', 'get_goal', 'update_goal'],
  gallery: ['rp_gallery']
}

// 图库工具是否真的挂上了；没挂上就不能把 rp_gallery 塞进 deny（restrict 会因未知名字抛错）
let galleryToolReady = false

function deniedToolsFor(groups) {
  const deny = []
  for (const [key, names] of Object.entries(TOOL_GROUPS)) {
    if (groups && groups[key] === false) {
      for (const toolName of names) {
        if (toolName === 'rp_gallery' && !galleryToolReady) continue
        deny.push(toolName)
      }
    }
  }
  return deny
}

// 白名单方向：所有被放行的组里的工具名。denyOthers 打开时用它做 allow。
function allowedToolsFor(groups) {
  const allow = []
  for (const [key, names] of Object.entries(TOOL_GROUPS)) {
    if (groups && groups[key] === true) {
      for (const toolName of names) {
        if (toolName === 'rp_gallery' && !galleryToolReady) continue
        allow.push(toolName)
      }
    }
  }
  return allow
}

// 插件关着 → 不动工具面（null）；否则按「黑名单」或「白名单」出一种限制。
function restrictFilterFor(settings) {
  if (!settings || settings.enabled === false) return null
  const groups = settings.toolGroups || {}
  if (settings.denyOthers === true) return { allow: allowedToolsFor(groups) }
  const deny = deniedToolsFor(groups)
  return deny.length > 0 ? { deny } : null
}

// tools.restrict() 对**未知**工具名会抛错（名字不在该 scope 的可限制集合里）。
// 宿主 preset 不同，能出现的工具也不同（比如 win32 上没有 bash），所以这里按
// 报错里列出的名字逐个剔掉再重试，而不是让整次限制静默失败。
function safeRestrict(tools, filter) {
  let next = { ...filter }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const list = next.deny || next.allow || []
    if (list.length === 0 && next.deny) return null
    try {
      return tools.restrict(next)
    } catch (error) {
      const message = String((error && error.message) || '')
      const marked = /unknown global tool[s]? (.+?); known global tools/.exec(message)
      if (!marked) throw error
      const unknown = [...marked[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      if (unknown.length === 0) throw error
      if (next.deny) next = { ...next, deny: next.deny.filter((n) => !unknown.includes(n)) }
      if (next.allow) next = { ...next, allow: next.allow.filter((n) => !unknown.includes(n)) }
    }
  }
  throw new Error('rp-studio: tools.restrict() 无法收敛（未知工具名太多）')
}

// agentId -> disposer，用来在用户拨动开关后撤掉旧限制、按新设置重挂。
const toolGates = new Map()
// 活着且见过的 agent，拨开关时按新设置重挂。
const liveAgents = new Map()

function releaseGate(agentId) {
  const disposer = toolGates.get(agentId)
  if (!disposer) return
  toolGates.delete(agentId)
  try {
    disposer()
  } catch {
    /* 已经失效 */
  }
}

function applyToolGate(agent, settings) {
  if (!agent || !agent.id) return
  releaseGate(agent.id)
  const filter = restrictFilterFor(settings)
  if (!filter) return
  const tools = agent.ctx && agent.ctx.tools
  if (!tools || typeof tools.restrict !== 'function') return
  try {
    const disposer = safeRestrict(tools, filter)
    if (disposer) toolGates.set(agent.id, disposer)
  } catch {
    /* 老 agent 的 scope 已经关了，下一次创建再挂 */
  }
}

// 设置一变就按新设置把活着的 agent 全部重挂一遍。
async function reapplyToolGates(settings) {
  let applied = 0
  for (const agent of liveAgents.values()) {
    applyToolGate(agent, settings)
    applied += 1
  }
  return applied
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendBuffer(res, status, buffer, type, filename) {
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': buffer.length
  }
  if (filename) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`
  res.writeHead(status, headers)
  res.end(buffer)
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const parts = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('body too large')
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

async function readJsonBody(req) {
  const buffer = await readBody(req)
  if (buffer.length === 0) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error('body is not JSON')
  }
}

function cardPath(id) {
  return join(paths().cards, `${id}.json`)
}

const GLOBAL_WORLDBOOK = '_global'

function worldbookPath(scopeId) {
  return join(paths().worldbooks, `${scopeId}.json`)
}

function normalizeEntry(raw) {
  const source = raw || {}
  const keys = Array.isArray(source.keys)
    ? source.keys
    : String(source.keys || '')
        .split(/[,，\n]/)
        .map((k) => k.trim())
        .filter(Boolean)
  return {
    id: source.id || `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(source.name || keys[0] || '未命名条目').slice(0, 60),
    // 大集合：空字符串表示「未归类」
    group: String(source.group || '').slice(0, 60),
    enabled: source.enabled !== false,
    keys: keys.map((k) => String(k).trim()).filter(Boolean),
    content: String(source.content || ''),
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 5,
    always: source.always === true
  }
}

// 一个作用域的世界书文件 = { groups: [集合名], entries: [条目] }；
// 老文件是扁平数组，读的时候自动升级
function normalizeBook(raw) {
  const source = raw && !Array.isArray(raw) ? raw : {}
  const entries = (Array.isArray(raw) ? raw : Array.isArray(source.entries) ? source.entries : []).map(normalizeEntry)
  const groups = []
  for (const name of Array.isArray(source.groups) ? source.groups : []) {
    const clean = String(name || '').trim().slice(0, 60)
    if (clean && !groups.includes(clean)) groups.push(clean)
  }
  for (const entry of entries) {
    if (entry.group && !groups.includes(entry.group)) groups.push(entry.group)
  }
  return { groups, entries }
}

async function readBook(scopeId) {
  return normalizeBook(await readJson(worldbookPath(scopeId), null))
}

async function loadWorldbook(cardId) {
  const globalBook = await readBook(GLOBAL_WORLDBOOK)
  const cardBook = cardId ? await readBook(cardId) : { groups: [], entries: [] }
  return {
    global: globalBook.entries,
    card: cardBook.entries,
    groups: { global: globalBook.groups, card: cardBook.groups }
  }
}

async function persistBook(cardId, scope, book) {
  if (scope === 'global') {
    await writeJson(worldbookPath(GLOBAL_WORLDBOOK), book)
    return
  }
  if (cardId) await writeJson(worldbookPath(cardId), book)
}

// 把角色卡自带的世界书落进本卡条目文件，返回新增条数。card 上的临时字段会被清掉。
async function absorbEmbeddedWorldbook(card) {
  const embedded = Array.isArray(card.embeddedWorldbook) ? card.embeddedWorldbook : []
  delete card.embeddedWorldbook
  if (embedded.length === 0) return 0
  const book = await readBook(card.id)
  const seen = new Set(book.entries.map((e) => `${e.name}\u0000${e.keys.join(',')}\u0000${e.content}`))
  let added = 0
  for (const raw of embedded) {
    const entry = normalizeEntry(raw)
    const fingerprint = `${entry.name}\u0000${entry.keys.join(',')}\u0000${entry.content}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    book.entries.push(entry)
    if (entry.group && !book.groups.includes(entry.group)) book.groups.push(entry.group)
    added += 1
  }
  if (added > 0) await persistBook(card.id, 'card', book)
  return added
}

function avatarPath(id) {
  return join(paths().cards, `${id}.png`)
}

// ---- 世界书导入/导出 ------------------------------------------------------
const WORLDBOOK_SPEC = 'rp-studio-worldbook'

// SillyTavern 世界书是 { entries: { "0": { key: [...], keysecondary, content, comment, constant, ... } } }
function parseWorldbookPayload(raw) {
  const push = (out, item) => {
    if (!item || typeof item !== 'object') return
    const keys = item.keys ?? item.key ?? item.keywords ?? ''
    const comment = String(item.name || item.comment || item.title || '')
    // 导出的 ST 文件会把集合写进 comment：「集合 / 名字」
    const slash = comment.indexOf(' / ')
    const group = item.group ?? (slash > 0 ? comment.slice(0, slash) : '')
    const entry = normalizeEntry({
      id: undefined,
      name: slash > 0 ? comment.slice(slash + 3) : comment,
      group,
      enabled: item.enabled !== false && item.disable !== true,
      keys,
      content: item.content ?? item.text ?? '',
      priority: item.priority ?? item.order ?? item.insertion_order,
      always: item.always === true || item.constant === true || item.force === true
    })
    if (!entry.content.trim()) return
    out.push(entry)
  }

  const out = []
  let source = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      // 纯文本：一行一条「关键词 | 内容」
      for (const line of String(raw).split(/\r?\n/)) {
        const text = line.trim()
        if (!text || text.startsWith('#')) continue
        const sep = text.search(/[|｜\t]/)
        if (sep > 0) {
          push(out, { keys: text.slice(0, sep), content: text.slice(sep + 1).trim() })
        } else {
          push(out, { keys: text.slice(0, 24), content: text })
        }
      }
      return out
    }
  }
  if (!source || typeof source !== 'object') return out
  if (Array.isArray(source)) {
    for (const item of source) push(out, item)
    return out
  }
  if (Array.isArray(source.entries)) {
    for (const item of source.entries) push(out, item)
    return out
  }
  if (source.entries && typeof source.entries === 'object') {
    for (const item of Object.values(source.entries)) push(out, item)
    return out
  }
  if (Array.isArray(source.global) || Array.isArray(source.card)) {
    for (const item of [...(source.global || []), ...(source.card || [])]) push(out, item)
    return out
  }
  push(out, source)
  return out
}

function buildWorldbookExport(entries, { scope, cardId, fmt }) {
  const list = (entries || []).map((e) => normalizeEntry(e))
  if (fmt === 'st') {
    const table = {}
    list.forEach((entry, index) => {
      table[String(index)] = {
        uid: index,
        key: entry.keys,
        keysecondary: [],
        comment: entry.group ? `${entry.group} / ${entry.name}` : entry.name,
        content: entry.content,
        constant: entry.always === true,
        selective: false,
        order: entry.priority,
        disable: entry.enabled === false
      }
    })
    return { entries: table }
  }
  return {
    spec: WORLDBOOK_SPEC,
    version: 1,
    scope: scope || 'card',
    cardId: cardId || '',
    exportedAt: new Date().toISOString(),
    entries: list
  }
}

// 图库来源：
//   studio     —— 工坊自己的 images/（可删）
//   roleplay0  —— dsh-roleplay 的全局出图目录 $DSH_HOME/roleplay/images
//   roleplayN  —— 各工作区里的 <workspace>/.dsh-roleplay/images（角色在对话里出的图）
// 后两类只读：可以设为头像、可以「收藏到图库」（复制一份），不能直接删。
function galleryRoots() {
  const home = join(paths().root, '..')
  const roots = [{ source: 'studio', dir: paths().images }]
  roots.push({ source: 'roleplay0', dir: join(home, 'roleplay', 'images') })
  let index = 1
  try {
    const raw = readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')
    const spaces = (JSON.parse(raw).tables || {}).workspaces || {}
    for (const id of Object.keys(spaces)) {
      const wsPath = spaces[id] && spaces[id].path
      if (typeof wsPath !== 'string' || !wsPath) continue
      const dir = join(wsPath, '.dsh-roleplay', 'images')
      if (!existsSync(dir)) continue
      roots.push({ source: `roleplay${index}`, dir })
      index += 1
    }
  } catch {
    /* 工作区索引读不到就只列全局目录 */
  }
  return roots
}

function galleryDir(source) {
  const hit = galleryRoots().find((r) => r.source === source)
  return hit ? hit.dir : paths().images
}

// 图库显示名：磁盘文件名不动，显示名单独存在 images/index.json 里
// 结构 { "<source>/<fileName>": "显示名" }
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']

function imageNameIndexPath() {
  return join(paths().images, 'index.json')
}

function isImageFile(fileName) {
  const lower = String(fileName).toLowerCase()
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext))
}

async function readImageNames() {
  const raw = await readJson(imageNameIndexPath(), {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const clean = {}
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === 'string') clean[key] = raw[key]
  }
  return clean
}

async function setImageName(id, name) {
  const map = await readImageNames()
  const trimmed = String(name || '').trim().slice(0, 80)
  if (trimmed) map[id] = trimmed
  else delete map[id]
  await writeJson(imageNameIndexPath(), map)
  return map
}

function displayImageName(map, source, fileName) {
  const hit = map[`${source}/${fileName}`]
  if (typeof hit === 'string' && hit.trim()) return hit.trim()
  return fileName.replace(/\.[^.]+$/, '')
}

// 图库全量清单：路由与 rp_gallery 工具共用
async function listGalleryImages() {
  const names = await readImageNames()
  const items = []
  for (const root of galleryRoots()) {
    const files = await listFiles(root.dir)
    for (const fileName of files) {
      if (!isImageFile(fileName)) continue
      const info = await statFile(join(root.dir, fileName))
      if (!info) continue
      items.push({
        id: `${root.source}/${fileName}`,
        name: displayImageName(names, root.source, fileName),
        fileName,
        source: root.source,
        bytes: info.size,
        createdAt: info.mtime.toISOString(),
        url: `/x-rp-studio/gallery/${root.source}/${encodeURIComponent(fileName)}`,
        path: `/gallery/${root.source}/${encodeURIComponent(fileName)}`
      })
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function loadCard(id) {
  const card = await readJson(cardPath(id), null)
  if (!card) throw new Error(`card ${id} not found`)
  return card
}

async function saveCard(card) {
  card.updatedAt = new Date().toISOString()
  await writeJson(cardPath(card.id), card)
  return card
}

async function fileExists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

async function statFile(file) {
  try {
    return await stat(file)
  } catch {
    return null
  }
}

function detectImageExt(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buffer.toString('latin1', 0, 3) === 'GIF') return 'gif'
  return null
}

function imageMime(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return null
}

function newStamp() {
  return `img-${Date.now().toString(36)}`
}

// 当前绑定的角色卡：会话引擎（lib/agent.js）每轮读这个文件拼人格段
function activeFilePath() {
  return join(paths().root, 'active.json')
}

async function readActive() {
  const data = await readJson(activeFilePath(), null)
  return { cardId: (data && typeof data.cardId === 'string' && data.cardId) || '' }
}

async function cardSummaries() {
  const dir = paths().cards
  const names = await listFiles(dir, '.json')
  const out = []
  for (const fileName of names) {
    const card = await readJson(join(dir, fileName), null)
    if (!card) continue
    out.push({
      id: card.id,
      name: card.name,
      source: card.source,
      tags: card.tags || [],
      hasAvatar: await fileExists(avatarPath(card.id)),
      chars: (card.description || '').length,
      updatedAt: card.updatedAt
    })
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

async function routeRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/^\/x-rp-studio/, '') || '/'
  const method = req.method ?? 'GET'

  if (path === '/health') return sendJson(res, 200, { ok: true, root: paths().root })

  // ---- 角色卡 -----------------------------------------------------------
  if (path === '/cards' && method === 'GET') {
    return sendJson(res, 200, { cards: await cardSummaries() })
  }

  // ---- 当前绑定的角色卡（对话引擎从这里读） -------------------------------
  if (path === '/active') {
    if (method === 'GET') return sendJson(res, 200, await readActive())
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : ''
      if (cardId) {
        const card = await readJson(cardPath(cardId), null)
        if (!card) return sendJson(res, 404, { error: `card ${cardId} not found` })
      }
      await writeJson(activeFilePath(), { cardId, updatedAt: new Date().toISOString() })
      return sendJson(res, 200, { cardId })
    }
  }

  if (path === '/cards' && method === 'POST') {
    const body = await readJsonBody(req)
    let card
    if (typeof body.text === 'string') {
      card = cardFromText(body.text, body.name || '未命名角色')
    } else if (body.card && typeof body.card === 'object') {
      card = parseCardBuffer(Buffer.from(JSON.stringify(body.card), 'utf8'), { fallbackName: body.name })
    } else if (typeof body.name === 'string' && body.name.trim()) {
      // 新建：可以只给名字，也可以顺带把人设/背景故事/说话风格/特殊内容一起写进来
      card = normalizeCard(
        {
          name: body.name.trim(),
          description: body.description,
          scenario: body.scenario,
          personality: body.personality,
          post_history_instructions: body.postHistoryInstructions
        },
        { source: 'blank', fallbackName: body.name.trim() }
      )
    } else {
      return sendJson(res, 400, { error: '需要 name、text 或 card 字段' })
    }
    const worldbookImported = await absorbEmbeddedWorldbook(card)
    await saveCard(card)
    return sendJson(res, 200, { card, editorText: cardPlainText(card), worldbookImported })
  }

  if (path === '/cards/import' && method === 'POST') {
    const body = await readJsonBody(req)
    let buffer
    if (typeof body.base64 === 'string') buffer = Buffer.from(body.base64, 'base64')
    else if (typeof body.text === 'string') buffer = Buffer.from(body.text, 'utf8')
    else return sendJson(res, 400, { error: '需要 base64 或 text 字段' })
    const card = parseCardBuffer(buffer, { fallbackName: body.fileName || '未命名角色' })
    const worldbookImported = await absorbEmbeddedWorldbook(card)
    await saveCard(card)
    if (isPng(buffer)) await writeFile(avatarPath(card.id), buffer)
    return sendJson(res, 200, { card, editorText: cardPlainText(card), worldbookImported })
  }

  const cardMatch = path.match(/^\/cards\/([^/]+)$/)
  if (cardMatch) {
    const id = decodeURIComponent(cardMatch[1])
    if (method === 'GET') {
      const card = await loadCard(id)
      return sendJson(res, 200, { card, editorText: cardPlainText(card) })
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const card = await loadCard(id)
      if (typeof body.name === 'string' && body.name.trim()) card.name = body.name.trim()
      if (typeof body.text === 'string') {
        const parsed = cardFromText(body.text, card.name)
        card.description = parsed.description
        card.name = parsed.name || card.name
      }
      if (typeof body.description === 'string') card.description = body.description
      if (body.fields && typeof body.fields === 'object') Object.assign(card, body.fields)
      await saveCard(card)
      return sendJson(res, 200, { card, editorText: cardPlainText(card) })
    }
    if (method === 'DELETE') {
      await removeFile(cardPath(id))
      await removeFile(avatarPath(id))
      await removeFile(worldbookPath(id))
      // 卡没了，绑定也要跟着清空，否则 active.json 里留着一个已不存在的卡号
      const active = await readActive()
      if (active.cardId === id) {
        await writeJson(activeFilePath(), { cardId: '', updatedAt: new Date().toISOString() })
      }
      return sendJson(res, 200, { ok: true })
    }
  }

  const avatarMatch = path.match(/^\/cards\/([^/]+)\/avatar$/)
  if (avatarMatch) {
    const id = decodeURIComponent(avatarMatch[1])
    if (method === 'GET') {
      try {
        const buffer = await readFile(avatarPath(id))
        return sendBuffer(res, 200, buffer, 'image/png')
      } catch {
        return sendBuffer(res, 200, minimalPng(), 'image/png')
      }
    }
    if (method === 'POST') {
      const body = await readJsonBody(req)
      if (typeof body.base64 !== 'string') return sendJson(res, 400, { error: '需要 base64 字段' })
      await writeFile(avatarPath(id), Buffer.from(body.base64, 'base64'))
      return sendJson(res, 200, { ok: true })
    }
  }

  const exportMatch = path.match(/^\/cards\/([^/]+)\/export$/)
  if (exportMatch && method === 'GET') {
    const id = decodeURIComponent(exportMatch[1])
    const card = await loadCard(id)
    const fmt = (url.searchParams.get('fmt') || 'json').toLowerCase()
    const safeName = card.name.replace(/[\\/:*?"<>|]/g, '_')
    // 导出时把本卡世界书回填成 character_book，导回来能一起带走
    const bookEntries = (await readBook(id)).entries
    const withBook = (value) => {
      if (bookEntries.length === 0) return value
      if (!value.data) return value
      value.data.character_book = {
        name: card.name,
        entries: bookEntries.map((entry, index) => ({
          id: index,
          keys: entry.keys,
          secondary_keys: [],
          content: entry.content,
          comment: entry.group ? `${entry.group} / ${entry.name}` : entry.name,
          constant: entry.always === true,
          selective: false,
          insertion_order: entry.priority,
          enabled: entry.enabled !== false
        }))
      }
      return value
    }
    if (fmt === 'png') {
      let base = minimalPng()
      try {
        base = await readFile(avatarPath(id))
      } catch {
        /* 没有头像就用 1×1 底图 */
      }
      return sendBuffer(res, 200, exportPng(card, base), 'image/png', `${safeName}.png`)
    }
    if (fmt === 'txt') {
      return sendBuffer(res, 200, Buffer.from(cardPlainText(card), 'utf8'), 'text/plain; charset=utf-8', `${safeName}.txt`)
    }
    if (fmt === 'v3') {
      return sendBuffer(
        res,
        200,
        Buffer.from(JSON.stringify(withBook(toV3(card)), null, 2), 'utf8'),
        'application/json; charset=utf-8',
        `${safeName}.v3.json`
      )
    }
    return sendBuffer(
      res,
      200,
      Buffer.from(JSON.stringify(withBook(toV2(card)), null, 2), 'utf8'),
      'application/json; charset=utf-8',
      `${safeName}.json`
    )
  }

  // ---- 世界书：全局 + 本卡 -----------------------------------------------
  if (path === '/worldbook' && method === 'GET') {
    const cardId = url.searchParams.get('cardId') || ''
    const data = await loadWorldbook(cardId)
    return sendJson(res, 200, data)
  }

  if (path === '/worldbook' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const entry = normalizeEntry(body.entry || body)
    if (!entry.content.trim()) return sendJson(res, 400, { error: '内容不能为空' })
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    book.entries.push(entry)
    if (entry.group && !book.groups.includes(entry.group)) book.groups.push(entry.group)
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  // ---- 大集合（分类）------------------------------------------------------
  if (path === '/worldbook/group' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const name = String(body.name || '').trim().slice(0, 60)
    if (!name) return sendJson(res, 400, { error: '集合要有个名字' })
    if (scope === 'card' && !body.cardId) return sendJson(res, 400, { error: '本卡集合需要先选一张角色卡' })
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    if (!book.groups.includes(name)) book.groups.push(name)
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  if (path === '/worldbook/group/rename' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const from = String(body.from || '').trim()
    const to = String(body.to || '').trim().slice(0, 60)
    if (!from || !to) return sendJson(res, 400, { error: '改名的集合和名字都要填' })
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    if (!book.groups.includes(from)) return sendJson(res, 404, { error: 'collection not found' })
    book.groups = book.groups.map((g) => (g === from ? to : g))
    for (const entry of book.entries) {
      if (entry.group === from) entry.group = to
    }
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  if (path === '/worldbook/group/delete' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const name = String(body.name || '').trim()
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    const index = book.groups.indexOf(name)
    if (index < 0) return sendJson(res, 404, { error: 'collection not found' })
    book.groups.splice(index, 1)
    // keep = 只解散集合，条目退回「未归类」；不传则连条目一起删
    if (body.mode === 'keep') {
      for (const entry of book.entries) {
        if (entry.group === name) entry.group = ''
      }
    } else {
      book.entries = book.entries.filter((e) => e.group !== name)
    }
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  if (path === '/worldbook/group/toggle' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const name = String(body.name || '').trim()
    const enabled = body.enabled !== false
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    let touched = 0
    for (const entry of book.entries) {
      if (entry.group !== name) continue
      entry.enabled = enabled
      touched += 1
    }
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, { ...(await loadWorldbook(body.cardId)), touched })
  }

  if (path === '/worldbook/toggle' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    const target = book.entries.find((e) => e.id === body.id)
    if (!target) return sendJson(res, 404, { error: 'entry not found' })
    target.enabled = body.enabled !== false
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  if (path === '/worldbook/export' && method === 'GET') {
    const cardId = url.searchParams.get('cardId') || ''
    const scope = url.searchParams.get('scope') || 'card'
    const fmt = url.searchParams.get('fmt') === 'st' ? 'st' : 'rp'
    const data = await loadWorldbook(cardId)
    const entries = scope === 'global' ? data.global : scope === 'all' ? [...data.global, ...data.card] : data.card
    return sendJson(res, 200, buildWorldbookExport(entries, { scope, cardId, fmt }))
  }

  if (path === '/worldbook/import' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    if (scope === 'card' && !body.cardId) return sendJson(res, 400, { error: '导入到本卡需要先选一张角色卡' })
    const incoming = parseWorldbookPayload(body.data ?? body.text ?? body)
    if (incoming.length === 0) return sendJson(res, 400, { error: '这份文件里没有可识别的条目' })
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    const seen = new Set(book.entries.map((e) => `${e.name}\u0000${e.keys.join(',')}\u0000${e.content}`))
    let imported = 0
    let skipped = 0
    for (const entry of incoming) {
      const fingerprint = `${entry.name}\u0000${entry.keys.join(',')}\u0000${entry.content}`
      if (seen.has(fingerprint)) {
        skipped += 1
        continue
      }
      seen.add(fingerprint)
      book.entries.push(entry)
      if (entry.group && !book.groups.includes(entry.group)) book.groups.push(entry.group)
      imported += 1
    }
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, { imported, skipped, ...(await loadWorldbook(body.cardId)) })
  }

  if (path === '/worldbook/delete' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    const index = book.entries.findIndex((e) => e.id === body.id)
    if (index < 0) return sendJson(res, 404, { error: 'entry not found' })
    book.entries.splice(index, 1)
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  if (path === '/worldbook/update' && method === 'POST') {
    const body = await readJsonBody(req)
    const scope = body.scope === 'global' ? 'global' : 'card'
    const book = await readBook(scope === 'global' ? GLOBAL_WORLDBOOK : body.cardId)
    const index = book.entries.findIndex((e) => e.id === body.id)
    if (index < 0) return sendJson(res, 404, { error: 'entry not found' })
    const patch = normalizeEntry({ ...book.entries[index], ...(body.entry || {}) })
    patch.id = book.entries[index].id
    book.entries[index] = patch
    if (patch.group && !book.groups.includes(patch.group)) book.groups.push(patch.group)
    await persistBook(body.cardId, scope, book)
    return sendJson(res, 200, await loadWorldbook(body.cardId))
  }

  // ---- 图库 -------------------------------------------------------------
  if (path === '/gallery' && method === 'GET') {
    return sendJson(res, 200, { images: await listGalleryImages() })
  }

  if (path === '/gallery' && method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.base64 !== 'string') return sendJson(res, 400, { error: '需要 base64 字段' })
    const buffer = Buffer.from(body.base64, 'base64')
    const ext = detectImageExt(buffer)
    if (!ext) return sendJson(res, 400, { error: '只支持 PNG / JPEG / WebP / GIF' })
    // 上传时给个可读的显示名：去掉原文件名里的扩展名，重名就加序号
    const rawName = String(body.name || body.displayName || '').trim().replace(/\.[^.]+$/, '')
    const base = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    let fileName = `${base || newStamp()}.${ext}`
    let suffix = 1
    while (await fileExists(join(paths().images, fileName))) {
      fileName = `${base || newStamp()}-${suffix}.${ext}`
      suffix += 1
    }
    await writeFile(join(paths().images, fileName), buffer)
    const display = base || fileName.replace(/\.[^.]+$/, '')
    if (base) await setImageName(`studio/${fileName}`, display)
    return sendJson(res, 200, {
      image: {
        id: `studio/${fileName}`,
        name: display,
        fileName,
        source: 'studio',
        path: `/gallery/studio/${encodeURIComponent(fileName)}`
      }
    })
  }

  const galleryRenameMatch = path.match(/^\/gallery\/(studio|roleplay\d*)\/([^/]+?)\/rename$/)
  if (galleryRenameMatch && method === 'POST') {
    const source = galleryRenameMatch[1]
    const fileName = decodeURIComponent(galleryRenameMatch[2])
    const body = await readJsonBody(req)
    const id = `${source}/${fileName}`
    await setImageName(id, body.name)
    return sendJson(res, 200, { id, name: displayImageName(await readImageNames(), source, fileName) })
  }

  const galleryItemMatch = path.match(/^\/gallery\/(studio|roleplay\d*)\/([^/]+?)(\/import)?$/)
  if (galleryItemMatch) {
    const source = galleryItemMatch[1]
    const fileName = decodeURIComponent(galleryItemMatch[2])
    const wantImport = Boolean(galleryItemMatch[3])
    const dir = galleryDir(source)
    const file = join(dir, fileName)

    if (method === 'GET' && !wantImport) {
      try {
        const buffer = await readFile(file)
        return sendBuffer(res, 200, buffer, imageMime(fileName) || 'application/octet-stream')
      } catch {
        return sendJson(res, 404, { error: 'image not found' })
      }
    }
    if (method === 'DELETE' && !wantImport) {
      if (source !== 'studio') return sendJson(res, 403, { error: '角色扮演目录里的图只能收藏进图库，不能在这里删除' })
      await removeFile(file)
      await setImageName(`${source}/${fileName}`, '')
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && wantImport) {
      // 把别的来源的图复制进工坊图库，之后可独立管理
      try {
        const buffer = await readFile(file)
        const target = `${source}-${fileName}`
        await writeFile(join(paths().images, target), buffer)
        return sendJson(res, 200, { image: { id: `studio/${target}`, fileName: target, source: 'studio', path: `\/gallery/studio/${encodeURIComponent(target)}` } })
      } catch {
        return sendJson(res, 404, { error: 'image not found' })
      }
    }
    if (method === 'POST' && !wantImport) {
      // 把这张图设成某张卡的头像
      const body = await readJsonBody(req)
      if (!body.cardId) return sendJson(res, 400, { error: '需要 cardId' })
      const buffer = await readFile(file)
      const png = imageMime(fileName) === 'image/png' ? buffer : null
      if (!png) return sendJson(res, 400, { error: '头像只支持 PNG' })
      await writeFile(avatarPath(body.cardId), png)
      return sendJson(res, 200, { ok: true })
    }
  }

  // ---- 提示词预览 -------------------------------------------------------
  if (path === '/prompt/preview' && method === 'POST') {
    const body = await readJsonBody(req)
    const card = body.cardId ? await loadCard(body.cardId) : body.card || null
    const settings = await loadSettings()
    let worldbook = body.worldbook
    if (!worldbook) {
      const data = await loadWorldbook(body.cardId)
      worldbook = [...data.global, ...data.card]
    }
    const preview = assemblePrompt({
      card,
      settings: { ...settings, ...(body.settings || {}) },
      worldbook,
      recentText: body.text || ''
    })
    return sendJson(res, 200, preview)
  }

  // ---- 权限设置（工具开关）-----------------------------------------------
  if (path === '/tools') {
    if (method === 'GET') {
      const settings = await loadSettings()
      return sendJson(res, 200, {
        enabled: settings.enabled,
        denyOthers: settings.denyOthers,
        toolGroups: settings.toolGroups,
        groups: TOOL_GROUPS
      })
    }
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const patch = {}
      if (body && body.toolGroups) patch.toolGroups = body.toolGroups
      if (body && typeof body.denyOthers === 'boolean') patch.denyOthers = body.denyOthers
      if (body && typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: '需要 toolGroups / denyOthers / enabled' })
      const settings = await saveSettings(patch)
      const applied = await reapplyToolGates(settings)
      return sendJson(res, 200, {
        enabled: settings.enabled,
        denyOthers: settings.denyOthers,
        toolGroups: settings.toolGroups,
        applied
      })
    }
  }

  // ---- 设置 -------------------------------------------------------------
  if (path === '/settings') {
    if (method === 'GET') return sendJson(res, 200, { settings: await loadSettings() })
    if (method === 'PATCH') {
      const patch = await readJsonBody(req)
      const settings = await saveSettings(patch)
      await reapplyToolGates(settings)
      return sendJson(res, 200, { settings })
    }
  }

  // ---- 会话 -------------------------------------------------------------
  if (path === '/chats' && method === 'GET') {
    return sendJson(res, 200, { chats: await listChats() })
  }
  if (path === '/chats' && method === 'POST') {
    const body = await readJsonBody(req)
    if (!body.cardId) return sendJson(res, 400, { error: '需要 cardId' })
    return sendJson(res, 200, { chat: await createChat({ cardId: body.cardId, title: body.title }) })
  }

  const chatMatch = path.match(/^\/chats\/([^/]+)$/)
  if (chatMatch) {
    const id = decodeURIComponent(chatMatch[1])
    if (method === 'GET') {
      const chat = await loadChat(id)
      if (!chat) return sendJson(res, 404, { error: 'chat not found' })
      return sendJson(res, 200, { chat })
    }
    if (method === 'PUT') {
      const chat = await readJsonBody(req)
      chat.id = id
      return sendJson(res, 200, { chat: await saveChat(chat) })
    }
    if (method === 'DELETE') {
      await deleteChat(id)
      return sendJson(res, 200, { ok: true })
    }
  }

  const msgMatch = path.match(/^\/chats\/([^/]+)\/messages$/)
  if (msgMatch && method === 'POST') {
    const id = decodeURIComponent(msgMatch[1])
    const body = await readJsonBody(req)
    const chat = await loadChat(id)
    if (!chat) return sendJson(res, 404, { error: 'chat not found' })
    const message = await appendMessage(chat, { role: body.role || 'user', content: body.content || '' })
    await saveChat(chat)
    return sendJson(res, 200, { message, chat })
  }

  const variantMatch = path.match(/^\/chats\/([^/]+)\/messages\/([^/]+)$/)
  if (variantMatch && (method === 'POST' || method === 'PATCH')) {
    const id = decodeURIComponent(variantMatch[1])
    const messageId = decodeURIComponent(variantMatch[2])
    const body = await readJsonBody(req)
    const chat = await loadChat(id)
    if (!chat) return sendJson(res, 404, { error: 'chat not found' })
    if (method === 'POST') addVariant(chat, messageId, body.content || '')
    else if (typeof body.variant === 'number') selectVariant(chat, messageId, body.variant)
    else editMessage(chat, messageId, body.content || '')
    await saveChat(chat)
    return sendJson(res, 200, { chat })
  }

  return sendJson(res, 404, { error: `no route ${method} ${path}` })
}

export function apply(ctx) {
  const register = () => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          try {
            await ensureDirs()
            await routeRequest(req, res)
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
      })
    } catch (error) {
      // 条目被热重载时旧路由可能还占着位置，这里不让它把整个插件带崩。
      const message = String((error && error.message) || error)
      if (message.includes('duplicate')) {
        ctx.logger?.warn?.(`dsh-rp-studio: ${PREFIX} 已注册，复用旧路由`)
        return () => {}
      }
      throw error
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => register(), 'rp-studio.routes')
  else register()

  // 部署层人格段：每个会话装配提示词时都会调用，返回当前绑定的角色卡。
  const prompt = ctx.systemPrompt
  if (prompt && typeof prompt.section === 'function') {
    try {
      prompt.section({
        name: PERSONA_SECTION,
        order: PERSONA_ORDER,
        text: (context) => {
          try {
            return buildRoleplaySystem(context && context.agent, { silent: true })
          } catch (error) {
            ctx.logger?.warn?.(`dsh-rp-studio: 人格段装配失败 ${error && error.message ? error.message : error}`)
            return ''
          }
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-rp-studio: 人格段注册失败 ${error && error.message ? error.message : error}`)
    }
  } else {
    ctx.logger?.warn?.('dsh-rp-studio: systemPrompt 服务不可用，人格段未注册')
  }

  // 清洗设置：每个 agent 创建时按当前开关摘工具。
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', async (payload) => {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      liveAgents.set(agent.id, agent)
      try {
        applyToolGate(agent, await loadSettings())
      } catch (error) {
        ctx.logger?.warn?.(`dsh-rp-studio: 工具开关应用失败 ${error && error.message ? error.message : error}`)
      }
    })
  }

  // 图库工具：让角色能「看」到图库里有什么图（名字 + 来源），再自己决定要不要用。
  // 权限设置里的「图库」开关通过 rp_gallery 这个名字摘掉它。
  const tools = ctx.tools
  if (tools && typeof tools.register === 'function') {
    try {
      const disposer = tools.register({
        name: 'rp_gallery',
        description:
          '查看角色扮演工坊的图库。返回图库里每一张图的显示名、文件名与来源目录（studio = 工坊图库，roleplay* = 角色扮演出图目录）。' +
          '参数 name 可做名字/文件名的模糊筛选。只看名字与清单，不返回图片字节。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '可选。按显示名或文件名筛选，做包含匹配。' },
            source: { type: 'string', description: '可选。只看某个来源，例如 studio、roleplay0。' }
          },
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              images: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    fileName: { type: 'string' },
                    source: { type: 'string' },
                    bytes: { type: 'number' },
                    createdAt: { type: 'string' }
                  },
                  required: ['name', 'fileName', 'source'],
                  additionalProperties: false
                }
              }
            },
            required: ['count', 'images'],
            additionalProperties: false
          },
          render(_args, value) {
            if (!value || value.count === 0) return '图库现在是空的。'
            const lines = value.images.map((image, index) => {
              const where = image.source === 'studio' ? '工坊图库' : '角色扮演出图'
              return `${index + 1}. ${image.name}（${image.fileName}，${where}）`
            })
            return `图库里共 ${value.count} 张图：\n${lines.join('\n')}`
          }
        },
        async execute(args) {
          const query = args && typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
          const wantSource = args && typeof args.source === 'string' ? args.source.trim() : ''
          const all = await listGalleryImages()
          const images = all
            .filter((image) => (wantSource ? image.source === wantSource : true))
            .filter((image) =>
              query
                ? image.name.toLowerCase().includes(query) || image.fileName.toLowerCase().includes(query)
                : true
            )
            .map((image) => ({
              name: image.name,
              fileName: image.fileName,
              source: image.source,
              bytes: image.bytes,
              createdAt: image.createdAt
            }))
          return { count: images.length, images }
        }
      })
      galleryToolReady = true
      if (typeof ctx.effect === 'function' && typeof disposer === 'function') {
        ctx.effect(() => disposer, 'rp-studio.gallery-tool')
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-rp-studio: rp_gallery 注册失败 ${error && error.message ? error.message : error}`)
    }
  } else {
    ctx.logger?.warn?.('dsh-rp-studio: tools 服务不可用，rp_gallery 未注册')
  }

  ctx.logger?.info?.(`dsh-rp-studio host ready: ${PREFIX}`)
}

