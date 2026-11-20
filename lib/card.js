// 角色卡：PNG(tEXt) / JSON(v1 v2 v3) / 纯文字 三种输入，导出 PNG 与 JSON。
import { crc32 } from 'node:zlib'
import { newId } from './store.js'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIG)
}

function readChunks(buffer) {
  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) break
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) })
    offset = dataEnd + 4
    if (type === 'IEND') break
  }
  return chunks
}

export function readPngText(buffer) {
  const out = {}
  for (const chunk of readChunks(buffer)) {
    if (chunk.type !== 'tEXt') continue
    const zero = chunk.data.indexOf(0)
    if (zero < 0) continue
    const keyword = chunk.data.toString('latin1', 0, zero)
    out[keyword] = chunk.data.toString('latin1', zero + 1)
  }
  return out
}

function textChunk(keyword, text) {
  const payload = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1')
  ])
  const type = Buffer.from('tEXt', 'latin1')
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  type.copy(head, 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0, 0)
  return Buffer.concat([head, payload, crc])
}

// 把若干 tEXt 写进 PNG：插在 IHDR 之后，不动其它块。
export function writePngText(buffer, entries) {
  if (!isPng(buffer)) throw new Error('not a PNG file')
  const chunks = readChunks(buffer)
  const parts = [PNG_SIG]
  chunks.forEach((chunk, index) => {
    const type = Buffer.from(chunk.type, 'latin1')
    const head = Buffer.alloc(8)
    head.writeUInt32BE(chunk.data.length, 0)
    type.copy(head, 4)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([type, chunk.data])) >>> 0, 0)
    parts.push(head, chunk.data, crc)
    if (index === 0) {
      for (const [keyword, text] of Object.entries(entries)) {
        if (typeof text === 'string' && text.length > 0) parts.push(textChunk(keyword, text))
      }
    }
  })
  return Buffer.concat(parts)
}

function pick(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return ''
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim().length > 0)
  if (typeof value === 'string' && value.trim().length > 0) return [value]
  return []
}

// 内部格式：扁平、稳定，UI 与提示词层都只认这个。
export function normalizeCard(raw, meta = {}) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw || {}
  const card = {
    id: meta.id || newId('card'),
    name: pick(data, ['name', 'char_name', 'charName']).trim() || meta.fallbackName || '未命名角色',
    description: pick(data, ['description', 'char_persona', 'persona']),
    personality: pick(data, ['personality', 'char_personality']),
    scenario: pick(data, ['scenario', 'world_scenario']),
    firstMes: pick(data, ['first_mes', 'first_message', 'char_greeting', 'greeting']),
    alternateGreetings: asArray(data.alternate_greetings),
    mesExample: pick(data, ['mes_example', 'example_dialogue']),
    systemPrompt: pick(data, ['system_prompt']),
    postHistoryInstructions: pick(data, ['post_history_instructions', 'post_history_instruction']),
    creatorNotes: pick(data, ['creator_notes', 'creatorcomment']),
    tags: asArray(data.tags),
    source: meta.source || 'unknown',
    spec: pick(raw, ['spec']) || meta.spec || 'internal',
    avatar: meta.avatar || null,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // 用户自定义设定框：[{ id, name, content }]，会作为独立段落进系统提示。
    customSections: asArray(data.custom_sections || data.customSections)
      .map((item, index) => ({
        id: String(item?.id || `c${index + 1}`),
        name: String(item?.name || '自定义'),
        content: String(item?.content || '')
      }))
  }
  return card
}

// 角色卡自带的世界书（SillyTavern V2/V3 的 data.character_book），转成工坊条目。
export function extractEmbeddedWorldbook(raw) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw || {}
  const book = data.character_book || raw?.character_book || null
  if (!book) return []
  const list = Array.isArray(book) ? book : Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {})
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const keys = Array.isArray(item.keys)
        ? item.keys
        : Array.isArray(item.key)
          ? item.key
          : String(item.keys || item.key || '')
              .split(/[,，]/)
              .map((k) => k.trim())
              .filter(Boolean)
      const content = String(item.content ?? item.text ?? '')
      if (!content.trim()) return null
      return {
        name: String(item.name || item.comment || keys[0] || '世界书条目').slice(0, 60),
        keys,
        content,
        priority: Number.isFinite(Number(item.priority ?? item.insertion_order ?? item.order))
          ? Number(item.priority ?? item.insertion_order ?? item.order)
          : 5,
        always: item.always === true || item.constant === true || item.force === true
      }
    })
    .filter(Boolean)
}

export function toV2(card) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.firstMes,
      mes_example: card.mesExample,
      creator_notes: card.creatorNotes,
      system_prompt: card.systemPrompt,
      post_history_instructions: card.postHistoryInstructions,
      alternate_greetings: card.alternateGreetings,
      tags: card.tags
    }
  }
}

export function toV3(card) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { ...toV2(card).data, group_only_greetings: [] }
  }
}

function decodeBase64Json(text) {
  const json = Buffer.from(String(text).trim(), 'base64').toString('utf8')
  return JSON.parse(json)
}

export function parseCardBuffer(buffer, meta = {}) {
  if (isPng(buffer)) {
    const texts = readPngText(buffer)
    const payload = texts.ccv3 || texts.chara || texts.Chara
    if (!payload) throw new Error('这张 PNG 里没有角色卡数据（缺少 tEXt chara/ccv3）')
    const raw = decodeBase64Json(payload)
    const card = normalizeCard(raw, { ...meta, source: 'png', avatar: 'embedded' })
    const embedded = extractEmbeddedWorldbook(raw)
    if (embedded.length > 0) card.embeddedWorldbook = embedded
    return card
  }
  const text = buffer.toString('utf8').trim()
  if (!text) throw new Error('文件是空的')
  try {
    const raw = JSON.parse(text)
    const card = normalizeCard(raw, { ...meta, source: 'json' })
    const embedded = extractEmbeddedWorldbook(raw)
    if (embedded.length > 0) card.embeddedWorldbook = embedded
    return card
  } catch {
    return normalizeCard({ name: meta.fallbackName, description: text }, { ...meta, source: 'text' })
  }
}

export function exportPng(card, pngBuffer) {
  const v2 = Buffer.from(JSON.stringify(toV2(card)), 'utf8').toString('base64')
  const v3 = Buffer.from(JSON.stringify(toV3(card)), 'utf8').toString('base64')
  const base = isPng(pngBuffer) ? pngBuffer : minimalPng()
  return writePngText(base, { chara: v2, ccv3: v3 })
}

// 1×1 透明 PNG，作为没有头像时的导出底图。
export function minimalPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
}

export function cardPlainText(card) {
  const lines = [`# ${card.name}`]
  if (card.description) lines.push('', card.description)
  if (card.personality) lines.push('', `性格：${card.personality}`)
  if (card.scenario) lines.push('', `场景：${card.scenario}`)
  if (card.firstMes) lines.push('', `开场：${card.firstMes}`)
  if (card.mesExample) lines.push('', `对话示例：${card.mesExample}`)
  if (card.systemPrompt) lines.push('', `系统提示：${card.systemPrompt}`)
  return lines.join('\n')
}

// 从纯文字倒推：第一行短且不以句号结尾就当名字，其余全进描述。
export function cardFromText(text, fallbackName) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!body) throw new Error('文字是空的')
  const [first, ...rest] = body.split('\n')
  const head = first.trim().replace(/^#+\s*/, '')
  const looksLikeName = head.length > 0 && head.length <= 24 && rest.join('\n').trim().length > 0
  return normalizeCard(
    { name: looksLikeName ? head : fallbackName, description: looksLikeName ? rest.join('\n').trim() : body },
    { source: 'text', fallbackName }
  )
}
