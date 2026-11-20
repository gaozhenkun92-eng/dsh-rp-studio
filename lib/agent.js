// 会话引擎：把工坊里的角色卡 / 世界书 / 用户设定接进真正对话。
//
// 这个模块被 rp-studio 预设当作会话组件使用（`name: 'dsh-rp-studio/agent'`），
// 它只做一件事：在每次组装 system 时，把「当前角色卡 + 命中的世界书 + 你的人设
// + 文风规则」拼成一段人格段，替换掉宿主默认的 persona 段。
//
// 不 import 任何 @deepseek-ai/* 包：这样插件目录不需要 node_modules，
// 靠 Junction 装在工作区也能正常解析。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { assemblePrompt } from './prompt.js'

export const name = 'dsh-rp-studio-session'
export const inject = ['systemPrompt']

// 与宿主 system-prompt 里 persona 段同名，等同「覆盖」而不是「追加」
const PERSONA_SECTION = 'deployment:persona-prefix'
const PERSONA_ANCHOR = 'DEPLOYMENT_PERSONA_PREFIX'

function runtimeRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return home || join(homedir(), '.dsh')
}

function studioRoot() {
  return join(runtimeRoot(), 'rp-studio')
}

function readJsonSync(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function readSettings() {
  return readJsonSync(join(studioRoot(), 'settings.json'), {}) || {}
}

function readActiveCardId() {
  const active = readJsonSync(join(studioRoot(), 'active.json'), {}) || {}
  if (typeof active.cardId === 'string' && active.cardId) return active.cardId
  return ''
}

function readCard(cardId) {
  if (!cardId) return null
  return readJsonSync(join(studioRoot(), 'cards', `${cardId}.json`), null)
}

// 世界书文件有两种形态：老的是扁平数组，新的是 { groups, entries }
function bookEntries(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.entries)) return raw.entries
  return []
}

function readWorldbook(cardId) {
  const globalList = bookEntries(readJsonSync(join(studioRoot(), 'worldbooks', '_global.json'), null))
  const cardList = cardId ? bookEntries(readJsonSync(join(studioRoot(), 'worldbooks', `${cardId}.json`), null)) : []
  const list = []
  const seen = new Set()
  for (const entry of [...globalList, ...cardList]) {
    if (!entry || typeof entry !== 'object') continue
    // 关掉的条目直接不参与命中（集合整体关掉时也是逐条写 false）
    if (entry.enabled === false) continue
    // 全局与本卡可能有同一条：按「名字 + 关键词 + 正文」去重，只留先出现的
    const keys = Array.isArray(entry.keys) ? entry.keys.join('|') : String(entry.keys || '')
    const fingerprint = `${entry.name || ''}\u0000${keys}\u0000${entry.content || ''}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    list.push(entry)
  }
  return list
}

// 取最近一条用户发言：世界书按它做关键词命中，和「本轮场景」保持一致
function recentUserText(agent) {
  try {
    const messages = agent?.session?.deriveMessages?.() || []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (!message) continue
      const role = message.role || message.author?.role || ''
      if (role && role !== 'user') continue
      const content = message.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((block) => block && typeof block === 'object' && block.type === 'text')
          .map((block) => block.text || '')
          .join('')
      }
    }
  } catch {
    /* 拿不到就当没有最近发言 */
  }
  return ''
}

// 角色卡里的 {{char}} / {{user}} 先替换，再把残余 {{ 打散，避免被宿主当宏展开
function applyMacros(text, charName, userName) {
  const body = String(text || '')
    .replaceAll(/\{\{\s*char\s*\}\}/gi, charName)
    .replaceAll(/\{\{\s*user\s*\}\}/gi, userName)
  return body.replaceAll('{{', '{ {')
}

export function buildRoleplaySystem(agent, options) {
  const silent = Boolean(options && options.silent)
  const settings = readSettings()
  const cardId = readActiveCardId()
  const card = readCard(cardId)
  if (!card) {
    // 部署层调用时静默返回空串：没选卡就不该给任何会话塞提示语。
    if (silent) return ''
    return [
      '当前会话还没有绑定角色卡。',
      '请在「妙脆.角」页签的「切换角色卡」里选一张，或先创建一张。',
      '在绑定之前，按普通对话回答，不要假装自己是某个角色。'
    ].join('\n')
  }

  const userName = String(settings.userName || '你').trim() || '你'
  const worldbook = readWorldbook(cardId)
  // assemblePrompt 已经把「用户人设」和「风格规则」各自成段，这里不再重复追加，
  // 否则同一段文字会在 system 里出现两遍。
  const preview = assemblePrompt({
    card,
    settings,
    worldbook,
    recentText: recentUserText(agent)
  })

  return applyMacros(preview.system, card.name || '', userName)
}

export function apply(ctx) {
  const order = (() => {
    try {
      if (typeof ctx.systemPrompt.getSectionOrder === 'function') {
        return ctx.systemPrompt.getSectionOrder(PERSONA_ANCHOR)
      }
    } catch {
      /* 取不到顺序就落到 0 */
    }
    return 0
  })()

  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order,
    text: (context) => {
      try {
        return buildRoleplaySystem(context?.agent)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-rp-studio: 组装角色提示失败 ${String((error && error.message) || error)}`)
        return ''
      }
    }
  })
}
