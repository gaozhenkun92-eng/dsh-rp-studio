// 真 HTTP 验证宿主接口：把路由接到一个临时 http 服务上，逐条打一遍。
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'rp-studio-http-'))
process.env.DSH_HOME = root

const plugin = await import('../lib/index.js')

let handler
const ctx = {
  webServer: { register: (route) => { handler = route.handler; return () => {} } },
  logger: { info: () => {} }
}
plugin.apply(ctx)
if (!handler) throw new Error('route not registered')
console.log('inject:', JSON.stringify(plugin.inject), '| route prefix registered')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/x-rp-studio`
console.log('listening:', base)

const log = (...a) => console.log(...a)
let failed = 0
function check(label, ok, extra = '') {
  if (!ok) failed += 1
  log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`)
}
async function get(path) {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}
async function send(path, method, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

const health = await get('/health')
check('health', health.body.ok === true, health.body.root)

// 文字卡
const created = await send('/cards', 'POST', { text: '# 妙脆.角\n\n雨夜的便利店里，你捡到了一个人。\n\n她不太说话。' })
check('create text card', created.status === 200 && created.body.card.name === '妙脆.角', created.body.card?.name)
const cardId = created.body.card.id

const list = await get('/cards')
check('list cards', list.body.cards.length === 1, JSON.stringify(list.body.cards.map((c) => c.name)))

const one = await get(`/cards/${cardId}`)
check('get card editorText', one.body.editorText.startsWith('# 妙脆.角'), JSON.stringify(one.body.editorText.slice(0, 12)))

// 新建：只给名字（工坊里「创建角色」走这条）
const blank = await send('/cards', 'POST', { name: '空白角色' })
check('create blank card', blank.status === 200 && blank.body.card.name === '空白角色' && blank.body.card.description === '', JSON.stringify(blank.body.card?.name))
await send(`/cards/${blank.body.card.id}`, 'DELETE')

const patched = await send(`/cards/${cardId}`, 'PATCH', { name: '妙脆' })
check('patch name', patched.body.card.name === '妙脆', patched.body.card.name)

// 导入 JSON 卡
const v2 = { spec: 'chara_card_v2', data: { name: '小满', description: '面包店店员', first_mes: '……早。' } }
const imported = await send('/cards/import', 'POST', { base64: Buffer.from(JSON.stringify(v2)).toString('base64'), fileName: 'a.json' })
check('import json card', imported.body.card.name === '小满', imported.body.card?.name)

// 导出
const pngRes = await fetch(`${base}/cards/${cardId}/export?fmt=png`)
const pngBuf = Buffer.from(await pngRes.arrayBuffer())
check('export png', pngRes.headers.get('content-type') === 'image/png' && pngBuf.subarray(1, 4).toString() === 'PNG')
const jsonRes = await fetch(`${base}/cards/${cardId}/export?fmt=json`)
const jsonCard = await jsonRes.json()
check('export json v2', jsonCard.spec === 'chara_card_v2' && jsonCard.data.name === '妙脆')

// 把导出的 PNG 再导回去（往返）
const back = await send('/cards/import', 'POST', { base64: pngBuf.toString('base64'), fileName: 'round.png' })
check('png roundtrip via http', back.body.card.name === '妙脆', back.body.card?.name)

// 角色卡自带世界书（character_book）随卡导入
const v2book = {
  spec: 'chara_card_v2',
  data: {
    name: '灯塔守夜人',
    description: '住在灯塔里的人',
    character_book: {
      name: '灯塔设定',
      entries: [
        { keys: ['灯塔', 'lighthouse'], content: '灯塔每晚十点点亮。', comment: '点灯时间', insertion_order: 8 },
        { keys: ['风暴'], content: '风暴季在十一月。', constant: true }
      ]
    }
  }
}
const bookImported = await send('/cards/import', 'POST', { base64: Buffer.from(JSON.stringify(v2book)).toString('base64'), fileName: 'book.json' })
check('card import reports embedded worldbook', bookImported.body.worldbookImported === 2, `imported ${bookImported.body?.worldbookImported}`)
const bookId = bookImported.body.card.id
const bookState = await get('/worldbook?cardId=' + bookId)
check(
  'embedded worldbook landed on the card',
  bookState.body.card.length === 2 && bookState.body.card[0].keys.join('|') === '灯塔|lighthouse' && bookState.body.card[1].always === true,
  JSON.stringify(bookState.body.card.map((e) => e.name))
)
const bookExport = await (await fetch(`${base}/cards/${bookId}/export?fmt=json`)).json()
check(
  'card export carries character_book',
  Array.isArray(bookExport.data.character_book?.entries) && bookExport.data.character_book.entries.length === 2,
  `entries ${bookExport.data.character_book?.entries?.length}`
)
const bookAgain = await send('/cards/import', 'POST', { base64: Buffer.from(JSON.stringify(bookExport)).toString('base64'), fileName: 'book2.json' })
check('re-import of exported card keeps worldbook', bookAgain.body.worldbookImported === 2, `imported ${bookAgain.body?.worldbookImported}`)
const delBookCard = await send('/cards/' + bookId, 'DELETE')
check('deleting card clears its worldbook', delBookCard.status === 200)
const bookGone = await get('/worldbook?cardId=' + bookId)
check('worldbook removed with card', bookGone.body.card.length === 0)

// 提示词预览
const preview = await send('/prompt/preview', 'POST', { cardId, text: '' })
check('prompt preview', preview.body.system.includes('妙脆') && preview.body.sections.length > 0, `${preview.body.totalChars} 字符`)

// 会话 + 消息 + swipe
const chat = await send('/chats', 'POST', { cardId, title: '试聊' })
const chatId = chat.body.chat.id
const msg = await send(`/chats/${chatId}/messages`, 'POST', { role: 'assistant', content: '……嗯。' })
const messageId = msg.body.message.id
const variant = await send(`/chats/${chatId}/messages/${messageId}`, 'POST', { content: '……你来了。' })
if (!variant.body.chat) throw new Error('variant route failed: ' + JSON.stringify(variant.body) + ' | messageId=' + messageId)
check('add variant', variant.body.chat.messages[0].variants.length === 2, variant.body.chat.messages[0].content)
const picked = await send(`/chats/${chatId}/messages/${messageId}`, 'PATCH', { variant: 0 })
check('select variant', picked.body.chat.messages[0].content === '……嗯。', picked.body.chat.messages[0].content)

const chats = await get('/chats')
check('list chats', chats.body.chats.length === 1, String(chats.body.chats[0].messageCount))

// 设置
const settings = await send('/settings', 'PATCH', { userName: '我', maxSystemChars: 4000 })
check('patch settings', settings.body.settings.userName === '我', String(settings.body.settings.maxSystemChars))

// 404
const missing = await get('/nope')
check('unknown route 404', missing.status === 404, String(missing.status))

// ---- 图库 ---------------------------------------------------------------
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const emptyGallery = await get('/gallery')
check('gallery empty', emptyGallery.body.images.length === 0)

const up = await send('/gallery', 'POST', { base64: tinyPng.toString('base64'), name: '测试图' })
check('gallery upload', up.status === 200 && up.body.image.id.endsWith('.png'), up.body.image?.id)

const gallery = await get('/gallery')
check('gallery list', gallery.body.images.length === 1, gallery.body.images[0]?.name)
const first = gallery.body.images[0]

const imgRes = await fetch(base + first.path)
const imgBytes = Buffer.from(await imgRes.arrayBuffer())
check('gallery serve bytes', imgRes.headers.get('content-type') === 'image/png' && imgBytes.length === tinyPng.length)

const asAvatar = await send(first.path, 'POST', { cardId })
check('gallery set avatar', asAvatar.status === 200, JSON.stringify(asAvatar.body))

const avatarRes = await fetch(base + `/cards/${cardId}/avatar`)
const avatarBytes = Buffer.from(await avatarRes.arrayBuffer())
check('avatar replaced', avatarBytes.length === tinyPng.length, `${avatarBytes.length} bytes`)

const del = await send(first.path, 'DELETE')
const afterDel = await get('/gallery')
check('gallery delete', del.status === 200 && afterDel.body.images.length === 0)

const badUpload = await send('/gallery', 'POST', { base64: Buffer.from('not an image').toString('base64') })
check('gallery rejects non-image', badUpload.status === 400, JSON.stringify(badUpload.body))

// ---- worldbook: global vs card scope --------------------------------------
const wbEmpty = await get('/worldbook?cardId=' + cardId)
check('worldbook empty', wbEmpty.status === 200 && wbEmpty.body.global.length === 0 && wbEmpty.body.card.length === 0)

const wbGlobal = await send('/worldbook', 'POST', {
  scope: 'global',
  cardId,
  entry: { name: 'world-rule', keys: 'magic,spell', content: 'Magic costs stamina.', priority: 8 }
})
check('worldbook add global', wbGlobal.status === 200 && wbGlobal.body.global.length === 1 && wbGlobal.body.card.length === 0)
check('worldbook keys split', wbGlobal.body.global[0].keys.join('|') === 'magic|spell', wbGlobal.body.global[0].keys.join('|'))

const wbCard = await send('/worldbook', 'POST', {
  scope: 'card',
  cardId,
  entry: { name: 'shop', keys: ['shop'], content: 'Open 24h.', priority: 5 }
})
check('worldbook add card', wbCard.status === 200 && wbCard.body.global.length === 1 && wbCard.body.card.length === 1)

const wbOther = await get('/worldbook?cardId=another-card')
check('worldbook card scope isolated', wbOther.body.global.length === 1 && wbOther.body.card.length === 0)

const wbUpdate = await send('/worldbook/update', 'POST', {
  scope: 'card',
  cardId,
  id: wbCard.body.card[0].id,
  entry: { content: 'Open 24h, sells potions.' }
})
check('worldbook update', wbUpdate.status === 200 && wbUpdate.body.card[0].content.includes('potions'), wbUpdate.body.card[0]?.content)

const wbDel = await send('/worldbook/delete', 'POST', { scope: 'card', cardId, id: wbCard.body.card[0].id })
check('worldbook delete', wbDel.status === 200 && wbDel.body.card.length === 0 && wbDel.body.global.length === 1)

// ---- 大集合（分类）--------------------------------------------------------
const groupNew = await send('/worldbook/group', 'POST', { scope: 'card', cardId, name: '地点' })
check(
  'collection created',
  groupNew.status === 200 && (groupNew.body.groups.card || []).includes('地点'),
  JSON.stringify(groupNew.body.groups)
)
const inGroup = await send('/worldbook', 'POST', {
  scope: 'card',
  cardId,
  entry: { name: '钟楼', group: '地点', keys: ['钟楼'], content: '城里最高的钟楼。' }
})
check(
  'entry inside collection',
  inGroup.status === 200 && inGroup.body.card.some((e) => e.group === '地点'),
  JSON.stringify(inGroup.body.card.map((e) => [e.group, e.name]))
)
const groupOnly = await send('/worldbook/group', 'POST', { scope: 'card', cardId, name: '人物' })
check(
  'empty collection kept',
  groupOnly.status === 200 && (groupOnly.body.groups.card || []).includes('人物') && groupOnly.body.card.every((e) => e.group !== '人物'),
  JSON.stringify(groupOnly.body.groups.card)
)
const groupRename = await send('/worldbook/group/rename', 'POST', { scope: 'card', cardId, from: '地点', to: '地理' })
check(
  'collection rename moves entries',
  groupRename.status === 200 &&
    (groupRename.body.groups.card || []).includes('地理') &&
    !(groupRename.body.groups.card || []).includes('地点') &&
    groupRename.body.card.some((e) => e.group === '地理'),
  JSON.stringify(groupRename.body.groups.card)
)
const groupOff = await send('/worldbook/group/toggle', 'POST', { scope: 'card', cardId, name: '地理', enabled: false })
const offEntries = groupOff.body.card.filter((e) => e.group === '地理')
check(
  'collection switch turns entries off',
  groupOff.status === 200 && offEntries.length === 1 && offEntries.every((e) => e.enabled === false),
  `touched ${groupOff.body.touched}`
)
const targetId = offEntries[0].id
const entryOff = await send('/worldbook/toggle', 'POST', { scope: 'card', cardId, id: targetId, enabled: false })
check(
  'single entry switch',
  entryOff.status === 200 && entryOff.body.card.find((e) => e.id === targetId).enabled === false
)
const previewOff = await send('/prompt/preview', 'POST', { cardId, text: '钟楼在哪' })
check(
  'disabled entry not matched',
  !(previewOff.body.sections || []).some((s) => s.key === 'worldbook' && s.chars > 0),
  JSON.stringify((previewOff.body.sections || []).map((s) => s.key))
)
const groupOn = await send('/worldbook/group/toggle', 'POST', { scope: 'card', cardId, name: '地理', enabled: true })
check(
  'collection switch back on',
  groupOn.status === 200 && groupOn.body.card.filter((e) => e.group === '地理').every((e) => e.enabled === true)
)
// 清掉分类测试留下的条目，后面的导出/导入断言依赖「本卡 0 条」
await send('/worldbook/delete', 'POST', { scope: 'card', cardId, id: targetId })
const groupDrop = await send('/worldbook/group/delete', 'POST', { scope: 'card', cardId, name: '人物' })
check(
  'collection delete drops entries',
  groupDrop.status === 200 && !(groupDrop.body.groups.card || []).includes('人物'),
  JSON.stringify(groupDrop.body.groups.card)
)

// ---- worldbook export / import --------------------------------------------
const wbExport = await get('/worldbook/export?scope=global&cardId=' + cardId)
check(
  'worldbook export rp format',
  wbExport.status === 200 && wbExport.body.spec === 'rp-studio-worldbook' && wbExport.body.entries.length === 1,
  `entries ${wbExport.body.entries?.length}`
)
const stPayload = {
  entries: {
    0: { key: ['灯塔', 'lighthouse'], comment: '灯塔', content: '海边的灯塔每晚都会亮起。', constant: true, order: 9 },
    1: { key: ['旧钥匙'], comment: '旧钥匙', content: '阁楼抽屉里有一把生锈的旧钥匙。', constant: false, order: 3 }
  }
}
const wbImport = await send('/worldbook/import', 'POST', { scope: 'card', cardId, data: stPayload })
check(
  'worldbook import ST format',
  wbImport.status === 200 && wbImport.body.imported === 2 && wbImport.body.card.length === 2,
  `imported ${wbImport.body?.imported} / card ${wbImport.body?.card?.length}`
)
check(
  'worldbook import maps keys and constant',
  wbImport.body.card[0].keys.join('|') === '灯塔|lighthouse' && wbImport.body.card[0].always === true && wbImport.body.card[0].name === '灯塔',
  JSON.stringify(wbImport.body.card[0])
)
const wbImportAgain = await send('/worldbook/import', 'POST', { scope: 'card', cardId, text: JSON.stringify(stPayload) })
check(
  'worldbook re-import skipped as duplicate',
  wbImportAgain.status === 200 && wbImportAgain.body.imported === 0 && wbImportAgain.body.skipped === 2,
  `imported ${wbImportAgain.body?.imported} skipped ${wbImportAgain.body?.skipped}`
)
const wbExportSt = await get('/worldbook/export?scope=card&cardId=' + cardId + '&fmt=st')
const stEntries = Object.values(wbExportSt.body.entries || {})
check(
  'worldbook export ST format',
  wbExportSt.status === 200 && stEntries.length === 2 && Array.isArray(stEntries[0].key),
  `entries ${stEntries.length}`
)
const wbImportText = await send('/worldbook/import', 'POST', {
  scope: 'global',
  cardId,
  text: '月光 | 满月时湖水会变成银色。\n# 注释行忽略\n'
})
check(
  'worldbook import plain text line',
  wbImportText.status === 200 && wbImportText.body.imported === 1,
  `imported ${wbImportText.body?.imported}`
)
const wbImportBad = await send('/worldbook/import', 'POST', { scope: 'card', cardId, data: { entries: {} } })
check('worldbook import rejects empty', wbImportBad.status === 400, `status ${wbImportBad.status}`)

const wbPreview = await send('/prompt/preview', 'POST', { cardId, text: 'I cast a spell at the shop.' })
const wbSection = (wbPreview.body.sections || []).find((s) => s.key === 'worldbook')
check('prompt uses merged worldbook', wbPreview.status === 200 && !!wbSection && wbSection.chars > 0, wbSection ? `${wbSection.chars} chars` : 'no worldbook section')

const bindActive = await send('/active', 'POST', { cardId })
check('bind active card', bindActive.status === 200 && bindActive.body.cardId === cardId, String(bindActive.body?.cardId))

const delCard = await send('/cards/' + cardId, 'DELETE')
check('card delete', delCard.status === 200 && delCard.body.ok === true)
const cardsAfter = await get('/cards')
check('card list after delete', cardsAfter.body.cards.every((c) => c.id !== cardId))

// 删卡后局部世界书必须一起没了；全局条目必须还在
const wbAfterDelete = await get('/worldbook?cardId=' + cardId)
check('card worldbook removed with card', (wbAfterDelete.body.card || []).length === 0, `card ${(wbAfterDelete.body.card || []).length}`)
check('global worldbook survives card delete', (wbAfterDelete.body.global || []).length > 0, `global ${(wbAfterDelete.body.global || []).length}`)
const activeAfterDelete = await get('/active')
check('active binding cleared with card', (activeAfterDelete.body.cardId || '') === '', JSON.stringify(activeAfterDelete.body))

server.close()
await rm(root, { recursive: true, force: true })
log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
