// 数据层：所有落盘都在 $DSH_HOME/rp-studio/ 下，不碰 roleplay 的数据。
import { mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function studioRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'rp-studio')
}

export function paths(root = studioRoot()) {
  return {
    root,
    cards: join(root, 'cards'),
    chats: join(root, 'chats'),
    worldbooks: join(root, 'worldbooks'),
    images: join(root, 'images'),
    settings: join(root, 'settings.json')
  }
}

export async function ensureDirs(root = studioRoot()) {
  const p = paths(root)
  for (const dir of [p.root, p.cards, p.chats, p.worldbooks, p.images]) {
    await mkdir(dir, { recursive: true })
  }
  return p
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function listFiles(dir, suffix) {
  try {
    const names = await readdir(dir)
    return suffix ? names.filter((n) => n.endsWith(suffix)) : names
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

export async function removeFile(file) {
  try {
    await rm(file, { force: true })
  } catch {
    /* 已经没了 */
  }
}

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

// 权限设置里的开关：true = 角色可以用这一组工具，false = 运行时 deny 掉。
// 默认**全关**：插件装好之后角色什么都不多拿，要一个一个手动放行。
export const TOOL_GROUP_DEFAULTS = {
  fs: false,
  shell: false,
  web: false,
  subagent: false,
  skill: false,
  gallery: false
}

export const DEFAULTS = {
  // 插件总开关。关着的时候既不注入人格段，也不改动任何 agent 的工具面。
  enabled: false,
  // 「禁止除以上之外的其他权限」：打开后改成白名单，只有放行的组能用。
  denyOthers: false,
  userName: '你',
  userPersona: '',
  stylePrompt: '',
  toolGroups: TOOL_GROUP_DEFAULTS,
  negativePrompt: '',
  maxSystemChars: 0,
  temperature: 1,
  autoSummaryAfter: 40,
  imageProvider: 'none',
  imageBaseUrl: 'https://catiecli.sukaka.top/v1',
  imageModel: 'agy-gemini-3.1-flash-image',
  imageStylePrompt: 'very aesthetic, masterpiece, best quality'
}

export async function loadSettings(root = studioRoot()) {
  const p = paths(root)
  const saved = (await readJson(p.settings, {})) || {}
  return {
    ...DEFAULTS,
    ...saved,
    toolGroups: { ...TOOL_GROUP_DEFAULTS, ...(saved.toolGroups || {}) }
  }
}

export async function saveSettings(patch, root = studioRoot()) {
  const p = paths(root)
  const current = await loadSettings(root)
  const next = { ...current, ...(patch || {}) }
  if (patch && patch.toolGroups) {
    next.toolGroups = { ...current.toolGroups, ...patch.toolGroups }
  }
  await writeJson(p.settings, next)
  return next
}
