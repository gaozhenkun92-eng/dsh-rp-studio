# probe —— 自检脚本

这些脚本不需要桌面端、不需要浏览器、不需要装插件，直接 `node probe/<name>.mjs` 就能跑。
全部只读临时目录（`os.tmpdir()` 下的 `rp-studio-*`），跑完自己清掉，不碰你的 `$DSH_HOME`。

| 脚本 | 验什么 |
| --- | --- |
| `rp-core-check.mjs` | 卡片解析/导出（PNG 往返、JSON、纯文字）、数据层落盘、提示词预算裁剪、世界书命中、swipe 候选 |
| `rp-host-http.mjs` | 真起一个 http 服务，把 `/x-rp-studio/*` 全部路由打一遍（卡片 CRUD、导入导出、头像、世界书集合/导入导出、图库） |
| `rp-agent-check.mjs` | `lib/agent.js` 把 rp-studio 的数据拼成人格段：段名、order、宏展开、世界书、无卡兜底 |
| `rp-persona-global.mjs` | 人格段注册在部署层、总开关关着时返回空串、不覆盖宿主同名段 |
| `rp-prompt-order-check.mjs` | 段顺序单调、空标题不泄漏、重复段落去重、裁剪顺序 |
| `rp-gallery-check.mjs` | 图库三来源、显示名改名、`rp_gallery` 工具的 parameters / output.render / 筛选 |
| `rp-tools-check.mjs` | 权限门禁：默认全关不挂过滤器、白名单 allow、`allowOthers` 全放开、未知工具名降级重试、空 body 400 |
| `rp-studio-client-smoke.mjs` | 前端 bundle：注册项、顶栏开关 → 免责弹窗 → 两个勾选框的必勾/可选语义 → `PATCH /settings` → 关掉再开必须重新弹 |
| `rp-studio-ui-smoke.mjs` | 前端渲染：三栏布局、右栏六个菜单、角色设定四栏 + ⤢、世界书集合、图库、权限面板、弹窗文案 |
| `rp-studio-hooks-lint.mjs` | 静态检查：带 hook 的组件只能 `h(Comp, props)` 渲染，不许直接 `Comp(props)` 调用 |

一次跑全部：

```bash
node --version   # >= 22.19
npm test
```

或者手动：

```bash
for f in probe/*.mjs; do echo "== $f"; node "$f" || exit 1; done
```

`rp-tools-check.mjs` 结尾偶尔会打一句 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` ——
那是脚本 `server.close()` 与 `process.exit()` 抢跑的 libuv 竞态，`ALL OK` 已经打印过了，不是插件的问题。
