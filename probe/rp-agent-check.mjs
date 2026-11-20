// 会话引擎探针：验证 lib/agent.js 能把 rp-studio 的数据拼成人格段。
// 跑法：D:\xitonggongju\node\node.exe _probe\rp-agent-check.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const failures = []
function ok(label, cond, extra) {
  if (cond) console.log(`OK   ${label}${extra ? ' | ' + extra : ''}`)
  else {
    console.log(`FAIL ${label}${extra ? ' | ' + extra : ''}`)
    failures.push(label)
  }
}

const home = mkdtempSync(join(tmpdir(), 'rp-agent-'))
process.env.DSH_HOME = home
const root = join(home, 'rp-studio')
mkdirSync(join(root, 'cards'), { recursive: true })
mkdirSync(join(root, 'worldbooks'), { recursive: true })

writeFileSync(
  join(root, 'settings.json'),
  JSON.stringify({ userName: '妙脆.角', userPersona: '一个失意的青年，用的是不稳定的代理 api。', stylePrompt: '短句，多动作描写。', maxSystemChars: 0 })
)
writeFileSync(
  join(root, 'cards', 'c1.json'),
  JSON.stringify({
    id: 'c1',
    name: '千岁',
    description: '{{char}}是一名住在旧书店里的少女。',
    personality: '嘴硬心软。',
    scenario: '雨夜的旧书店。',
    systemPrompt: '',
    firstMes: '你终于来了。',
    mesExample: '{{user}}: 我来了。\n{{char}}: 嗯。',
    tags: ['书店']
  })
)
writeFileSync(join(root, 'active.json'), JSON.stringify({ cardId: 'c1' }))
writeFileSync(
  join(root, 'worldbooks', '_global.json'),
  JSON.stringify([{ id: 'w1', name: '世界', keys: ['雨'], content: '这座城市的雨从不停。', priority: 5, always: false }])
)
writeFileSync(
  join(root, 'worldbooks', 'c1.json'),
  JSON.stringify([{ id: 'w2', name: '书店', keys: ['书店'], content: '旧书店只在下雨天开门。', priority: 1, always: true }])
)

const agent = await import(new URL('../lib/agent.js', import.meta.url).href)

ok('exports name', agent.name === 'dsh-rp-studio-session', agent.name)
ok('injects systemPrompt', Array.isArray(agent.inject) && agent.inject.includes('systemPrompt'))

const sections = []
const ctx = {
  systemPrompt: {
    section(options) {
      sections.push(options)
    },
    getSectionOrder() {
      return 7
    }
  },
  logger: { warn() {} }
}
agent.apply(ctx)
ok('registers one section', sections.length === 1)
ok('section name is persona', sections[0].name === 'deployment:persona-prefix', sections[0].name)
ok('section order follows host', sections[0].order === 7, String(sections[0].order))

const context = {
  agent: {
    session: {
      deriveMessages() {
        return [
          { role: 'user', content: '推门进来，外面还在下雨。' },
          { role: 'assistant', content: '（抬头）' }
        ]
      }
    }
  }
}
const text = sections[0].text(context)
ok('text not empty', typeof text === 'string' && text.length > 20, `${text.length} chars`)
ok('card name present', text.includes('千岁'))
ok('user persona present', text.includes('失意的青年'))
ok('style rules present', text.includes('短句'))
ok('worldbook always entry present', text.includes('只在下雨天开门'))
ok('worldbook keyword hit (雨)', text.includes('雨从不停'))
ok('macro {{char}} expanded', !text.includes('{{char}}'), text.includes('千岁是一名住在旧书店里的少女') ? 'ok' : 'no-expand')
ok('no raw {{ left', !text.includes('{{'))

// 没有绑定卡的最坏情况不能抛错
writeFileSync(join(root, 'active.json'), JSON.stringify({ cardId: '' }))
const unbound = sections[0].text(context)
ok('unbound hint', unbound.includes('还没有绑定角色卡'), unbound.slice(0, 30).replace(/\n/g, ' '))

rmSync(home, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL OK' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
