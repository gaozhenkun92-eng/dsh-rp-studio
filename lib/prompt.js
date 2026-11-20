// 提示词层：把角色卡、世界书、用户人设、风格规则组装成一次 system，
// 并给出每块的字数，供 UI 做「本轮发送内容预览」。
import { cardPlainText } from './card.js'

// 粗估 token：ASCII ~0.3/字符，CJK ~0.6/字符，其它 0.4。够用来做预算裁剪。
export function estimateTokens(text) {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0)
    if (code < 0x80) ascii += 1
    else if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else if (code >= 0x3040 && code <= 0x30ff) cjk += 1
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1
    else other += 1
  }
  return ascii * 0.3 + cjk * 0.6 + other * 0.4
}

function section(key, title, text) {
  const body = String(text || '').trim()
  if (!body) return null
  return { key, title, text: body, chars: body.length, tokens: Math.round(estimateTokens(body)) }
}

// 世界书命中：先做关键词包含匹配；priority 高的先留。
export function matchWorldbook(entries, text) {
  const haystack = String(text || '')
  const hits = []
  for (const entry of entries || []) {
    // 关掉的条目（或所在集合关掉后随之下传 enabled=false）不参与命中
    if (entry && entry.enabled === false) continue
    const keys = Array.isArray(entry.keys) ? entry.keys : String(entry.keys || '').split(',')
    const matched = keys
      .map((k) => String(k).trim())
      .filter((k) => k.length > 0 && haystack.includes(k))
    if (matched.length === 0 && !entry.always) continue
    hits.push({ ...entry, matched })
  }
  return hits.sort((a, b) => (b.priority || 0) - (a.priority || 0))
}

export function assemblePrompt({ card, settings = {}, worldbook = [], recentText = '', extraSections = [] }) {
  const sections = []

  // 标题与 UI 里的框名保持一致，避免同一个字段两套叫法
  sections.push(section('system', '角色卡系统提示', card?.systemPrompt))
  sections.push(section('description', '人设', card?.description))
  sections.push(section('personality', '说话风格', card?.personality))
  sections.push(section('scenario', '背景故事', card?.scenario))

  const hits = matchWorldbook(worldbook, recentText)
  if (hits.length > 0) {
    const text = hits
      .map((entry) => `【${entry.name || entry.keys?.join?.('/') || '设定'}】${entry.content || ''}`)
      .join('\n')
    sections.push(section('worldbook', `世界书命中 ${hits.length} 条`, text))
  }

  sections.push(section('example', '对话示例', card?.mesExample))
  sections.push(section('user', '用户人设', [settings.userName, settings.userPersona].filter(Boolean).join('：')))
  sections.push(section('style', '风格规则', settings.stylePrompt))
  sections.push(section('post', '特殊内容', card?.postHistoryInstructions))
  for (const custom of card?.customSections || []) {
    if (!custom || !String(custom.content || '').trim()) continue
    sections.push(section(`custom:${custom.id}`, custom.name || '自定义', custom.content))
  }
  for (const extra of extraSections) {
    sections.push(section(extra.key, extra.title, extra.text))
  }

  const kept = sections.filter(Boolean)
  // 裁剪顺序：示例 → 世界书 → 场景 → 描述（系统提示、人设、风格最后动）
  const trimOrder = ['example', 'worldbook', 'scenario', 'user', 'description', 'personality']
  const rawBudget = Number(settings.maxSystemChars)
  // 0 / 空 / 非数字 = 不限制长度，不裁任何段落
  const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : Infinity
  let total = kept.reduce((sum, s) => sum + s.chars, 0)
  const dropped = []
  for (const key of trimOrder) {
    if (total <= budget) break
    const target = kept.find((s) => s.key === key)
    if (!target) continue
    total -= target.chars
    target.trimmed = true
    dropped.push(key)
  }

  const body = kept
    .filter((s) => !s.trimmed)
    .map((s) => `## ${s.title}\n${s.text}`)
    .join('\n\n')

  const header = card?.name ? `你正在扮演「${card.name}」。` : ''
  const system = [header, body].filter(Boolean).join('\n\n')

  return {
    system,
    sections: kept.map((s) => ({
      key: s.key,
      title: s.title,
      chars: s.chars,
      tokens: s.tokens,
      trimmed: s.trimmed === true
    })),
    totalChars: system.length,
    totalTokens: Math.round(estimateTokens(system)),
    budget,
    dropped
  }
}

// 导出成「可读的卡文本」，UI 里那个可输入文字框直接用这个格式。
export function cardToEditorText(card) {
  return cardPlainText(card)
}
