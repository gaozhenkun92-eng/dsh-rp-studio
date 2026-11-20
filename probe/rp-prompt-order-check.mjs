// 提示词顺序 / 去重 / 空白隐藏 探针
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'rpstudio-order-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'rp-studio', 'cards'), { recursive: true })
mkdirSync(join(home, 'rp-studio', 'worldbooks'), { recursive: true })

let failed = 0
function check(label, ok, extra = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`)
}

const prompt = await import('../lib/prompt.js')

// ---- 1. 段顺序 ----
const fullCard = {
  id: 'c1',
  name: '千岁',
  systemPrompt: '系统提示正文',
  description: '人设正文',
  personality: '性格正文',
  scenario: '场景正文',
  mesExample: '示例正文',
  postHistoryInstructions: '后指令正文',
  customSections: [{ id: 'x1', name: '世界观补充', content: '自定义正文' }]
}
const settings = { userName: '妙脆.角', userPersona: '一个失意的青年。', stylePrompt: '短句，多动作。', maxSystemChars: 0 }
const worldbook = [{ id: 'w1', name: '雨', keys: ['雨'], content: '雨从不停。', priority: 5, always: true }]

const result = prompt.assemblePrompt({ card: fullCard, settings, worldbook, recentText: '外面在下雨。' })
const keys = result.sections.map((section) => section.key)
const expected = ['system', 'description', 'personality', 'scenario', 'worldbook', 'example', 'user', 'style', 'post', 'custom:x1']
check('section order matches design', JSON.stringify(keys) === JSON.stringify(expected), keys.join(' -> '))

const system = result.system
const orderInText = ['你正在扮演「千岁」', '## 角色卡系统提示', '## 人设', '## 说话风格', '## 背景故事', '## 世界书命中', '## 对话示例', '## 用户人设', '## 风格规则', '## 特殊内容', '## 世界观补充']
let cursor = -1
let monotonic = true
for (const marker of orderInText) {
  const at = system.indexOf(marker)
  if (at < 0 || at < cursor) monotonic = false
  cursor = at
}
check('rendered text follows the same order', monotonic)

// ---- 2. 空白字段自动隐藏 ----
const blankCard = { id: 'c2', name: '千岁', systemPrompt: '   ', description: '', personality: '', scenario: '\n', postHistoryInstructions: '', customSections: [{ id: 'x2', name: '空框', content: '  ' }] }
const blank = prompt.assemblePrompt({ card: blankCard, settings: { userName: '', userPersona: '', stylePrompt: '', maxSystemChars: 0 }, worldbook: [], recentText: '' })
check('blank fields produce no sections', blank.sections.length === 0, blank.sections.map((s) => s.key).join(','))
check('blank fields produce no headers', blank.system === '你正在扮演「千岁」。', JSON.stringify(blank.system))
for (const header of ['人设', '说话风格', '背景故事', '世界书', '对话示例', '用户人设', '风格规则', '特殊内容']) {
  if (blank.system.includes('## ' + header)) throw new Error('empty header leaked: ' + header)
}
console.log('empty → only the one-line header remains')

// ---- 3. 人设/文风只出现一次 ----
writeFileSync(join(home, 'rp-studio', 'cards', 'c1.json'), JSON.stringify(fullCard))
writeFileSync(join(home, 'rp-studio', 'active.json'), JSON.stringify({ cardId: 'c1' }))
writeFileSync(join(home, 'rp-studio', 'settings.json'), JSON.stringify(settings))
writeFileSync(join(home, 'rp-studio', 'worldbooks', '_global.json'), JSON.stringify(worldbook))
writeFileSync(join(home, 'rp-studio', 'worldbooks', 'c1.json'), JSON.stringify([{ id: 'w1', name: '雨', keys: ['雨'], content: '雨从不停。', priority: 5, always: true }]))

const agent = await import('../lib/agent.js')
const composed = agent.buildRoleplaySystem({ session: { deriveMessages: () => [{ role: 'user', content: '外面在下雨。' }] } })
countOf(composed, '一个失意的青年。')
countOf(composed, '短句，多动作。')
function countOf(text, needle) {
  const parts = text.split(needle).length - 1
  check(`"${needle}" appears exactly once`, parts === 1, `${parts}x`)
}
check('no legacy 【关于「…」】 block', !composed.includes('【关于「'), '')
check('no legacy 【文风规则】 block', !composed.includes('【文风规则】'), '')
check('worldbook entry not duplicated across scopes', composed.split('雨从不停。').length - 1 === 1, `${composed.split('雨从不停。').length - 1}x`)

// ---- 4. 预算裁剪顺序不变 ----
const tight = prompt.assemblePrompt({ card: fullCard, settings: { ...settings, maxSystemChars: 40 }, worldbook, recentText: '雨' })
check('trim order starts with example', tight.dropped[0] === 'example', tight.dropped.join(','))
check('system/style/post never dropped', !tight.dropped.includes('system') && !tight.dropped.includes('style') && !tight.dropped.includes('post'), tight.dropped.join(','))

rmSync(home, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
if (failed !== 0) process.exitCode = 1
