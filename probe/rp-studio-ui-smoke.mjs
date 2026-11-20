// Smoke-test the control-panel bundle without a browser:
// registration -> apply() -> render the tab view -> check the 3-column layout,
// the header switch, the right-hand menu, and the data requests it fires.
import { readFileSync } from 'node:fs'

const FILE = new URL('../lib/client.js', import.meta.url)
const source = readFileSync(FILE, 'utf8')

let registration
const windowStub = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
new Function('window', source)(windowStub)
if (!registration || typeof registration.factory !== 'function') throw new Error('factory missing')

const store = new Map()
windowStub.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) }
}
windowStub.document = {
  getElementById: () => null,
  createElement: () => ({ click() {} }),
  body: { appendChild() {}, removeChild() {} }
}
const requests = []
windowStub.fetch = (url, init) => {
  requests.push({ url, method: (init && init.method) || 'GET' })
  const body =
    url.endsWith('/cards')
      ? { cards: [{ id: 'card-1', name: 'A', source: 'png', chars: 20, hasAvatar: true, updatedAt: 't' }] }
      : url.endsWith('/active')
        ? { cardId: 'card-1' }
        : url.endsWith('/settings')
          ? { settings: { userName: 'u', userPersona: '', stylePrompt: '', maxSystemChars: 9000, imageProvider: 'none', imageBaseUrl: 'x', toolGroups: { fs: true, shell: true, web: true, subagent: true, skill: true } } }
          : url.includes('/cards/card-1')
            ? { card: { id: 'card-1', name: 'A', description: 'd', scenario: 's', personality: 'p', postHistoryInstructions: 'h', customSections: [] }, editorText: 'A\nd' }
            : url.endsWith('/gallery')
              ? { images: [
                  { id: 'studio/rain.png', name: '雨夜的阳台', fileName: 'rain.png', source: 'studio', bytes: 10, createdAt: 'c2', path: '/gallery/studio/rain.png' },
                  { id: 'roleplay0/gen.png', name: 'gen', fileName: 'gen.png', source: 'roleplay0', bytes: 10, createdAt: 'c1', path: '/gallery/roleplay0/gen.png' }
                ] }
              : { system: 'S', sections: [], totalChars: 0, totalTokens: 0, budget: 9000 }
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) })
}
windowStub.FileReader = class { readAsDataURL() {} }

let slots = []
let cursor = 0
const ReactStub = {
  // 模仿 React：children 也会挂在 props.children 上，否则函数组件取不到
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    children
  }),
  useState: (init) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init
    return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  },
  useEffect: (fn) => { fn() }
}
function render(component, props) {
  slots = []
  cursor = 0
  return component(props)
}

const mod = registration.factory((spec) => {
  if (spec === 'react') return ReactStub
  throw new Error(`unexpected require("${spec}")`)
})

const registered = []
const ctxStub = {
  slots: {
    inject: (slot, cb) => { cb(); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} }
  }
}
mod.apply(ctxStub)
console.log('registered:', registered.map((c) => `${c.options.name}[${c.options.id || c.options.key}]`).join(', '))
if (registered.length !== 1) throw new Error('only the top-bar tab should be registered, got ' + registered.length)
const tab = registered[0]
if (tab.options.id !== 'rp-studio') throw new Error('wrong tab slot')

const tree = render(tab.component, {})
if (tab.options.label() !== '角色后台') throw new Error('tab label should be 角色后台, got ' + tab.options.label())
console.log('tab label:', tab.options.label(), '| root children:', tree.children.length)

const header = tree.children[0]
const body = tree.children[1]
const headerTitle = header.children[0].children[0]
// 首帧 settings 还没回来 → 回落「你的伙伴」；拿到 settings.userName 后应变「u的伙伴」
if (headerTitle !== '你的伙伴') throw new Error('header title fallback should be 你的伙伴, got ' + headerTitle)
const headerSwitch = header.children.find((c) => c && typeof c.type === 'function' && c.type.name === 'Switch')
if (!headerSwitch) throw new Error('the master switch belongs in the top bar')
if (headerSwitch.props.checked !== false) throw new Error('the master switch must default to off')
console.log('header: 开关回到顶栏 + 默认关 ok')

// 标题跟随 userName：探针的桩 React 不触发重渲染，故直接对源码做静态断言
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
if (clientSrc.indexOf('partnerTitle(state.settings)') < 0) throw new Error('header no longer bound to settings.userName')
if (!/'的伙伴'/.test(clientSrc)) throw new Error('partnerTitle no longer appends 的伙伴')
console.log('header title bound to settings.userName ok')

const [left, middle, right] = body.children
const rightItems = right.children[0]
const labels = rightItems.map((b) => b.children[0])
console.log('columns:', body.children.length, '| left width:', left.props.style.width, '| menu:', labels.join(' / '))
if (body.children.length !== 3) throw new Error('expected three columns')
const expected = ['角色设定', '世界书', '图库', '用户信息', '权限设置', '切换角色']
if (JSON.stringify(labels) !== JSON.stringify(expected)) throw new Error('menu labels changed: ' + labels.join(','))

// section element (CardEditor returns a Section element)
const sectionEl = middle.children.find((c) => c && typeof c.type === 'function')
// 探针不等异步链，直接喂一张卡给编辑器
const fakeState = {
  card: { id: 'card-1', name: 'A', description: 'd', scenario: 's', personality: 'p', postHistoryInstructions: 'h', customSections: [] },
  activeId: 'card-1',
  busy: false,
  setCard() {},
  setError() {},
  reloadCards: () => Promise.resolve(),
  settings: {}
}
const sectionTree = render(sectionEl.type, { state: fakeState })

// 编辑器子树里只有无 hook 的小组件：全部展开后线性查找
function collect(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const inner of node) collect(inner, out)
    return
  }
  out.push(node)
  if (typeof node.type === 'function') {
    try {
      collect(node.type(node.props), out)
    } catch (error) {
      /* 展开失败就跳过 */
    }
  }
  if (Array.isArray(node.children)) {
    for (const kid of node.children) collect(kid, out)
  }
}

function findTag(root, tag) {
  const all = []
  collect(root, all)
  return all.find((node) => node.type === tag) || null
}
const textarea = findTag(sectionTree, 'textarea')
console.log('middle default section:', sectionEl.type.name, '| textarea found:', !!textarea)
if (!textarea) throw new Error('card editor missing textarea')

// 四个固定框 + 展开按钮 + 底部「自定义」按钮；保存按钮已取消（输入即存）
const editorText = JSON.stringify(sectionTree)
for (const label of ['人设', '背景故事', '说话风格', '特殊内容', '自定义', '⤢']) {
  if (editorText.indexOf(label) < 0) throw new Error('editor missing: ' + label)
}
for (const gone of ['全部保存', '保存这一框', '加一个框']) {
  if (editorText.indexOf(gone) >= 0) throw new Error('editor still has: ' + gone)
}
console.log('editor blocks: 四框 + 展开按钮 + 底部自定义 ok; 保存按钮已移除')
// 高度记忆：框上带 onMouseUp 才会记住拖出来的高度
if (!textarea.props.onMouseUp) throw new Error('textarea missing height memory handler')

const leftText = JSON.stringify(left)
console.log('left fields:', ['角色名', '导入角色卡', '创建角色'].map((t) => `${t}:${leftText.includes(t)}`).join(' '))
if (leftText.includes('角色名')) throw new Error('left still shows 角色名 label')
if (leftText.includes('＋ 创建角色')) throw new Error('left still has create button')
if (!leftText.includes('导入角色卡')) throw new Error('import button missing')

// 挂载后的请求是异步链（/active -> /cards），等一个宏任务再断言
await new Promise((resolve) => setTimeout(resolve, 30))
console.log('requests:', requests.map((r) => `${r.method} ${r.url.replace('/x-rp-studio', '')}`).join(', '))
if (!requests.some((r) => r.url.endsWith('/cards'))) throw new Error('cards not loaded')
if (!requests.some((r) => r.url.endsWith('/settings'))) throw new Error('settings not loaded')

const style = tree.props.style
console.log('root style:', JSON.stringify({ flex: style.flex, minHeight: style.minHeight, contain: style.contain, overflow: style.overflow }))
if (style.flex !== '1 1 0%' || style.minHeight !== 0 || !style.contain) throw new Error('layout contract broken')

// 顶栏不再有开关：渲染完也不该写 localStorage 的旧键
if (store.get('dsh-rp-studio.enabled') !== undefined) throw new Error('the tab should no longer write the enable flag')
console.log('header toggle removed ok')

// 输入即记忆：改一下框，400ms 后应出现一次 PATCH
const beforePatch = requests.filter((r) => r.method === 'PATCH').length
textarea.props.onChange({ target: { value: '自动保存测试' } })
await new Promise((resolve) => setTimeout(resolve, 520))
const afterPatch = requests.filter((r) => r.method === 'PATCH').length
console.log('autosave PATCH:', beforePatch, '->', afterPatch)
if (afterPatch <= beforePatch) throw new Error('autosave did not fire')

// 切换角色面板：创建区复用设定界面（名字 + 四个框 + 创建按钮）
store.set('dsh-rp-studio.section', 'picker')
const pickerTree = render(tab.component, {})
const pickerMiddle = pickerTree.children[1].children[1]
const pickerEl = pickerMiddle.children.find((c) => c && typeof c.type === 'function')
console.log('picker section:', pickerEl && pickerEl.type.name)
if (!pickerEl || pickerEl.type.name !== 'PickerPanel') throw new Error('picker panel missing')
const pickerState = Object.assign({}, fakeState, { cards: [], setActiveId() {} })
const pickerRendered = render(pickerEl.type, { state: pickerState })
const pickerText = JSON.stringify(pickerRendered)
if (pickerText.indexOf('＋ 创建角色') < 0) throw new Error('picker missing create trigger')
if (pickerText.indexOf('人设') >= 0) throw new Error('create form should stay collapsed')
console.log('picker collapsed: 只有「＋ 创建角色」按钮')
// 打开创建区：点「＋ 创建角色」后同一槽位变 true，再渲染一次（不重置槽位）应出现表单
const trigger = []
collect(pickerRendered, trigger)
const createBtn = trigger.find((n) => n && n.props && n.props.onClick && JSON.stringify(n.props.children || '').indexOf('创建角色') >= 0)
if (!createBtn) throw new Error('create trigger button missing')
createBtn.props.onClick()
cursor = 0
const pickerOpen = pickerEl.type({ state: pickerState })
const openText = JSON.stringify(pickerOpen)
for (const label of ['创建角色', '名字', '人设', '背景故事', '说话风格', '特殊内容', '创建']) {
  if (openText.indexOf(label) < 0) throw new Error('open form missing: ' + label)
}
console.log('picker open form: 名字 + 四框 + 创建 ok')

// ---- 图库：网格带名字 + 改名弹窗 ----
store.set('dsh-rp-studio.section', 'gallery')
const galleryTree = render(tab.component, {})
const galleryMiddle = galleryTree.children[1].children[1]
const galleryEl = galleryMiddle.children.find((c) => c && typeof c.type === 'function')
console.log('gallery section:', galleryEl && galleryEl.type.name)
if (!galleryEl || galleryEl.type.name !== 'GalleryPanel') throw new Error('gallery panel missing')
const galleryState = Object.assign({}, fakeState, { activeId: 'card-1' })
slots = []
cursor = 0
galleryEl.type({ state: galleryState })
await new Promise((resolve) => setTimeout(resolve, 40))
cursor = 0
const galleryRendered = galleryEl.type({ state: galleryState })
const galleryText = JSON.stringify(galleryRendered)
if (galleryText.indexOf('雨夜的阳台') < 0) throw new Error('gallery grid should show custom image name')
const gNodes = []
collect(galleryRendered, gNodes)
const gridNode = gNodes.find((n) => n && n.props && n.props.style && String(n.props.style.gridTemplateColumns || '').indexOf('120px') >= 0)
if (!gridNode) throw new Error('gallery grid template missing')
if (gridNode.props.style.gap !== 10) throw new Error('gallery gap should be 10')
console.log('gallery grid:', gridNode.props.style.gridTemplateColumns, '| names under thumb ok')

// 选中一张图后详情条才出现「改名」
const cardNode = gNodes.find((n) => n && n.props && n.props.title === 'rain.png' && n.props.onClick)
if (!cardNode) throw new Error('gallery card node missing')
cardNode.props.onClick()
cursor = 0
const selectedTree = galleryEl.type({ state: galleryState })
const selectedNodes = []
collect(selectedTree, selectedNodes)
const renameBtn = selectedNodes.find((n) => n && n.type && n.type.name === 'Button' && n.props && n.props.onClick && JSON.stringify(n.props.children || '').indexOf('改名') >= 0)
if (!renameBtn) throw new Error('rename button node missing')
console.log('select image -> 改名 button ok')

renameBtn.props.onClick()
cursor = 0
const withDialog = galleryEl.type({ state: galleryState })
const dialogText = JSON.stringify(withDialog)
for (const label of ['图片的新名字', '取消', '确定']) {
  if (dialogText.indexOf(label) < 0) throw new Error('rename dialog missing: ' + label)
}
console.log('rename dialog: 名字输入 + 取消/确定 ok')

// ---- 左栏头像更大 ----
if (left.props.style.width !== 272) throw new Error('left column should be 272 wide, got ' + left.props.style.width)
const leftNodes = []
collect(left, leftNodes)
const avatarImg = leftNodes.find((n) => n && n.type === 'img' && n.props && n.props.src && n.props.src.indexOf('/avatar') >= 0)
if (avatarImg && avatarImg.props.style.objectFit !== 'contain') throw new Error('avatar should keep objectFit contain')
console.log('left column width:', left.props.style.width, '| avatar contain ok')

// ---- 辅助词条清空 + 占位提示只在空数据时出现 ----
const wholeTree = JSON.stringify(tree)
for (const gone of ['PNG 头像', '点图片可换头像', '角色能用的工具', '角色卡与设定保存在', '会写进系统提示']) {
  if (wholeTree.indexOf(gone) >= 0) throw new Error('helper text still present: ' + gone)
}
if (/placeholder/.test(JSON.stringify(sectionTree))) throw new Error('editor still has placeholders')
if (/placeholder/.test(galleryText)) throw new Error('gallery still has placeholders')
console.log('helper texts removed | no placeholders in editor/gallery')

// 空态才有提示：没有卡时出现「左边还没有选中角色卡」
cursor = 0
slots = []
const emptyEditor = sectionEl.type({ state: Object.assign({}, fakeState, { card: null, activeId: '' }) })
const emptyText = JSON.stringify(emptyEditor)
if (emptyText.indexOf('左边还没有选中角色卡') < 0) throw new Error('empty-state hint missing when no card')
if (JSON.stringify(sectionTree).indexOf('左边还没有选中角色卡') >= 0) throw new Error('empty-state hint leaks with a card selected')
console.log('empty-state hint shows only without a card')

// 空图库才有「图库还是空的」
slots = []
cursor = 0
const emptyGallery = galleryEl.type({ state: galleryState })
console.log('gallery empty hint present in first (empty) render:', JSON.stringify(emptyGallery).indexOf('图库还是空的') >= 0)

// ---- 世界书：大集合 + 开关 + 逐条编辑 ----
windowStub.fetch = (url, init) => {
  requests.push({ url, method: (init && init.method) || 'GET' })
  const body = url.indexOf('/worldbook?cardId=') >= 0
    ? {
        global: [],
        card: [
          { id: 'e1', name: '钟楼', group: '地理', enabled: true, keys: ['钟楼'], content: '城里最高的钟楼。', priority: 5, always: false },
          { id: 'e2', name: '散条目', group: '', enabled: false, keys: ['散'], content: '未归类的一条。', priority: 3, always: false }
        ],
        groups: { global: [], card: ['地理', '人物'] }
      }
    : {}
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) })
}
store.set('dsh-rp-studio.section', 'worldbook')
const wbTree = render(tab.component, {})
const wbMiddle = wbTree.children[1].children[1]
const wbEl = wbMiddle.children.find((c) => c && typeof c.type === 'function')
console.log('worldbook section:', wbEl && wbEl.type.name)
if (!wbEl || wbEl.type.name !== 'WorldbookPanel') throw new Error('worldbook panel missing')
const wbState = Object.assign({}, fakeState, { activeId: 'card-1' })
slots = []
cursor = 0
wbEl.type({ state: wbState })
await new Promise((resolve) => setTimeout(resolve, 40))
cursor = 0
const wbRendered = wbEl.type({ state: wbState })
const wbText = JSON.stringify(wbRendered)
for (const label of ['+ 新建集合', '地理', '人物', '未归类', '钟楼', '编辑', '删除', '+ 条目']) {
  if (wbText.indexOf(label) < 0) throw new Error('worldbook UI missing: ' + label)
}
console.log('worldbook collections: 地理 / 人物 / 未归类 + 新建集合 ok')

const wbNodes = []
collect(wbRendered, wbNodes)
const groupSwitches = wbNodes.filter((n) => n && n.type && n.type.name === 'Switch')
if (groupSwitches.length < 3) throw new Error('expected collection + entry switches, got ' + groupSwitches.length)
const entrySwitches = wbNodes.filter((n) => n && n.type && n.type.name === 'Switch' && n.props.checked === false)
if (entrySwitches.length === 0) throw new Error('disabled entry switch should render off')
console.log('switches:', groupSwitches.length, '| disabled entry renders off ok')

const editBtn = wbNodes.find((n) => n && n.type && n.type.name === 'Button' && JSON.stringify(n.props.children || '').indexOf('编辑') >= 0)
if (!editBtn) throw new Error('edit button missing')
editBtn.props.onClick()
cursor = 0
const wbEditing = wbEl.type({ state: wbState })
const editingNodes = []
collect(wbEditing, editingNodes)
const saveBtn = editingNodes.find((n) => n && n.type && n.type.name === 'Button' && JSON.stringify(n.props.children || '').indexOf('保存') >= 0)
const groupSelect = editingNodes.find((n) => n.type === 'select')
if (!saveBtn) throw new Error('edit form should offer 保存')
if (!groupSelect) throw new Error('edit form should offer collection select')
console.log('entry edit form: 保存 + 集合下拉 ok')

const newGroupBtn = wbNodes.find((n) => n && n.type && n.type.name === 'Button' && JSON.stringify(n.props.children || '').indexOf('新建集合') >= 0)
newGroupBtn.props.onClick()
cursor = 0
const wbDialog = wbEl.type({ state: wbState })
const dialogText2 = JSON.stringify(wbDialog)
for (const label of ['新集合的名字', '取消', '确定']) {
  if (dialogText2.indexOf(label) < 0) throw new Error('collection dialog missing: ' + label)
}
console.log('collection dialog: 新集合的名字 ok')

// ---- 权限设置：无总开关 + 六组默认关 + 「给予以上之外的其他完整权限」+ 细致范围说明 ----
store.set('dsh-rp-studio.section', 'sanitize')
const permTree = render(tab.component, {})
const permMiddle = permTree.children[1].children[1]
const permEl = permMiddle.children.find((c) => c && typeof c.type === 'function')
if (!permEl || permEl.type.name !== 'SanitizePanel') throw new Error('permission panel missing, got ' + (permEl && permEl.type.name))
const permState = {
  settings: { enabled: false, allowOthers: false, toolGroups: { fs: false, shell: false, web: false, subagent: false, skill: false, gallery: false } },
  setSettings: () => {},
  setError: () => {}
}
cursor = 0
const permRendered = permEl.type({ state: permState })
const permText = JSON.stringify(permRendered)
for (const label of ['给予以上之外的其他完整权限', 'AI 权限细致范围', '文件读写', '命令行', '联网', '子智能体', '技能与交付', '图库', '顶栏右上角']) {
  if (permText.indexOf(label) < 0) throw new Error('permission panel missing: ' + label)
}
if (permText.indexOf('禁止以上之外') >= 0) throw new Error('the old label should be gone')
if (permText.indexOf('启用角色扮演') >= 0) throw new Error('master switch should not live in the permission panel')
const permNodes = []
collect(permRendered, permNodes)
const permSwitches = [...new Set(permNodes.filter((n) => n && n.type && n.type.name === 'Switch'))]
if (permSwitches.length !== 7) throw new Error('expected 7 switches (6 groups + allowOthers), got ' + permSwitches.length)
if (permSwitches.some((s) => s.props.checked === true)) throw new Error('every switch should start off')
if (permSwitches.filter((s) => s.props.disabled === true).length !== 7) throw new Error('group switches should be disabled while master is off')
console.log('permission panel: 无总开关 + 六组全关 + 「给予以上之外的其他完整权限」+ 细致范围说明 ok')

// ---- 顶栏开关：先弹确认，勾了「不再弹出」才直接生效 ----
store.set('dsh-rp-studio.section', 'card')
const warnTree0 = render(tab.component, {})
const topSwitch = warnTree0.children[0].children.find((c) => c && typeof c.type === 'function' && c.type.name === 'Switch')
topSwitch.props.onChange(true)
cursor = 0
const warnTree1 = tab.component({})
const warnEl = warnTree1.children.find((c) => c && typeof c.type === 'function' && c.type.name === 'EnableWarning')
if (!warnEl) throw new Error('EnableWarning element missing after switching on')
cursor = 0
const warnText = JSON.stringify(warnEl.type(warnEl.props))
for (const label of ['开启前请确认', '请先勾选已读', '取消', '权限设置', '以后不再弹出这个提醒', '我已阅读并同意',
  '超出角色扮演的权限', '读写文件、执行命令、联网、派子智能体、技能与交付', '自行承担', '祝您愉快']) {
  if (warnText.indexOf(label) < 0) throw new Error('enable warning missing: ' + label)
}
if (warnText.indexOf('"disabled":true') < 0) throw new Error('confirm must start disabled until 已读 is checked')
console.log('enable warning: 双勾选框（已读必勾 / 不再弹出可选）+ 警告四条 ok')

console.log('OK')
