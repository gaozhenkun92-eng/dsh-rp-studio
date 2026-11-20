// dsh-rp-studio 客户端：顶栏「角色后台」页签 = 幕后控制台，标题是「<你的称呼>的伙伴」。
// 结构：顶部开关条 + 左（角色身份/头像/导入导出）+ 中（随右栏切换的内容）+ 右（分区菜单）
// 真正的对话仍在「对话」页签里进行，这里只负责角色卡与提示词的配置。
//
// 布局上的两条硬规矩（踩过的坑）：
//   · 视图根节点必须是「可收缩的弹性子项」：flex-basis 0 + min-height 0，
//     不设固定高度。否则会撑大自己、把下方输入框和别的插件按钮顶乱。
//   · 视图根节点加 contain: layout paint，任何时候都不许溢出自己的盒子。
window.__ModuleLoader__.load({
  id: 'dsh-rp-studio',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var STORAGE_KEY = 'dsh-rp-studio.enabled'
    var API = '/x-rp-studio'

    function api(path, options) {
      var init = Object.assign({ headers: { 'content-type': 'application/json' } }, options || {})
      var doFetch = (typeof window !== 'undefined' && window.fetch) || fetch
      return doFetch(API + path, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch (error) {
            data = { error: text }
          }
          if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
          return data
        })
      })
    }

    // 插件总开关的真身在 settings.json（宿主侧读它决定注不注人格、管不管工具），
    // localStorage 只当首帧占位，默认 false：装好之后必须先自己打开。
    function readEnabled() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function writeEnabled(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
      } catch (error) {
        /* 存不了就只本次生效 */
      }
    }

    // 记忆：上次停在哪个分区、每个设定框拖出来的高度。
    var SECTION_KEY = 'dsh-rp-studio.section'
    var HEIGHT_KEY = 'dsh-rp-studio.heights'

    function readSection() {
      try {
        return window.localStorage.getItem(SECTION_KEY) || 'card'
      } catch (error) {
        return 'card'
      }
    }

    function writeSection(value) {
      try {
        window.localStorage.setItem(SECTION_KEY, value)
      } catch (error) {
        /* 忽略 */
      }
    }

    function readHeights() {
      try {
        return JSON.parse(window.localStorage.getItem(HEIGHT_KEY) || '{}') || {}
      } catch (error) {
        return {}
      }
    }

    function writeHeight(key, px) {
      var all = readHeights()
      all[key] = Math.max(60, Math.round(px))
      try {
        window.localStorage.setItem(HEIGHT_KEY, JSON.stringify(all))
      } catch (error) {
        /* 忽略 */
      }
    }

    // 控制台自带深色底，不再依赖主题的次级文字色（之前字太淡就是这个原因）。
    var C = {
      text: 'var(--dsw-alias-label-primary, #f2f4f8)',
      dim: 'var(--dsw-alias-label-secondary, #b9c0cc)',
      faint: 'var(--dsw-alias-label-tertiary, #8b93a1)',
      line: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.16))',
      bg: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07))',
      panel: 'var(--dsw-alias-bg-base, #1b1e24)',
      panelSoft: 'var(--dsw-alias-bg-module-platform, #22262e)',
      accent: 'var(--dsw-alias-state-business-primary, #5b9bff)'
    }

    var panelStyle = {
      flex: '1 1 0%',
      minHeight: 0,
      minWidth: 0,
      width: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      contain: 'layout paint',
      position: 'relative',
      zIndex: 2,
      background: C.panel,
      color: C.text,
      fontSize: 13
    }

    var STYLE_ID = 'rp-studio-style'
    var STUDIO_CSS = [
      'div:has(> .rp-studio-root){padding:0 !important;border:0 !important;gap:0 !important;background:var(--dsw-alias-bg-base, #1b1e24) !important;}',
      'body:has(.rp-studio-root) [class*="widthHandle"]{pointer-events:none !important;opacity:0 !important;}',
      'body:has(.rp-studio-root) [class*="widthHandle"]:after{display:none !important;}',
      '.rp-studio-root{background:var(--dsw-alias-bg-base, #1b1e24);}',
      '.rp-studio-root *{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2, rgba(255,255,255,0.22)) transparent;}',
      '.rp-studio-root *::-webkit-scrollbar{width:10px;height:10px;}',
      '.rp-studio-root *::-webkit-scrollbar-track{background:transparent;}',
      '.rp-studio-root *::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2, rgba(255,255,255,0.18));border-radius:8px;border:2px solid transparent;background-clip:content-box;}',
      '.rp-studio-root *::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2, rgba(255,255,255,0.32));background-clip:content-box;}',
      '.rp-studio-root button{transition:background .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease;}',
      '.rp-studio-root button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08));}',
      '.rp-studio-root input,.rp-studio-root textarea{transition:border-color .15s ease,background .15s ease;}',
      '.rp-studio-root input:focus,.rp-studio-root textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary, #5b9bff) !important;}',
      '.rp-studio-root ::selection{background:var(--dsw-alias-state-business-primary, #5b9bff);opacity:.35;}'
    ].join('\n')

    function injectStyle() {
      try {
        var doc = window.document
        if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return
        var el = doc.createElement('style')
        el.id = STYLE_ID
        el.textContent = STUDIO_CSS
        doc.head.appendChild(el)
      } catch (err) {
        /* 注入失败不影响功能 */
      }
    }

    function Section(props) {
      return h(
        'div',
        {
          style: {
            flex: '1 1 0%',
            minHeight: 0,
            minWidth: 0,
            overflow: 'auto',
            padding: '12px 14px',
            boxSizing: 'border-box'
          }
        },
        props.children
      )
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'block', marginBottom: 10 } },
        h('div', { style: { color: C.dim, fontSize: 12, marginBottom: 4 } }, props.label),
        props.children
      )
    }

    var inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid ' + C.line,
      background: C.bg,
      color: C.text,
      fontSize: 13,
      outline: 'none'
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: props.disabled === true,
          style: Object.assign(
            {
              padding: '6px 12px',
              borderRadius: 7,
              border: '1px solid ' + (props.primary ? 'transparent' : C.line),
              background: props.primary ? C.accent : C.bg,
              color: props.primary ? '#fff' : C.text,
              cursor: props.disabled ? 'default' : 'pointer',
              opacity: props.disabled ? 0.55 : 1,
              fontSize: 12,
              fontWeight: props.primary ? 600 : 400,
              lineHeight: 1.3,
              whiteSpace: 'nowrap'
            },
            props.style || {}
          )
        },
        props.children
      )
    }

    function Tab(props) {
      var active = props.active === true
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            padding: '5px 10px',
            borderRadius: 999,
            border: '1px solid ' + (active ? C.accent : C.line),
            background: active ? 'rgba(91,155,255,0.16)' : 'transparent',
            color: active ? '#dce8ff' : C.dim,
            cursor: 'pointer',
            fontSize: 12
          }
        },
        props.children
      )
    }

    function Switch(props) {
      var on = props.checked === true
      var disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-disabled': disabled,
          disabled: disabled,
          onClick: function () {
            if (disabled) return
            props.onChange(!on)
          },
          style: {
            width: 40,
            height: 22,
            borderRadius: 11,
            border: '1px solid ' + C.line,
            background: on ? C.accent : 'rgba(127,127,127,0.25)',
            position: 'relative',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            padding: 0,
            flex: '0 0 auto'
          }
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: on ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff'
          }
        })
      )
    }

    // ---------- 数据 ------------------------------------------------------
    function useStudio() {
      var cards = useState([])
      var activeId = useState(null)
      var card = useState(null)
      var editorText = useState('')
      var settings = useState(null)
      var preview = useState(null)
      var error = useState('')
      var busy = useState(false)

      var state = {
        cards: cards[0],
        setCards: cards[1],
        activeId: activeId[0],
        setActiveId: activeId[1],
        card: card[0],
        setCard: card[1],
        editorText: editorText[0],
        setEditorText: editorText[1],
        settings: settings[0],
        setSettings: settings[1],
        preview: preview[0],
        setPreview: preview[1],
        error: error[0],
        setError: error[1],
        busy: busy[0],
        setBusy: busy[1]
      }

      state.reloadCards = function () {
        return api('/cards')
          .then(function (data) {
            var list = data.cards || []
            state.setCards(list)
            if (!state.activeId && list.length > 0) state.setActiveId(list[0].id)
            return list
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
            return []
          })
      }

      useEffect(function () {
        // 先读「当前绑定的卡」，再列卡：这样刷新后高亮的就是对话真正在用的那张
        api('/active')
          .then(function (data) {
            var bound = (data && data.cardId) || ''
            return state.reloadCards().then(function (list) {
              if (bound && list.some(function (item) { return item.id === bound })) {
                state.setActiveId(bound)
              }
              return list
            })
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
            return state.reloadCards()
          })
        api('/settings')
          .then(function (data) {
            state.setSettings(data.settings || null)
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }, [])

      useEffect(
        function () {
          if (!state.activeId) {
            state.setCard(null)
            state.setEditorText('')
            return
          }
          api('/cards/' + encodeURIComponent(state.activeId))
            .then(function (data) {
              state.setCard(data.card || null)
              state.setEditorText(data.editorText || '')
              state.setPreview(null)
            })
            .catch(function (err) {
              state.setError(String((err && err.message) || err))
            })
        },
        [state.activeId]
      )

      // 选中哪张卡 = 对话里绑哪张卡。写进 active.json，会话引擎每轮读它。
      useEffect(
        function () {
          if (!state.activeId) return
          api('/active', { method: 'POST', body: JSON.stringify({ cardId: state.activeId }) })
            .catch(function (err) {
              state.setError(String((err && err.message) || err))
            })
        },
        [state.activeId]
      )

      return state
    }

    function loadPreview(state, cardId) {
      api('/prompt/preview', { method: 'POST', body: JSON.stringify({ cardId: cardId, text: '' }) })
        .then(function (data) {
          state.setPreview(data)
        })
        .catch(function (err) {
          state.setError(String((err && err.message) || err))
        })
    }

    // ---------- 分区 ------------------------------------------------------
    // 角色设定：四个固定框 + 用户自建的框。每个框高度可拖、拖完记住。
    var CARD_FIELDS = [
      ['description', '人设', '她是谁、怎么看待世界、怎么看待庶民……'],
      ['scenario', '背景故事', '她从哪里来、现在处在什么处境……'],
      ['personality', '说话风格', '语气、口癖、句子长短、什么时候娇什么时候凶……'],
      ['postHistoryInstructions', '特殊内容', '每次回复都必须遵守的东西，放在最后……']
    ]

    function AutoTextarea(props) {
      var key = props.memoryKey || 'field'
      var heights = readHeights()
      var height = heights[key] || props.defaultHeight || 120
      return h('textarea', {
        value: props.value || '',
        spellCheck: false,
        onChange: function (event) {
          props.onChange(event.target.value)
        },
        onMouseUp: function (event) {
          writeHeight(key, event.target.offsetHeight)
        },
        onBlur: function () {
          if (props.onCommit) props.onCommit()
        },
        style: Object.assign({}, inputStyle, {
          height: height,
          minHeight: 60,
          resize: 'vertical',
          fontFamily: 'inherit',
          lineHeight: 1.6
        })
      })
    }

    // 输入即记忆：同一字段的连续输入合并成一次 PATCH。
    var saveTimers = {}
    function scheduleSave(state, key, value) {
      var id = state.activeId
      if (!id) return
      var slot = id + ':' + key
      if (saveTimers[slot]) clearTimeout(saveTimers[slot])
      saveTimers[slot] = setTimeout(function () {
        delete saveTimers[slot]
        var patch = {}
        patch[key] = value
        api('/cards/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify({ fields: patch })
        })
          .then(function () {
            state.setError('')
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }, 400)
    }

    // 设定框标题栏：名字 + 展开到整块中间区域的按钮。
    function FieldHead(props) {
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }
      },
        h('div', { style: { color: C.dim, fontSize: 12 } }, props.label),
        h('div', { style: { flex: '1 1 auto' } }),
        h('button', {
          type: 'button',
          title: props.expanded ? '收起' : '展开到整块区域',
          onClick: props.onToggle,
          style: {
            border: '1px solid ' + C.line,
            background: C.bg,
            color: C.dim,
            borderRadius: 6,
            padding: '1px 8px',
            fontSize: 11,
            cursor: 'pointer'
          }
        }, props.expanded ? '收起' : '⤢'))
    }

    function CardEditor(props) {
      var state = props.state
      var card = state.card
      var expandState = useState('')
      var expanded = expandState[0]
      var setExpanded = expandState[1]
      var dialogState = useState(false)
      var dialogOpen = dialogState[0]
      var setDialogOpen = dialogState[1]
      var draftState = useState('')
      var draftName = draftState[0]
      var setDraftName = draftState[1]

      if (!card) {
        // 只有确实没有选中卡时才出这句：选中之后整块提示消失
        return h(Section, null, h('div', { style: { color: C.dim, fontSize: 12 } },
          '左边还没有选中角色卡。到「切换角色」里选一张，或者创建一个。'))
      }

      function localField(key, value) {
        state.setCard(Object.assign({}, card, { [key]: value }))
        scheduleSave(state, key, value)
      }

      var customs = card.customSections || []

      function saveCustoms(next) {
        state.setCard(Object.assign({}, card, { customSections: next }))
        scheduleSave(state, 'customSections', next)
      }

      function addCustom() {
        var name = String(draftName || '').trim()
        if (!name) return
        var next = customs.concat([{ id: 'c' + Date.now().toString(36), name: name, content: '' }])
        setDraftName('')
        setDialogOpen(false)
        saveCustoms(next)
      }

      var dialog = dialogOpen
        ? h('div', {
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50
          },
          onClick: function () { setDialogOpen(false) }
        },
          h('div', {
            onClick: function (e) { e.stopPropagation() },
            style: {
              width: 320,
              background: C.panel,
              border: '1px solid ' + C.line,
              borderRadius: 10,
              padding: 16,
              boxSizing: 'border-box'
            }
          },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '新框的名字'),
            h('input', {
              autoFocus: true,
              style: inputStyle,
              value: draftName,
              onChange: function (e) { setDraftName(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') addCustom() }
            }),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } },
              h(Button, { onClick: function () { setDialogOpen(false) } }, '取消'),
              h(Button, { primary: true, onClick: addCustom }, '确定'))))
        : null

      if (expanded) {
        var row = null
        for (var i = 0; i < CARD_FIELDS.length; i += 1) {
          if (CARD_FIELDS[i][0] === expanded) row = CARD_FIELDS[i]
        }
        var custom = null
        for (var j = 0; j < customs.length; j += 1) {
          if ('custom:' + customs[j].id === expanded) custom = customs[j]
        }
        var title = row ? row[1] : custom ? (custom.name || '自定义') : expanded
        return h(Section, null,
          h(FieldHead, {
            label: title,
            expanded: true,
            onToggle: function () { setExpanded('') }
          }),
          h('textarea', {
            value: row ? (card[row[0]] || '') : (custom ? custom.content || '' : ''),
            spellCheck: false,
            onChange: function (event) {
              var value = event.target.value
              if (row) localField(row[0], value)
              else if (custom) {
                saveCustoms(customs.map(function (x) {
                  return x.id === custom.id ? Object.assign({}, x, { content: value }) : x
                }))
              }
            },
            style: Object.assign({}, inputStyle, {
              height: 'calc(100% - 44px)',
              minHeight: 300,
              resize: 'vertical',
              fontFamily: 'inherit',
              lineHeight: 1.6
            })
          }),
          dialog)
      }

      return h(
        Section,
        null,
        h('div', { style: { color: C.faint, fontSize: 11, marginBottom: 10, lineHeight: 1.6 } },
          '边打边存，不用按保存；每个框都能往下拖高或点 ⤢ 铺满整块区域，高度会记住。'),
        CARD_FIELDS.map(function (item) {
          var key = item[0]
          return h('div', { key: key, style: { marginBottom: 12 } },
            h(FieldHead, {
              label: item[1],
              expanded: false,
              onToggle: function () { setExpanded(key) }
            }),
            h(AutoTextarea, {
              memoryKey: key,
              value: card[key] || '',
              defaultHeight: 120,
              onChange: function (value) { localField(key, value) }
            }))
        }),
        customs.map(function (item) {
          return h('div', {
            key: item.id,
            style: {
              border: '1px solid ' + C.line,
              borderRadius: 8,
              padding: 10,
              marginBottom: 10,
              background: C.panelSoft
            }
          },
            h(FieldHead, {
              label: item.name || '自定义',
              expanded: false,
              onToggle: function () { setExpanded('custom:' + item.id) }
            }),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
              h('div', { style: { flex: '1 1 auto' } }),
              h(Button, {
                onClick: function () {
                  saveCustoms(customs.filter(function (x) { return x.id !== item.id }))
                }
              }, '删除')),
            h(AutoTextarea, {
              memoryKey: 'custom:' + item.id,
              value: item.content || '',
              defaultHeight: 100,
              onChange: function (value) {
                saveCustoms(customs.map(function (x) {
                  return x.id === item.id ? Object.assign({}, x, { content: value }) : x
                }))
              }
            }))
        }),
        h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 6 } },
          h(Button, { primary: true, onClick: function () { setDialogOpen(true) } }, '自定义')),
        dialog
      )
    }

    // 世界书：全局 / 本卡两个作用域，每个作用域里有若干「大集合」（分类），
    // 集合可以整体开关，条目可以单独开关、单独编辑.
    function WorldbookPanel(props) {
      var state = props.state
      var dataState = useState({ global: [], card: [], groups: { global: [], card: [] } })
      var data = dataState[0]
      var setData = dataState[1]
      var scopeState = useState('card')
      var scope = scopeState[0]
      var setScope = scopeState[1]
      var collapsedState = useState({})
      var collapsed = collapsedState[0]
      var setCollapsed = collapsedState[1]
      var formState = useState(null)
      var form = formState[0]
      var setForm = formState[1]
      var groupDialogState = useState(null)
      var groupDialog = groupDialogState[0]
      var setGroupDialog = groupDialogState[1]

      function absorb(res) {
        setData({
          global: (res && res.global) || [],
          card: (res && res.card) || [],
          groups: {
            global: (res && res.groups && res.groups.global) || [],
            card: (res && res.groups && res.groups.card) || []
          }
        })
      }

      function refresh() {
        if (!state.activeId) {
          absorb(null)
          return
        }
        api('/worldbook?cardId=' + encodeURIComponent(state.activeId))
          .then(absorb)
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      useEffect(refresh, [state.activeId])

      var entries = scope === 'global' ? data.global : data.card
      var groupNames = (scope === 'global' ? data.groups.global : data.groups.card) || []

      function post(path, body) {
        return api(path, { method: 'POST', body: JSON.stringify(body) })
          .then(function (res) {
            state.setError('')
            absorb(res)
            return res
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
            return null
          })
      }

      function emptyForm(group) {
        return { id: '', group: group || '', name: '', keys: '', content: '', priority: 5, always: false }
      }

      function openCreate(group) {
        setForm(emptyForm(group))
      }

      function openEdit(entry) {
        setForm({
          id: entry.id,
          group: entry.group || '',
          name: entry.name,
          keys: (entry.keys || []).join(', '),
          content: entry.content,
          priority: entry.priority,
          always: entry.always === true
        })
      }

      function saveForm() {
        if (!form) return
        if (!String(form.content || '').trim()) {
          state.setError('内容不能为空')
          return
        }
        var entry = {
          name: form.name || String(form.keys || '').split(/[,，]/)[0] || '未命名条目',
          group: form.group || '',
          keys: form.keys,
          content: form.content,
          priority: Number(form.priority) || 5,
          always: form.always === true
        }
        var request = form.id
          ? post('/worldbook/update', { scope: scope, cardId: state.activeId, id: form.id, entry: entry })
          : post('/worldbook', { scope: scope, cardId: state.activeId, entry: entry })
        request.then(function (res) {
          if (res) setForm(null)
        })
      }

      function remove(entry) {
        post('/worldbook/delete', { scope: scope, cardId: state.activeId, id: entry.id })
      }

      function toggleEntry(entry, enabled) {
        post('/worldbook/toggle', { scope: scope, cardId: state.activeId, id: entry.id, enabled: enabled })
      }

      function toggleGroup(name, enabled) {
        post('/worldbook/group/toggle', { scope: scope, cardId: state.activeId, name: name, enabled: enabled })
      }

      function submitGroupDialog() {
        if (!groupDialog) return
        var name = String(groupDialog.name || '').trim()
        if (!name) {
          state.setError('集合要有个名字')
          return
        }
        var request = groupDialog.mode === 'rename'
          ? post('/worldbook/group/rename', { scope: scope, cardId: state.activeId, from: groupDialog.from, to: name })
          : post('/worldbook/group', { scope: scope, cardId: state.activeId, name: name })
        request.then(function (res) {
          if (res) setGroupDialog(null)
        })
      }

      function deleteGroup(name) {
        var count = entries.filter(function (e) { return (e.group || '') === name }).length
        var ok = window.confirm('删除集合「' + name + '」以及里面的 ' + count + ' 条条目？')
        if (!ok) return
        post('/worldbook/group/delete', { scope: scope, cardId: state.activeId, name: name })
      }

      function downloadJson(name, value) {
        try {
          var text = JSON.stringify(value, null, 2)
          var blob = new window.Blob([text], { type: 'application/json' })
          var href = window.URL.createObjectURL(blob)
          var link = window.document.createElement('a')
          link.href = href
          link.download = name
          window.document.body.appendChild(link)
          link.click()
          window.document.body.removeChild(link)
          window.URL.revokeObjectURL(href)
        } catch (err) {
          state.setError(String((err && err.message) || err))
        }
      }

      function exportWorldbook() {
        var query = '/worldbook/export?scope=' + scope + '&cardId=' + encodeURIComponent(state.activeId || '')
        api(query)
          .then(function (payload) {
            var stamp = new Date().toISOString().slice(0, 10)
            downloadJson('worldbook-' + scope + '-' + stamp + '.json', payload)
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      function importWorldbook(file) {
        if (!file) return
        file
          .text()
          .then(function (text) {
            return post('/worldbook/import', { scope: scope, cardId: state.activeId, text: text })
          })
      }

      function isCollapsed(name) {
        return collapsed[scope + ':' + name] === true
      }

      function toggleCollapsed(name) {
        var key = scope + ':' + name
        var next = Object.assign({}, collapsed)
        next[key] = !isCollapsed(name)
        setCollapsed(next)
      }

      function entryRow(entry) {
        var editing = form && form.id === entry.id
        if (editing) {
          return h('div', { key: entry.id, style: { marginBottom: 8 } }, entryForm(true))
        }
        return h(
          'div',
          {
            key: entry.id,
            style: {
              border: '1px solid ' + C.line,
              borderRadius: 8,
              padding: '8px 10px',
              marginBottom: 6,
              background: C.bg,
              opacity: entry.enabled === false ? 0.55 : 1
            }
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(Switch, { checked: entry.enabled !== false, onChange: function (next) { toggleEntry(entry, next) } }),
            h('div', { style: { fontWeight: 600, fontSize: 13, color: C.text } }, entry.name),
            h('div', { style: { color: C.dim, fontSize: 12 } }, '权重 ' + entry.priority + (entry.always ? ' · 恒定' : '')),
            h('div', { style: { flex: '1 1 auto' } }),
            h(Button, { onClick: function () { openEdit(entry) } }, '编辑'),
            h(Button, { onClick: function () { remove(entry) } }, '删除')),
          (entry.keys || []).length > 0
            ? h('div', { style: { color: C.dim, fontSize: 12, marginTop: 4 } }, '关键词：' + entry.keys.join(' / '))
            : null,
          h('div', {
            style: { color: C.text, fontSize: 12, marginTop: 6, lineHeight: 1.6, maxHeight: 96, overflow: 'hidden' }
          }, entry.content)
        )
      }

      function entryForm(compact) {
        if (!form) return null
        return h('div', {
          style: {
            border: '1px solid ' + C.accent,
            borderRadius: 8,
            padding: 10,
            marginBottom: compact ? 0 : 12,
            background: C.panelSoft,
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }
        },
          h('input', {
            style: inputStyle,
            value: form.name,
            onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })) }
          }),
          h('input', {
            style: inputStyle,
            value: form.keys,
            onChange: function (e) { setForm(Object.assign({}, form, { keys: e.target.value })) }
          }),
          h('textarea', {
            style: Object.assign({}, inputStyle, { minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }),
            value: form.content,
            onChange: function (e) { setForm(Object.assign({}, form, { content: e.target.value })) }
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: Object.assign({}, inputStyle, { width: 80 }),
              type: 'number',
              value: form.priority,
              onChange: function (e) { setForm(Object.assign({}, form, { priority: e.target.value })) }
            }),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, color: C.dim, fontSize: 12 } },
              h('input', {
                type: 'checkbox',
                checked: form.always === true,
                onChange: function (e) { setForm(Object.assign({}, form, { always: e.target.checked })) }
              }),
              '恒定生效'),
            h('select', {
              style: Object.assign({}, inputStyle, { width: 150 }),
              value: form.group || '',
              onChange: function (e) { setForm(Object.assign({}, form, { group: e.target.value })) }
            },
              h('option', { value: '' }, '未归类'),
              groupNames.map(function (name) { return h('option', { key: name, value: name }, name) })),
            h('div', { style: { flex: '1 1 auto' } }),
            h(Button, { onClick: function () { setForm(null) } }, '取消'),
            h(Button, { primary: true, onClick: saveForm }, form.id ? '保存' : '添加')))
      }

      function groupBlock(name, list) {
        var collapsedNow = isCollapsed(name)
        var live = list.filter(function (e) { return e.enabled !== false }).length
        var on = list.length === 0 ? true : live > 0
        return h('div', {
          key: 'g:' + (name || '__none__'),
          style: { border: '1px solid ' + C.line, borderRadius: 9, marginBottom: 10, background: C.panelSoft }
        },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderBottom: collapsedNow ? 'none' : '1px solid ' + C.line
            }
          },
            h('button', {
              type: 'button',
              onClick: function () { toggleCollapsed(name) },
              style: {
                width: 20,
                height: 20,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: C.dim,
                cursor: 'pointer',
                fontSize: 12
              }
            }, collapsedNow ? '▸' : '▾'),
            h('div', { style: { fontWeight: 600, fontSize: 13, color: C.text } }, name || '未归类'),
            h('div', { style: { color: C.dim, fontSize: 12 } }, list.length + ' 条 · 生效 ' + live),
            h('div', { style: { flex: '1 1 auto' } }),
            name
              ? h(Switch, { checked: on, onChange: function (next) { toggleGroup(name, next) } })
              : null,
            h(Button, { onClick: function () { openCreate(name) } }, '+ 条目'),
            name ? h(Button, {
              onClick: function () { setGroupDialog({ mode: 'rename', from: name, name: name }) }
            }, '改名') : null,
            name ? h(Button, { onClick: function () { deleteGroup(name) } }, '删除') : null),
          collapsedNow
            ? null
            : h('div', { style: { padding: 10 } },
                list.length === 0
                  ? h('div', { style: { color: C.dim, fontSize: 12 } }, '这个集合还没有条目。')
                  : list.map(entryRow))
        )
      }

      if (!state.activeId && scope === 'card') {
        return h(Section, null,
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
            h(Tab, { active: false, onClick: function () { setScope('global') } }, '全局条目 ' + data.global.length)),
          h('div', { style: { color: C.dim, fontSize: 12 } }, '先选一张角色卡，才能挂本卡的世界书（全局条目随时可编辑）。'))
      }

      var unordered = entries.filter(function (e) { return !e.group })
      var blocks = []
      groupNames.forEach(function (name) {
        blocks.push(groupBlock(name, entries.filter(function (e) { return e.group === name })))
      })
      if (unordered.length > 0 || groupNames.length === 0) {
        blocks.push(groupBlock('', unordered))
      }

      return h(
        Section,
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h(Tab, { active: scope === 'card', onClick: function () { setScope('card') } }, '本卡 ' + data.card.length),
          h(Tab, { active: scope === 'global', onClick: function () { setScope('global') } }, '全局 ' + data.global.length),
          h('div', { style: { flex: '1 1 auto' } }),
          h(Button, {
            primary: true,
            onClick: function () { setGroupDialog({ mode: 'new', from: '', name: '' }) }
          }, '+ 新建集合'),
          h(Button, { onClick: function () { exportWorldbook() } }, '导出'),
          h(Button, {
            onClick: function () {
              var input = window.document.getElementById('rp-studio-worldbook-input')
              if (input) input.click()
            }
          }, '导入'),
          h(Button, { onClick: function () { openCreate('') } }, '+ 条目')),
        h('input', {
          id: 'rp-studio-worldbook-input',
          type: 'file',
          accept: '.json,.txt,application/json,text/plain',
          style: { display: 'none' },
          onChange: function (event) {
            var file = event.target.files && event.target.files[0]
            event.target.value = ''
            importWorldbook(file)
          }
        }),
        h('div', { style: { color: C.dim, fontSize: 12, lineHeight: 1.6, marginBottom: 8 } },
          scope === 'global' ? '全局条目对所有角色卡生效。' : '本卡条目只在当前角色卡下生效，与全局条目合并使用。'),
        form && !form.id ? entryForm(false) : null,
        blocks.length === 0
          ? h('div', { style: { color: C.dim, fontSize: 12, padding: '12px 0' } }, '这一栏还没有条目。')
          : blocks,
        groupDialog
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.55)',
                zIndex: 60,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }
            },
              h('div', {
                style: {
                  width: 320,
                  background: C.panel,
                  border: '1px solid ' + C.line,
                  borderRadius: 10,
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }
              },
                h('div', { style: { fontWeight: 600, fontSize: 13, color: C.text } },
                  groupDialog.mode === 'rename' ? '集合改名' : '新集合的名字'),
                h('input', {
                  style: inputStyle,
                  autoFocus: true,
                  value: groupDialog.name,
                  onChange: function (e) { setGroupDialog(Object.assign({}, groupDialog, { name: e.target.value })) },
                  onKeyDown: function (e) {
                    if (e.key === 'Enter') submitGroupDialog()
                    if (e.key === 'Escape') setGroupDialog(null)
                  }
                }),
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                  h(Button, { onClick: function () { setGroupDialog(null) } }, '取消'),
                  h(Button, { primary: true, onClick: submitGroupDialog }, '确定'))))
          : null
      )
    }

    function UserPanel(props) {
      var state = props.state
      var s = state.settings
      if (!s) return h(Section, null, h('div', { style: { color: C.dim } }, '读取设置中…'))
      function patch(key, value) {
        var next = Object.assign({}, s, {})
        next[key] = value
        state.setSettings(next)
        api('/settings', { method: 'PATCH', body: JSON.stringify({ [key]: value }) }).catch(function (err) {
          state.setError(String((err && err.message) || err))
        })
      }
      return h(
        Section,
        null,
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '你自己是谁'),
        h(Field, { label: '你的称呼' },
          h('input', { style: inputStyle, value: s.userName || '', onChange: function (e) { patch('userName', e.target.value) } })),
        h(Field, { label: '你的人设' },
          h('textarea', {
            style: Object.assign({}, inputStyle, { minHeight: 120, resize: 'vertical', fontFamily: 'inherit' }),
            value: s.userPersona || '',
            onChange: function (e) { patch('userPersona', e.target.value) }
          }))
      )
    }

    // 权限设置：五组工具的真开关。
    var TOOL_ROWS = [
      ['fs', '文件读写', 'read / write / edit / read_image / glob / grep'],
      ['shell', '命令行', 'pwsh（Windows）/ bash / job_list / job_output / job_kill'],
      ['web', '联网', 'web_search / web_fetch'],
      ['subagent', '子智能体', 'subagent / subagent_fork / send_message / list_agents / interrupt_agent / workflow'],
      ['skill', '技能与交付', 'skill / present / todo_write / create_goal / get_goal / update_goal'],
      ['gallery', '图库', 'rp_gallery · 只看得到图片名字与来源，读不到图片内容']
    ]

    // 每一组「打开之后角色究竟能干什么、风险在哪」——这是给用户看的明细。
    var TOOL_DETAIL = {
      fs: '能读你工作区里的文件、改文件、写新文件。风险：角色的设定里如果写着"要整理房间/翻抽屉"，它可能真的去翻目录。',
      shell: '能在你的电脑上执行命令，安装东西、跑脚本、删文件都算在里面。风险最高的一组，除非确实需要，否则别开。',
      web: '能上网搜东西、抓网页。风险：会把搜索结果当成"世界知识"塞进对话，也可能把对话里的内容发到外部网站。',
      subagent: '能派生下游 agent 并行干活，那些子 agent 也会带工具。风险：一次动作变成多次动作，你更难盯住。',
      skill: '能加载技能、往界面上塞交付物、建待办与目标。风险较低，但会把长任务挂到你的会话上。',
      gallery: '只能读图库清单（显示名、文件名、来源目录），拿不到图片字节。风险最低，适合让角色"记得自己有哪些图"。'
    }

    function SanitizePanel(props) {
      var state = props.state
      var s = state.settings
      if (!s) return h(Section, null, h('div', { style: { color: C.dim } }, '读取设置中…'))
      var groups = s.toolGroups || {}
      var enabled = s.enabled !== false
      var denyOthers = s.denyOthers === true

      function postTools(body, nextSettings) {
        state.setSettings(nextSettings)
        api('/tools', { method: 'POST', body: JSON.stringify(body) }).catch(function (err) {
          state.setError(String((err && err.message) || err))
        })
      }

      function toggleGroup(key, value) {
        var nextGroups = Object.assign({}, groups)
        nextGroups[key] = value
        postTools({ toolGroups: { [key]: value } }, Object.assign({}, s, { toolGroups: nextGroups }))
      }

      function toggleDenyOthers(value) {
        postTools({ denyOthers: value }, Object.assign({}, s, { denyOthers: value }))
      }

      function toggleEnabled(value) {
        postTools({ enabled: value }, Object.assign({}, s, { enabled: value }))
      }

      return h(
        Section,
        null,
        // 总开关
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            marginBottom: 10,
            border: '1px solid ' + (enabled ? C.accent : C.line),
            borderRadius: 8,
            background: C.panelSoft
          }
        },
          h('div', { style: { flex: '1 1 auto' } },
            h('div', { style: { color: C.text, fontSize: 13, fontWeight: 600 } }, '启用角色扮演'),
            h('div', { style: { color: C.dim, fontSize: 11.5, marginTop: 3 } },
              enabled ? '人格段已注入，下面的工具开关开始生效。' : '关闭状态：不注人格、不改工具面，会话和没装这个插件一样。')),
          h(Switch, { checked: enabled, onChange: toggleEnabled })),

        // 六组工具
        h('div', {
          style: {
            border: '1px solid ' + C.line,
            borderRadius: 8,
            overflow: 'hidden',
            background: C.panelSoft
          }
        }, TOOL_ROWS.map(function (row, index) {
          var key = row[0]
          var on = groups[key] === true
          return h('div', {
            key: key,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 10px',
              borderTop: index === 0 ? 'none' : '1px solid ' + C.line,
              fontSize: 12,
              opacity: enabled ? 1 : 0.55
            }
          },
            h('div', { style: { width: 78, color: C.text, flex: '0 0 auto' } }, row[1]),
            h('div', { style: { color: C.dim, flex: '1 1 auto', wordBreak: 'break-word' } }, row[2]),
            h(Switch, { checked: on, disabled: !enabled, onChange: function (value) { toggleGroup(key, value) } }))
        })),

        // 白名单
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            marginTop: 10,
            border: '1px solid ' + (denyOthers ? C.accent : C.line),
            borderRadius: 8,
            background: C.panelSoft,
            opacity: enabled ? 1 : 0.55
          }
        },
          h('div', { style: { flex: '1 1 auto' } },
            h('div', { style: { color: C.text, fontSize: 13 } }, '禁止以上之外的其他权限'),
            h('div', { style: { color: C.dim, fontSize: 11.5, marginTop: 3 } },
              '打开后改成白名单：只有上面勾选的组能用，其余工具（包括以后新加的）一律拒绝。')),
          h(Switch, { checked: denyOthers, disabled: !enabled, onChange: toggleDenyOthers })),

        // 说明
        h('div', {
          style: {
            marginTop: 12,
            padding: '10px 12px',
            border: '1px solid ' + C.line,
            borderRadius: 8,
            background: C.bg
          }
        },
          h('div', { style: { color: C.text, fontSize: 12.5, fontWeight: 600, marginBottom: 6 } }, 'AI 权限细致范围'),
          h('div', { style: { color: C.dim, fontSize: 11.5, lineHeight: 1.75, marginBottom: 8 } },
            '角色跑的是正常 DSH 会话，工具清单来自会话预设，不来自角色卡。上面六组是插件在运行时按 agent 逐个挂 deny / allow 过滤器实现的（agent.ctx.tools.restrict），所以改完立刻对活着的会话生效，不用重启。具体每一组：'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
            TOOL_ROWS.map(function (row) {
              var key = row[0]
              var on = groups[key] === true
              return h('div', { key: 'd' + key, style: { display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.7 } },
                h('div', {
                  style: {
                    width: 78,
                    flex: '0 0 auto',
                    color: on ? C.accent : C.faint,
                    fontWeight: on ? 600 : 400
                  }
                }, row[1] + (on ? ' · 已开' : ' · 关')),
                h('div', { style: { color: C.dim, flex: '1 1 auto' } },
                  h('div', { style: { color: C.text } }, row[2]),
                  h('div', null, TOOL_DETAIL[key])))
            })),
          h('div', { style: { color: C.faint, fontSize: 11, marginTop: 10, lineHeight: 1.7 } },
            '没列在这里的工具（例如插件自己注册的、宿主以后新增的）在 denyOthers 打开时会被一并拒掉；关着的时候只挡住上面被关掉的组，其余保持会话预设的原样。'))
      )
    }

    function GalleryPanel(props) {
      var state = props.state
      var listState = useState([])
      var images = listState[0]
      var setImages = listState[1]
      var selState = useState(null)
      var selected = selState[0]
      var setSelected = selState[1]
      var tick = useState(0)
      var setTick = tick[1]
      var renameState = useState(false)
      var renameOpen = renameState[0]
      var setRenameOpen = renameState[1]
      var renameDraftState = useState('')
      var renameDraft = renameDraftState[0]
      var setRenameDraft = renameDraftState[1]

      function refresh() {
        api('/gallery')
          .then(function (data) {
            setImages(data.images || [])
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      useEffect(function () {
        refresh()
      }, [])

      function upload(file) {
        if (!file) return
        var reader = new window.FileReader()
        reader.onload = function () {
          var result = String(reader.result || '')
          var comma = result.indexOf(',')
          api('/gallery', {
            method: 'POST',
            body: JSON.stringify({ base64: comma >= 0 ? result.slice(comma + 1) : result, name: file.name })
          })
            .then(function () {
              setTick(tick[0] + 1)
              refresh()
            })
            .catch(function (err) {
              state.setError(String((err && err.message) || err))
            })
        }
        reader.readAsDataURL(file)
      }

      function setAsAvatar(image) {
        if (!state.activeId) return
        api(image.path, {
          method: 'POST',
          body: JSON.stringify({ cardId: state.activeId })
        })
          .then(function () {
            state.reloadCards()
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      function remove(image) {
        api(image.path, { method: 'DELETE' })
          .then(function () {
            if (selected && selected.id === image.id) setSelected(null)
            refresh()
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      function keep(image) {
        api(image.path + '/import', { method: 'POST' })
          .then(function () {
            refresh()
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      function openRename(image) {
        setRenameDraft(image ? image.name : '')
        setRenameOpen(true)
      }

      function submitRename() {
        if (!selected) {
          setRenameOpen(false)
          return
        }
        var target = selected
        var value = renameDraft
        setRenameOpen(false)
        api(target.path + '/rename', {
          method: 'POST',
          body: JSON.stringify({ name: value })
        })
          .then(function (data) {
            setImages(function (prev) {
              return prev.map(function (image) {
                return image.id === target.id ? Object.assign({}, image, { name: data.name }) : image
              })
            })
            setSelected(Object.assign({}, target, { name: data.name }))
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      return h(
        Section,
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h(Button, {
            primary: true,
            onClick: function () {
              var input = window.document.getElementById('rp-studio-gallery-input')
              if (input) input.click()
            }
          }, '上传图片'),
          h('div', { style: { color: C.dim, fontSize: 12 } }, images.length + ' 张')
        ),
        h('input', {
          id: 'rp-studio-gallery-input',
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          style: { display: 'none' },
          onChange: function (event) {
            upload(event.target.files && event.target.files[0])
            event.target.value = ''
          }
        }),
        selected
          ? h('div', { style: { marginBottom: 10 } },
              h('img', {
                src: API + selected.path + '?t=' + tick[0],
                alt: '',
                style: {
                  width: '100%',
                  maxHeight: 260,
                  objectFit: 'contain',
                  background: C.panelSoft,
                  borderRadius: 8,
                  border: '1px solid ' + C.line
                }
              }),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('div', { style: { color: C.text, fontSize: 12.5, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  selected.name,
                  selected.source === 'roleplay'
                    ? h('span', { style: { color: C.accent, marginLeft: 6, fontSize: 11 } }, '· 角色扮演生成')
                    : null),
                h(Button, { onClick: function () { openRename(selected) } }, '改名'),
                h(Button, { disabled: !state.activeId, onClick: function () { setAsAvatar(selected) } }, '设为头像'),
                selected.source === 'roleplay'
                  ? h(Button, { onClick: function () { keep(selected) } }, '收藏到图库')
                  : null,
                selected.source === 'roleplay'
                  ? null
                  : h(Button, { onClick: function () { remove(selected) } }, '删除')))
          : null,
        images.length === 0
          ? h('div', { style: { color: C.dim, fontSize: 12 } }, '图库还是空的，点「上传图片」放几张进来。')
          : h('div', {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 10
              }
            },
              images.map(function (image) {
                var active = selected && selected.id === image.id
                return h('div', {
                  key: image.id,
                  onClick: function () {
                    setSelected(image)
                  },
                  title: image.fileName,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 10,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    border: '1px solid ' + (active ? C.accent : C.line),
                    background: C.panelSoft
                  }
                },
                  h('div', {
                    style: {
                      width: '100%',
                      aspectRatio: '1 / 1',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: C.panel,
                      overflow: 'hidden'
                    }
                  },
                    h('img', {
                      src: API + image.path,
                      alt: '',
                      style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' }
                    })),
                  h('div', {
                    style: {
                      padding: '6px 8px',
                      fontSize: 11.5,
                      color: active ? C.text : C.dim,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      borderTop: '1px solid ' + C.line
                    }
                  }, image.name))
              })
            ),
        renameOpen
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.55)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 60
              },
              onClick: function () { setRenameOpen(false) }
            },
              h('div', {
                style: {
                  width: 320,
                  background: C.panel,
                  border: '1px solid ' + C.line,
                  borderRadius: 12,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                },
                onClick: function (event) { event.stopPropagation() }
              },
                h('div', { style: { fontSize: 13, fontWeight: 600, color: C.text } }, '图片的新名字'),
                h('input', {
                  value: renameDraft,
                  autoFocus: true,
                  onChange: function (event) { setRenameDraft(event.target.value) },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') submitRename()
                    if (event.key === 'Escape') setRenameOpen(false)
                  },
                  style: {
                    background: C.bg,
                    border: '1px solid ' + C.line,
                    borderRadius: 8,
                    padding: '7px 9px',
                    color: C.text,
                    fontSize: 12.5,
                    outline: 'none',
                    boxSizing: 'border-box',
                    width: '100%'
                  }
                }),
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                  h(Button, { onClick: function () { setRenameOpen(false) } }, '取消'),
                  h(Button, { primary: true, onClick: submitRename }, '确定'))))
          : null
      )
    }

    function PickerPanel(props) {
      var state = props.state
      var list = state.cards || []
      var confirmState = useState('')
      var confirmId = confirmState[0]
      var setConfirmId = confirmState[1]
      var draftState = useState({ name: '', description: '', scenario: '', personality: '', postHistoryInstructions: '' })
      var draft = draftState[0]
      var setDraft = draftState[1]
      var creatingState = useState(false)
      var creating = creatingState[0]
      var setCreating = creatingState[1]

      function editDraft(key, value) {
        var next = Object.assign({}, draft, {})
        next[key] = value
        setDraft(next)
      }

      function create() {
        var name = String(draft.name || '').trim()
        if (!name) {
          state.setError('先给新角色起个名字')
          return
        }
        var payload = {
          name: name,
          description: draft.description,
          scenario: draft.scenario,
          personality: draft.personality,
          postHistoryInstructions: draft.postHistoryInstructions
        }
        api('/cards', { method: 'POST', body: JSON.stringify(payload) })
          .then(function (data) {
            state.setError('')
            setDraft({ name: '', description: '', scenario: '', personality: '', postHistoryInstructions: '' })
            setCreating(false)
            return state.reloadCards().then(function () {
              if (data && data.card && data.card.id) state.setActiveId(data.card.id)
            })
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      function remove(item) {
        api('/cards/' + encodeURIComponent(item.id), { method: 'DELETE' })
          .then(function () {
            state.setError('')
            if (state.activeId === item.id) state.setActiveId('')
            setConfirmId('')
            return state.reloadCards()
          })
          .catch(function (err) {
            state.setError(String((err && err.message) || err))
          })
      }

      return h(
        Section,
        null,
        h('div', { style: { color: C.dim, fontSize: 12, marginBottom: 8 } },
          '点一张卡切换当前角色，右边垃圾桶删除。这里是全局绑定：所有会话都用这张卡。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
          h(Button, { primary: true, onClick: function () { setCreating(!creating) } },
            creating ? '收起' : '＋ 创建角色'),
          h(Button, { onClick: function () { state.setActiveId('') } }, state.activeId ? '解除绑定' : '已解绑')),
        creating
          ? h('div', {
            style: {
              border: '1px solid ' + C.line,
              borderRadius: 8,
              padding: 10,
              marginBottom: 16,
              background: C.panelSoft
            }
          },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '创建角色'),
            h('div', { style: { marginBottom: 10 } },
              h('div', { style: { color: C.dim, fontSize: 12, marginBottom: 4 } }, '名字'),
              h('input', {
                style: inputStyle,
                value: draft.name,
                onChange: function (e) { editDraft('name', e.target.value) }
              })),
            CARD_FIELDS.map(function (item) {
              var key = item[0]
              return h('div', { key: key, style: { marginBottom: 10 } },
                h('div', { style: { color: C.dim, fontSize: 12, marginBottom: 4 } }, item[1]),
                h(AutoTextarea, {
                  memoryKey: 'new:' + key,
                  value: draft[key] || '',
                  defaultHeight: 96,
                  onChange: function (value) { editDraft(key, value) }
                }))
            }),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              h(Button, { onClick: function () { setCreating(false) } }, '取消'),
              h(Button, { primary: true, onClick: create }, '创建')))
          : null,
        list.length === 0
          ? h('div', { style: { color: C.dim } }, '还没有角色卡，上面填好创建一张，或者去左边导入。')
          : list.map(function (item) {
              var active = item.id === state.activeId
              var pending = confirmId === item.id
              return h(
                'div',
                {
                  key: item.id,
                  onClick: function () {
                    state.setActiveId(item.id)
                    setConfirmId('')
                  },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    marginBottom: 6,
                    border: '1px solid ' + (active ? C.accent : C.line),
                    background: active ? 'rgba(91,155,255,0.12)' : 'transparent'
                  }
                },
                h('img', {
                  src: API + '/cards/' + encodeURIComponent(item.id) + '/avatar',
                  alt: '',
                  style: { width: 32, height: 32, borderRadius: 6, objectFit: 'contain', background: C.panelSoft, flex: '0 0 auto' }
                }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 13 } }, item.name),
                  h('div', { style: { color: C.dim, fontSize: 11 } }, item.source + ' · ' + item.chars + ' 字')),
                pending
                  ? h(
                      'div',
                      { style: { display: 'flex', gap: 4, flex: '0 0 auto' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: function (e) {
                            e.stopPropagation()
                            remove(item)
                          },
                          style: {
                            border: '1px solid #e05c5c',
                            background: 'rgba(224,92,92,0.18)',
                            color: '#ffb4b4',
                            borderRadius: 6,
                            padding: '2px 8px',
                            fontSize: 11,
                            cursor: 'pointer'
                          }
                        },
                        '确认删除'
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: function (e) {
                            e.stopPropagation()
                            setConfirmId('')
                          },
                          style: {
                            border: '1px solid ' + C.line,
                            background: 'transparent',
                            color: C.dim,
                            borderRadius: 6,
                            padding: '2px 8px',
                            fontSize: 11,
                            cursor: 'pointer'
                          }
                        },
                        '取消'
                      )
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        title: '删除这张角色卡',
                        onClick: function (e) {
                          e.stopPropagation()
                          setConfirmId(item.id)
                        },
                        style: {
                          flex: '0 0 auto',
                          width: 26,
                          height: 26,
                          borderRadius: 6,
                          border: '1px solid ' + C.line,
                          background: 'transparent',
                          color: C.faint,
                          cursor: 'pointer',
                          fontSize: 13,
                          lineHeight: 1
                        }
                      },
                      '×'
                    )
              )
            })
      )
    }

    // 顶栏标题跟着「你的称呼」走：改用户信息里的名字，这里立刻变。
    function partnerTitle(settings) {
      var who = (settings && settings.userName ? String(settings.userName) : '').trim()
      return (who || '你') + '的伙伴'
    }

    var MENU = [
      { key: 'card', label: '角色设定' },
      { key: 'worldbook', label: '世界书' },
      { key: 'gallery', label: '图库' },
      { key: 'user', label: '用户信息' },
      { key: 'sanitize', label: '权限设置' },
      { key: 'picker', label: '切换角色' }
    ]

    // 开启前的警告：这个开关等于把「正常 DSH 会话的工具面」交给一个在演角色的模型。
    function EnableWarning(props) {
      var items = [
        '这个插件会让角色拿到**正常 DSH 会话同级的工具权限**：读写文件、执行命令、联网、派子智能体、技能与交付。',
        '这些动作会以「剧情里的行为」被执行，角色通常不会先问你一句。',
        '权限限制的具体位置：顶栏「角色后台」页签 → 右栏「权限设置」。那里每一组默认都是关的，底部写明每组具体包含哪些工具名。',
        '插件总开关关着时，人格段与权限门禁都不生效，会话和没装它一样。'
      ]
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }
        },
        h(
          'div',
          {
            style: {
              width: 540,
              maxWidth: '92vw',
              background: C.panel,
              border: '1px solid ' + C.line,
              borderRadius: 10,
              padding: 18,
              boxSizing: 'border-box',
              boxShadow: '0 18px 48px rgba(0,0,0,0.45)'
            }
          },
          h('div', { style: { fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 10 } }, '开启前请确认'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 } },
            items.map(function (text, index) {
              return h('div', {
                key: 'w' + index,
                style: { fontSize: 12.5, lineHeight: 1.7, color: C.dim }
              }, (index === 0 ? '' : '· ') + text.replaceAll('**', ''))
            })),
          h('div', { style: { fontSize: 11.5, color: C.faint, marginBottom: 14 } },
            '想改回来：同一个开关关掉，或在「权限设置」里把各组关回去。'),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(Button, { onClick: props.onCancel }, '取消'),
            h(Button, { primary: true, onClick: props.onConfirm }, '我已知晓，开启'))
        )
      )
    }

    function Root() {
      var enabledState = useState(readEnabled)
      var setEnabledRaw = enabledState[1]
      var warnState = useState(false)
      var sectionState = useState(readSection)
      var section = sectionState[0]
      var setSectionRaw = sectionState[1]

      // 记住上次停在哪个分区，下次打开直接回到那里。
      function setSection(next) {
        setSectionRaw(next)
        writeSection(next)
      }
      var state = useStudio()

      // 总开关的真身在 settings.json；宿主没回之前先用 localStorage 顶着。
      var enabled = state.settings ? state.settings.enabled !== false : enabledState[0]
      var warnOpen = warnState[0]
      var setWarnOpen = warnState[1]

      function applyEnabled(next) {
        setEnabledRaw(next)
        writeEnabled(next)
        state.setSettings(Object.assign({}, state.settings || {}, { enabled: next }))
        api('/settings', { method: 'PATCH', body: JSON.stringify({ enabled: next }) }).catch(function (err) {
          state.setError(String((err && err.message) || err))
        })
      }

      // 打开要先过警告页；关闭直接生效。
      function toggleEnabled(next) {
        if (next) {
          setWarnOpen(true)
          return
        }
        applyEnabled(false)
      }

      useEffect(function () {
        injectStyle()
      }, [])

      function importFrom(file) {
        if (!file) return
        var reader = new window.FileReader()
        reader.onload = function () {
          var result = String(reader.result || '')
          var comma = result.indexOf(',')
          var base64 = comma >= 0 ? result.slice(comma + 1) : result
          state.setBusy(true)
          api('/cards/import', { method: 'POST', body: JSON.stringify({ base64: base64, fileName: file.name }) })
            .then(function (data) {
              state.setError('')
              return state.reloadCards().then(function () {
                if (data && data.card) state.setActiveId(data.card.id)
              })
            })
            .catch(function (err) {
              state.setError(String((err && err.message) || err))
            })
            .then(function () {
              state.setBusy(false)
            })
        }
        reader.readAsDataURL(file)
      }

      function uploadAvatar(file) {
        if (!file || !state.activeId) return
        var reader = new window.FileReader()
        reader.onload = function () {
          var result = String(reader.result || '')
          var comma = result.indexOf(',')
          var base64 = comma >= 0 ? result.slice(comma + 1) : result
          api('/cards/' + encodeURIComponent(state.activeId) + '/avatar', {
            method: 'POST',
            body: JSON.stringify({ base64: base64 })
          })
            .then(function () {
              return state.reloadCards()
            })
            .catch(function (err) {
              state.setError(String((err && err.message) || err))
            })
        }
        reader.readAsDataURL(file)
      }

      function openExport(fmt) {
        if (!state.activeId) return
        var url = API + '/cards/' + encodeURIComponent(state.activeId) + '/export?fmt=' + fmt
        var link = window.document.createElement('a')
        link.href = url
        link.download = ''
        window.document.body.appendChild(link)
        link.click()
        window.document.body.removeChild(link)
      }

      var card = state.card

      return h(
        'div',
        { className: 'rp-studio-root', style: panelStyle },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 14px',
              borderBottom: '1px solid ' + C.line,
              background: 'var(--dsw-alias-bg-module-platform, #22262e)',
              flex: '0 0 auto'
            }
          },
          h('div', { style: { fontWeight: 600 } }, partnerTitle(state.settings)),
          h('div', { style: { color: C.dim, fontSize: 12 } }, enabled ? '已启用' : '已停用'),
          h('div', { style: { flex: '1 1 auto' } }),
          state.error
            ? h('div', {
                style: {
                  color: '#d9534f',
                  fontSize: 12,
                  maxWidth: 420,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }
              }, state.error)
            : null,
          h(Switch, {
            checked: enabled,
            onChange: function (next) {
              toggleEnabled(next)
            }
          })
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' } },
          h(
            'div',
            {
              style: {
                width: 272,
                flex: '0 0 272px',
                background: 'var(--dsw-alias-bg-module-platform, #22262e)',
                padding: 12,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                overflow: 'auto'
              }
            },
            h('div', {
              style: {
                fontSize: 14,
                fontWeight: 600,
                color: C.text,
                padding: '2px 2px 4px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              },
              title: card ? card.name : ''
            }, card ? card.name : '（未选择）'),
            h(
              'div',
              {
                onClick: function () {
                  var input = window.document.getElementById('rp-studio-avatar-input')
                  if (input) input.click()
                },
                style: {
                  width: '100%',
                  borderRadius: 6,
                  background: C.panelSoft,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  color: C.dim,
                  fontSize: 12,
                  textAlign: 'center',
                  boxSizing: 'border-box',
                  lineHeight: 0
                }
              },
              state.activeId
                ? h('img', {
                    src: API + '/cards/' + encodeURIComponent(state.activeId) + '/avatar?t=' + encodeURIComponent(String((card && card.updatedAt) || '')),
                    alt: '',
                    style: {
                      width: '100%',
                      height: 'auto',
                      maxHeight: 320,
                      objectFit: 'contain',
                      objectPosition: 'center',
                      borderRadius: 6,
                      display: 'block'
                    }
                  })
                : h('div', { style: { padding: '40px 0', lineHeight: 1.6 } }, null)
            ),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h(Button, {
                onClick: function () {
                  var input = window.document.getElementById('rp-studio-file-input')
                  if (input) input.click()
                }
              }, '导入角色卡'),
              h(Button, { disabled: !state.activeId, onClick: function () { openExport('png') } }, '导出 PNG')),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h(Button, { disabled: !state.activeId, onClick: function () { openExport('json') } }, '导出 JSON'),
              h(Button, { disabled: !state.activeId, onClick: function () { openExport('txt') } }, '导出 TXT')),
            h('div', { style: { flex: '1 1 auto' } }),
            h('input', {
              id: 'rp-studio-file-input',
              type: 'file',
              accept: '.png,.json,.txt,.card',
              style: { display: 'none' },
              onChange: function (event) {
                importFrom(event.target.files && event.target.files[0])
                event.target.value = ''
              }
            }),
            h('input', {
              id: 'rp-studio-avatar-input',
              type: 'file',
              accept: 'image/png',
              style: { display: 'none' },
              onChange: function (event) {
                uploadAvatar(event.target.files && event.target.files[0])
                event.target.value = ''
              }
            })
          ),
          h(
            'div',
            { style: { flex: '1 1 0%', minWidth: 0, display: 'flex', flexDirection: 'column' } },
            section === 'card' ? h(CardEditor, { state: state }) : null,
            section === 'worldbook' ? h(WorldbookPanel, { state: state }) : null,
            section === 'gallery' ? h(GalleryPanel, { state: state }) : null,
            section === 'user' ? h(UserPanel, { state: state }) : null,
            section === 'sanitize' ? h(SanitizePanel, { state: state }) : null,
            section === 'picker' ? h(PickerPanel, { state: state }) : null
          ),
          h(
            'div',
            {
              style: {
                width: 150,
                flex: '0 0 150px',
                background: 'var(--dsw-alias-bg-module-platform, #22262e)',
                padding: 8,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                gap: 4
              }
            },
            MENU.map(function (item) {
              var active = item.key === section
              return h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  onClick: function () {
                    setSection(item.key)
                  },
                  style: {
                    textAlign: 'left',
                    padding: '7px 9px',
                    borderRadius: 6,
                    border: '1px solid ' + (active ? C.accent : 'transparent'),
                    background: active ? 'rgba(77,140,255,0.10)' : 'transparent',
                    color: C.text,
                    cursor: 'pointer',
                    fontSize: 12
                  }
                },
                item.label
              )
            })
          )
        ),
        warnOpen
          ? h(EnableWarning, {
              onCancel: function () {
                setWarnOpen(false)
              },
              onConfirm: function () {
                setWarnOpen(false)
                applyEnabled(true)
              }
            })
          : null
      )
    }

    function apply(ctx) {
      try {
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'rp-studio',
              order: 40,
              label: function () {
                return '角色后台'
              }
            },
            Root
          )
        })
      } catch (error) {
        console.warn('dsh-rp-studio: slot registration failed', error)
      }
    }

    return { name: 'dsh-rp-studio-client', inject: ['slots'], apply: apply }
  }
})
