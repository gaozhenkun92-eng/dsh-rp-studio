// 无头验证：卡片解析/导出、数据层、提示词组装、会话记录。
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'rp-studio-probe-'))
process.env.DSH_HOME = root

const { normalizeCard, parseCardBuffer, exportPng, cardFromText, cardPlainText, toV2, minimalPng } = await import(
  '../lib/card.js'
)
const store = await import('../lib/store.js')
const { assemblePrompt, estimateTokens } = await import('../lib/prompt.js')
const session = await import('../lib/session.js')

const log = (...args) => console.log(...args)
let failed = 0
function check(label, ok, extra = '') {
  if (!ok) failed += 1
  log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`)
}

await store.ensureDirs()
check('dirs created', (await store.listFiles(store.paths().cards)).length === 0)

// 1) JSON(v2) → 内部格式
const v2 = {
  spec: 'chara_card_v2',
  data: {
    name: '妙脆.角',
    description: '一个失意的青年捡到的角色。',
    personality: '冷淡，偶尔毒舌',
    scenario: '雨夜的便利店',
    first_mes: '……你盯着我看很久了。',
    mes_example: '{{user}}: 你好\n{{char}}: 嗯。',
    system_prompt: '保持第一人称，回复 3 段以内。',
    alternate_greetings: ['又是你。'],
    tags: ['日常', '慢热']
  }
}
const card = parseCardBuffer(Buffer.from(JSON.stringify(v2), 'utf8'), { fallbackName: 'x' })
check('json card name', card.name === '妙脆.角', card.name)
check('json card source', card.source === 'json', card.source)
check('json card tags', card.tags.length === 2, JSON.stringify(card.tags))

// 2) 导出 PNG 再读回来（tEXt chara/ccv3 往返）
const png = exportPng(card, minimalPng())
const back = parseCardBuffer(png, {})
check('png roundtrip name', back.name === card.name, back.name)
check('png roundtrip description', back.description === card.description)
check('png roundtrip greetings', back.alternateGreetings.length === 1)
check('png roundtrip source', back.source === 'png', back.source)

// 3) 纯文字卡
const textCard = cardFromText('# 小满\n\n隔壁面包店的店员，笑起来有点傻。\n喜欢在下午三点发呆。', 'fallback')
check('text card name', textCard.name === '小满', textCard.name)
check('text card body', textCard.description.includes('面包店'), textCard.description.slice(0, 20))
check('cardPlainText has name', cardPlainText(textCard).startsWith('# 小满'))

// 4) 落盘 + 列表
await store.writeJson(join(store.paths().cards, `${card.id}.json`), card)
const files = await store.listFiles(store.paths().cards, '.json')
check('card saved', files.length === 1, files.join(','))

// 5) 提示词组装 + 预算裁剪
const tight = assemblePrompt({ card, settings: { userName: '我', maxSystemChars: 40 }, worldbook: [], recentText: '' })
check('prompt has card name', tight.system.includes('妙脆.角'))
check('prompt trimmed sections', tight.dropped.length > 0, tight.dropped.join(',') || 'none')
const roomy = assemblePrompt({ card, settings: { userName: '我', maxSystemChars: 9000 }, worldbook: [], recentText: '' })
check('roomy keeps example', roomy.sections.some((s) => s.key === 'example' && !s.trimmed))
check('roomy tokens > 0', roomy.totalTokens > 0, String(roomy.totalTokens))
check('estimate cjk', Math.round(estimateTokens('你好世界')) === 2, String(estimateTokens('你好世界')))

// 6) 世界书命中
const wb = [{ name: '便利店', keys: ['便利店'], content: '24 小时营业，灯管有点闪。', priority: 5 }]
const withWb = assemblePrompt({ card, settings: { userName: '我' }, worldbook: wb, recentText: '走进便利店' })
check('worldbook hit', withWb.sections.some((s) => s.key === 'worldbook'), withWb.dropped.join(','))

// 7) 会话：消息 + swipe
let chat = await session.createChat({ cardId: card.id, title: '测试' })
await session.appendMessage(chat, { role: 'user', content: '你好' })
const reply = await session.appendMessage(chat, { role: 'assistant', content: '……嗯。' })
session.addVariant(chat, reply.id, '……你来了。')
check('variant count', reply.variants.length === 2, String(reply.variants.length))
check('variant active', reply.content === '……你来了。', reply.content)
session.selectVariant(chat, reply.id, 0)
check('variant switched back', reply.content === '……嗯。', reply.content)
await session.saveChat(chat)
const loaded = await session.loadChat(chat.id)
check('chat persisted', loaded.messages.length === 2)
check('model messages', session.toModelMessages(loaded).length === 2)

await rm(root, { recursive: true, force: true })
log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
