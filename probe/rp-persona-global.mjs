// 验证「全局人格段」：dsh-rp-studio 的宿主 apply() 在**部署层**注册
// rp-studio:persona，且没有卡时静默返回空串。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'rpstudio-persona-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'rp-studio', 'cards'), { recursive: true })
mkdirSync(join(home, 'rp-studio', 'worldbooks'), { recursive: true })
writeFileSync(
  join(home, 'rp-studio', 'cards', 'c1.json'),
  JSON.stringify({
    id: 'c1',
    name: '妙脆角',
    description: '一只酥脆的角。',
    personality: '嘴硬心软',
    scenario: '深夜便利店',
    firstMes: '你怎么才来。',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: ['测试'],
    spec: 'v2',
    source: 'probe',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  })
)
writeFileSync(join(home, 'rp-studio', 'worldbooks', '_global.json'), JSON.stringify([]))
writeFileSync(join(home, 'rp-studio', 'settings.json'), JSON.stringify({ enabled: true, userName: '阿榆', userPersona: '一个失意的青年', stylePrompt: '短句，口语。' }))

const mod = await import('../lib/index.js')

const captured = []
const ctx = {
  logger: { info: () => {}, warn: (m) => captured.push(['warn', String(m)]) },
  webServer: { register: () => () => {} },
  effect: (fn) => fn(),
  tools: { register: () => () => {} },
  systemPrompt: { section: (cfg) => { captured.push(['section', cfg]); return () => {} } }
}

mod.apply(ctx)

const section = captured.find(([kind]) => kind === 'section')
const fails = []
const ok = (label, cond, detail) => {
  if (!cond) fails.push(`${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` | ${detail}`}`)
}

ok('apply did not warn', !captured.some(([k]) => k === 'warn'), captured.filter(([k]) => k === 'warn').map(([, m]) => m).join('; '))
ok('registered exactly one prompt section', captured.filter(([k]) => k === 'section').length === 1)
ok('section name', section && section[1].name === 'rp-studio:persona', section && section[1].name)
ok('section order between persona(0) and plan(500)', section && section[1].order === 0.5, section && section[1].order)
ok('section name differs from deployment persona slot', section && section[1].name !== 'deployment:persona-prefix')

const text = section[1].text
ok('no card -> empty string (silent)', text({}) === '', JSON.stringify(text({})))

writeFileSync(join(home, 'rp-studio', 'active.json'), JSON.stringify({ cardId: 'c1' }))
const agent = { session: { deriveMessages: () => [{ role: 'user', content: '在吗' }] } }
const body = text({ agent })
ok('with card -> non-empty', typeof body === 'string' && body.length > 0, `${body.length} chars`)
ok('contains character name', body.includes('妙脆角'))
ok('contains user persona', body.includes('一个失意的青年'))
ok('contains style rules', body.includes('短句，口语。'))
ok('no stray {{ macros', !body.includes('{{'))

writeFileSync(join(home, 'rp-studio', 'active.json'), JSON.stringify({ cardId: 'missing' }))
ok('dangling active id -> empty string', text({ agent }) === '')

// 总开关关着：即使有卡也必须一个字都不注。
writeFileSync(join(home, 'rp-studio', 'active.json'), JSON.stringify({ cardId: 'c1' }))
writeFileSync(join(home, 'rp-studio', 'settings.json'), JSON.stringify({ enabled: false, userName: '阿榆', userPersona: '一个失意的青年', stylePrompt: '短句，口语。' }))
ok('enabled=false -> empty string even with card', text({ agent }) === '')

rmSync(home, { recursive: true, force: true })
console.log(fails.length === 0 ? 'ALL OK' : `FAILURES: ${fails.length}`)
