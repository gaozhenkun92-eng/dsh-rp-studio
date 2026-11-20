// Smoke-test the browser bundle without a browser: run the registration,
// materialize the factory with a stub React, call apply() against a fake
// slots service, then render the tab view and walk the enable/disable flow:
// switch -> warning -> 已读 gating -> confirm -> settings PATCH -> skip persistence.
import { readFileSync } from 'node:fs'

const FILE = new URL('../lib/client.js', import.meta.url)
const source = readFileSync(FILE, 'utf8')

let registration
const windowStub = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
new Function('window', source)(windowStub)

console.log('registration id:', registration?.id)
if (!registration || typeof registration.factory !== 'function') throw new Error('factory missing')

// --- React stub: createElement + the hooks the bundle uses -------------------
let stateSlots = []
let stateCursor = 0
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => {
    const index = stateCursor++
    if (!(index in stateSlots)) stateSlots[index] = typeof init === 'function' ? init() : init
    return [
      stateSlots[index],
      (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next }
    ]
  },
  useEffect: (fn) => { fn() }
}
function render(component, props) {
  stateSlots = []
  stateCursor = 0
  return component(props)
}
function deep(node, depth = 0) {
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function' && depth < 8) return deep(render(node.type, node.props), depth + 1)
  if (Array.isArray(node.children)) {
    return { ...node, children: node.children.map((child) => deep(child, depth + 1)) }
  }
  return node
}
// Flatten element nodes without expanding function components, so props of
// CheckRow / Button stay inspectable.
function flat(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  const kids = Array.isArray(node.children) ? node.children : node.children ? [node.children] : []
  for (const child of kids) flat(child, out)
  return out
}
const textOf = (node) => flat(node).filter((n) => typeof n === 'string').join(' ')

// --- localStorage stub -------------------------------------------------------
const store = new Map()
windowStub.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) }
}

const requireStub = (spec) => {
  if (spec === 'react') return ReactStub
  throw new Error(`unexpected require("${spec}")`)
}

const mod = registration.factory(requireStub)
console.log('exports:', Object.keys(mod), '| name:', mod.name, '| inject:', JSON.stringify(mod.inject))

// --- fake slots service ------------------------------------------------------
const registered = []
let disposeCalls = 0
const ctxStub = {
  slots: {
    inject: (slot, cb) => {
      console.log('slots.inject ->', slot)
      cb()
      let disposed = false
      return () => { if (!disposed) { disposed = true; disposeCalls += 1 } }
    },
    register: (options, component) => {
      const cell = { options, component }
      registered.push(cell)
      return () => { cell.disposed = true }
    }
  }
}
mod.apply(ctxStub)

console.log('registered cells:', registered.map((c) => `${c.options.name}[${c.options.id ?? c.options.key}]`).join(', '))
if (registered.length !== 1) throw new Error('only the tab should register now, got ' + registered.length)
const tab = registered[0]
if (tab.options.name !== 'conversation.view') throw new Error('conversation.view not registered')
if (tab.options.id !== 'rp-studio' || tab.options.order !== 40) throw new Error('tab options wrong')

const tabTree = render(tab.component, {})
console.log('tab label:', tab.options.label(), '| rendered:', tabTree.type, JSON.stringify(tabTree.children?.[0]?.children))

const patches = []
windowStub.fetch = (url, init) => {
  if (init && init.method === 'PATCH') patches.push({ url, body: init.body })
  const body = url.endsWith('/settings') ? { settings: { enabled: false } } : {}
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) })
}

const headerSwitch = tabTree.children?.[0]?.children?.find((c) => c && typeof c.type === 'function' && c.type.name === 'Switch')
if (!headerSwitch) throw new Error('top-bar switch missing')
if (headerSwitch.props.checked !== false) throw new Error('the master switch must default to off')
const switchBtn = deep(headerSwitch)
console.log('header switch:', switchBtn?.type, '| role:', switchBtn?.props?.role, '| aria-checked:', switchBtn?.props?.['aria-checked'])

// --- 打开开关：先弹警告，确认后才写 settings.json -----------------------------
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
headerSwitch.props.onChange(true)
stateCursor = 0
const rerendered = tab.component({})
const warnEl = rerendered.children.find((c) => c && typeof c.type === 'function' && c.type.name === 'EnableWarning')
if (!warnEl) throw new Error('switching on should raise the warning first')
if (patches.length !== 0) throw new Error('nothing should be written before confirming')

// 1) 两个独立勾选框 + 未勾已读时确认按钮不可点
const EnableWarning = warnEl.type
const confirmCalls = []
const warnProps = { onCancel: () => {}, onConfirm: (skip) => { confirmCalls.push(skip) } }
stateSlots = []
stateCursor = 0
const freshWarn = EnableWarning(warnProps)
const freshNodes = flat(freshWarn)
const checkRows = freshNodes.filter((n) => n.type && n.type.name === 'CheckRow')
if (checkRows.length !== 2) throw new Error('expected two separate checkboxes, got ' + checkRows.length)
const agreeRow = checkRows[0]
const skipRow = checkRows[1]
const agreeText = textOf(agreeRow)
const skipText = textOf(skipRow)
if (agreeText.indexOf('我已阅读并同意') < 0) throw new Error('the first checkbox must be the 已读 confirmation')
if (skipText.indexOf('以后不再弹出') < 0) throw new Error('the second checkbox must be the 不再弹出 preference')
if (agreeText.indexOf('以后不再弹出') >= 0 || skipText.indexOf('我已阅读并同意') >= 0) {
  throw new Error('the two checkboxes must be independent')
}
const freshButtons = freshNodes.filter((n) => n.type && n.type.name === 'Button')
const freshConfirm = freshButtons[freshButtons.length - 1]
console.log('warning checkboxes:', JSON.stringify([agreeText.slice(0, 14), skipText.slice(0, 12)]))
console.log('confirm before agree: disabled =', freshConfirm.props.disabled, '| label =', textOf(freshConfirm).trim())
if (freshConfirm.props.disabled !== true) throw new Error('confirm must be disabled until 已读 is checked')
if (textOf(freshConfirm).indexOf('请先勾选已读') < 0) throw new Error('disabled confirm should say 请先勾选已读')

// 2) 勾上已读后按钮可点，且点了不会绕过 onConfirm
stateSlots = [true, false]
stateCursor = 0
const agreedWarn = EnableWarning(warnProps)
const agreedNodes = flat(agreedWarn)
const agreedButtons = agreedNodes.filter((n) => n.type && n.type.name === 'Button')
const agreedConfirm = agreedButtons[agreedButtons.length - 1]
if (agreedConfirm.props.disabled === true) throw new Error('confirm must be clickable once 已读 is checked')
agreedConfirm.props.onClick()
if (confirmCalls.length !== 1 || confirmCalls[0] !== false) throw new Error('agree-only confirm should report skip=false')

// 3) 勾上「不再弹出」后回传 skip=true
stateSlots = [true, true]
stateCursor = 0
const skipWarn = EnableWarning(warnProps)
const skipNodes = flat(skipWarn)
const skipButtons = skipNodes.filter((n) => n.type && n.type.name === 'Button')
skipButtons[skipButtons.length - 1].props.onClick()
if (confirmCalls[1] !== true) throw new Error('skip checkbox should be reported to onConfirm')

// 4) 真正确认（不勾不再弹出）：写 enabled=true，skip 记 0
warnEl.props.onConfirm(false)
await tick()
console.log('after confirm -> PATCH /settings:', patches.length, '| body:', patches[0] && patches[0].body, '| skip flag:', store.get('dsh-rp-studio.skipWarning'))
if (patches.length !== 1) throw new Error('confirming should PATCH /settings once')
if (String(patches[0].body).indexOf('"enabled":true') < 0) throw new Error('confirming should enable the plugin')
if (store.get('dsh-rp-studio.skipWarning') !== '0') throw new Error('skip flag must stay off when the box is unchecked')
if (registered.length !== 1) throw new Error('the tab should stay registered when the plugin is toggled')

// 5) 关掉再打开：弹窗必须重新出现（这是用户报的那个 bug）
stateCursor = 0
const offTree = tab.component({})
const offSwitch = offTree.children?.[0]?.children?.find((c) => c && typeof c.type === 'function' && c.type.name === 'Switch')
offSwitch.props.onChange(false)
stateCursor = 0
tab.component({})
stateCursor = 0
const backOn = tab.component({})
const onSwitch = backOn.children?.[0]?.children?.find((c) => c && typeof c.type === 'function' && c.type.name === 'Switch')
onSwitch.props.onChange(true)
stateCursor = 0
const reopened = tab.component({})
const reopenedWarn = reopened.children.find((c) => c && typeof c.type === 'function' && c.type.name === 'EnableWarning')
console.log('re-open after off -> warning shown again:', Boolean(reopenedWarn))
if (!reopenedWarn) throw new Error('toggling off then on must raise the warning again')

// 6) 权限设置里的复位入口存在
if (source.indexOf('重新播放开启提醒') < 0) throw new Error('sanitize panel must offer a replay entry')
if (source.indexOf('writeSkipWarning(false)') < 0) throw new Error('replay entry must clear the skip flag')
if (source.indexOf('warnBridge.open') < 0) throw new Error('replay entry must be able to open the dialog')

// --- layout contract of the view root ---------------------------------------
const viewStyle = tabTree.props.style
console.log('view root style:', JSON.stringify({
  flex: viewStyle.flex,
  minHeight: viewStyle.minHeight,
  contain: viewStyle.contain,
  overflow: viewStyle.overflow
}))
if (viewStyle.minHeight !== 0) throw new Error('view root must not force a min height')
if (viewStyle.flex !== '1 1 0%') throw new Error('view root must be a shrinkable flex item')
if (!viewStyle.contain) throw new Error('view root must contain its own layout')

console.log('OK')
