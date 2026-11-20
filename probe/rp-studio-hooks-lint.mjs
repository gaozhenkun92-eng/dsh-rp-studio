// 静态检查：带 hook 的组件只能通过 h(Comp, props) 渲染。
// 直接 Comp(props) 调用会把 hook 记到父组件头上，切换 section 时 hook 数量变化 → React 报错、整个视图被卸载。
import { readFile } from 'node:fs/promises'

const file = new URL('../lib/client.js', import.meta.url)
const src = await readFile(file, 'utf8')

function matchBrace(openIndex) {
  let depth = 0
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return src.length
}

const declRe = /function\s+([A-Z][\w$]*)\s*\(([^)]*)\)\s*\{/g
const hookNames = ['useState', 'useEffect', 'useMemo', 'useRef', 'useCallback']
const hookComponents = []
const offenders = []
let m
while ((m = declRe.exec(src))) {
  const name = m[1]
  const bodyEnd = matchBrace(m.index + m[0].length - 1)
  const body = src.slice(m.index, bodyEnd)
  if (!hookNames.some((h) => body.includes(h + '('))) continue
  hookComponents.push(name)
  const callRe = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g')
  let c
  while ((c = callRe.exec(src))) {
    if (c.index >= m.index && c.index <= bodyEnd) continue // 自身声明
    const before = src.slice(Math.max(0, c.index - 8), c.index)
    if (/h\(\s*$/.test(before)) continue // h(Comp, ...) 正常
    offenders.push({
      name,
      line: src.slice(0, c.index).split('\n').length,
      snippet: src.slice(c.index, c.index + 60).replace(/\s+/g, ' ')
    })
  }
}

console.log('hook components:', hookComponents.join(', ') || '(none)')
for (const o of offenders) console.log(`FAIL ${o.name} called directly at line ${o.line}: ${o.snippet}`)
console.log(offenders.length === 0 ? 'OK  no direct calls to hook components' : `${offenders.length} direct call(s)`)
process.exit(offenders.length === 0 ? 0 : 1)
