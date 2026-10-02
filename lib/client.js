/**
 * dsh-hidden-session —— 浏览器侧（Client half）。
 *
 * 由 DSH 客户端 Module Loader 动态加载（package.json 的 dsh.client + exports "./client"）。
 * 本文件是**免构建的普通 JS**：不依赖任何 npm 运行时依赖，只用 loader 提供的 react，
 * 这样插件可以直接以 link/本地目录安装使用。
 *
 * 三个能力：
 * 1. 会话行「...」菜单与行尾悬停按钮各注入一个「隐藏会话」动作
 *    （官方可扩展 slot：sidebar.workspaces.session.menu.item / .row.action）。
 * 2. 用一条按会话 id 生成的样式表把隐藏会话的侧边栏行隐藏掉。锚点是 DSH 侧边栏
 *    会话行自身的 DOM 契约 `[data-row-key="session:<id>"]`（见 ui-workspace 的
 *    rows/Rows.tsx），因此不需要 MutationObserver 打补丁，也不会随重渲染失效。
 * 3. 设置里注册一个一级条目「隐藏会话」：列出已隐藏会话、逐个/全部恢复、开关「同时抑制
 *    搜索结果中的隐藏会话」（slot：settings.section）。
 *
 * 刻意回避的写法（为了在未验证版本的 DSH 上也不炸）：
 * - 不 require('@deepseek-ai/dsh-client-ui-primitives')：按钮用原生 element + 局部样式，
 *   避免依赖某个具体导出名/图标名。
 * - 不用 ctx.locale 的字典注册：不同版本 register() 签名不一致（两参/三参），
 *   文案改为按宿主 locale/浏览器语言就地选择。
 */

(function () {
  'use strict'

  window.__ModuleLoader__.load({
    id: 'dsh-hidden-session',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      var React = require('react')
      var h = React.createElement

      var API_BASE = '/api/dsh-hidden-session'
      var CSS_ID = 'dsh-hidden-session-css'
      var HIDE_CSS_ID = 'dsh-hidden-session-hide-css'
      var SEARCH_HIDDEN_ATTR = 'data-dsh-hidden-search'
      var ROW_HIDDEN_ATTR = 'data-dsh-hidden-row'
      var PREF_KEY = 'dsh-hidden-session:suppress-search'
      var SESSION_KEY_ATTR = 'data-row-key'

      // ---------------------------------------------------------------- 文案

      var DICT = {
        zh: {
          sectionTitle: '隐藏会话',
          sectionLede: '把不想出现在侧边栏的会话隐藏起来。会话本身、历史记录与磁盘数据都不会被修改，随时可以恢复。',
          menuHide: '隐藏会话',
          rowHide: '隐藏会话',
          empty: '当前没有被隐藏的会话。',
          count: function (n) { return '已隐藏 ' + n + ' 个会话' },
          restore: '恢复',
          restoreAll: '全部恢复',
          suppressSearch: '同时抑制搜索结果中的隐藏会话',
          hiddenToast: '已隐藏会话',
          hiddenCurrentToast: '已隐藏当前打开的会话；对话保持打开，可在「设置 → 隐藏会话」中恢复。',
          restoreToast: '已恢复，会话重新出现在侧边栏',
          restoreAllToast: '已恢复全部隐藏会话',
          hideFailed: '隐藏失败：',
          restoreFailed: '恢复失败：',
          loadFailed: '读取隐藏集合失败：',
          restoreOne: '恢复「{title}」',
          contractMissing: '⚠️ 当前页面没有检测到会话行的 data-row-key 锚点：可能是 DSH 版本变化导致隐藏不生效，请更新插件。',
        },
        en: {
          sectionTitle: 'Hidden sessions',
          sectionLede: 'Keep sessions out of the sidebar. The session, its history and its files are never modified — hiding is reversible at any time.',
          menuHide: 'Hide session',
          rowHide: 'Hide session',
          empty: 'No hidden sessions.',
          count: function (n) { return n + ' hidden session(s)' },
          restore: 'Restore',
          restoreAll: 'Restore all',
          suppressSearch: 'Also suppress hidden sessions in search results',
          hiddenToast: 'Session hidden',
          hiddenCurrentToast: 'The current session was hidden; the conversation stays open — restore it under Settings → Hidden sessions.',
          restoreToast: 'Restored — the session is back in the sidebar',
          restoreAllToast: 'All hidden sessions restored',
          hideFailed: 'Hide failed: ',
          restoreFailed: 'Restore failed: ',
          loadFailed: 'Could not read the hidden set: ',
          restoreOne: 'Restore "{title}"',
          contractMissing: '⚠️ No session-row data-row-key anchor found on this page: a DSH version change may make hiding ineffective — please update the plugin.',
        },
      }

      var lang = 'en'
      var rootCtx = null

      /** 宿主 locale 优先，其次浏览器语言；任何异常都退回英文。 */
      function detectLang(ctx) {
        try {
          if (ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function') {
            var snap = ctx.locale.getSnapshot()
            if (snap && typeof snap.active === 'string' && snap.active) return snap.active.indexOf('zh') === 0 ? 'zh' : 'en'
          }
        } catch (e) { /* 忽略：locale 服务可选 */ }
        try {
          if (typeof navigator !== 'undefined' && typeof navigator.language === 'string'
            && navigator.language.toLowerCase().indexOf('zh') === 0) return 'zh'
        } catch (e) { /* 忽略 */ }
        return 'en'
      }

      /**
       * 当前语言文案。每次调用都重读宿主 locale，因此切语言后下一次渲染就换文案
       * （宿主 locale 拿不到时才退回 apply 时快照的 lang）。
       */
      function T() {
        var active = rootCtx ? detectLang(rootCtx) : lang
        return DICT[active] || DICT.en
      }

      // ---------------------------------------------------------------- 迷你 store

      /** 创建极简可订阅 store（React 组件用 useStore 订阅）。 */
      function createStore(initial) {
        var listeners = []
        var state = initial
        return {
          get: function () { return state },
          set: function (next) {
            state = next
            var snapshot = listeners.slice()
            for (var i = 0; i < snapshot.length; i++) {
              try { snapshot[i]() } catch (e) { /* 单个订阅者异常不影响其它订阅者 */ }
            }
          },
          subscribe: function (fn) {
            listeners.push(fn)
            return function () {
              var at = listeners.indexOf(fn)
              if (at >= 0) listeners.splice(at, 1)
            }
          },
        }
      }

      var store = createStore({
        ids: [],
        ready: false,
        busy: false,
        error: null,
        suppressSearch: true,
      })

      /** React 侧订阅 store。 */
      function useStore(target) {
        var pair = React.useState(function () { return target.get() })
        var setValue = pair[1]
        React.useEffect(function () {
          var sync = function () { setValue(target.get()) }
          sync()
          return target.subscribe(sync)
        }, [target])
        return pair[0]
      }

      /** 覆盖式更新 store（浅拷贝，保证引用变化）。 */
      function patchStore(patch) {
        var current = store.get()
        var next = {}
        for (var key in current) {
          if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key]
        }
        for (var patchKey in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, patchKey)) next[patchKey] = patch[patchKey]
        }
        store.set(next)
      }

      // ---------------------------------------------------------------- 工具

      /** 会话 id 白名单：与宿主侧校验保持一致。 */
      function isSafeId(id) {
        return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id)
      }

      /** CSS 属性选择器里安全地引用一个字符串（本插件的 id 已被白名单化，这里再兜一层）。 */
      function cssQuote(value) {
        return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
      }

      /** 文本归一化，用于搜索结果标题比对。 */
      function normalizeText(value) {
        return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
      }

      // ---------------------------------------------------------------- 样式

      var STATIC_CSS = [
        // 按 id 的规则（见 syncHideRules）在行首帧即命中；这条属性规则让「被 AnimatedRows
        // 复制出来的退出克隆」也保持隐藏（克隆是 cloneNode(true)，只摘掉了 data-row-key）。
        '[' + ROW_HIDDEN_ATTR + ']{display:none !important}',
        '[' + SEARCH_HIDDEN_ATTR + ']{display:none !important}',
        '.dsh-hidden-session-root{display:flex;flex-direction:column;gap:10px;padding:4px 0 6px;box-sizing:border-box;width:100%}',
        '.dsh-hidden-session-root *{box-sizing:border-box}',
        '.dsh-hidden-session-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dsh-hidden-session-lede{font-size:13px;line-height:1.5;margin:0;color:var(--dsw-alias-label-tertiary,#86909c)}',
        '.dsh-hidden-session-count{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.dsh-hidden-session-empty{font-size:13px;color:var(--dsw-alias-label-tertiary,#86909c)}',
        '.dsh-hidden-session-error{font-size:12px;color:#dc2626;margin:0}',
        '.dsh-hidden-session-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto}',
        '.dsh-hidden-session-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}',
        '.dsh-hidden-session-item-title{flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dsh-hidden-session-btn{height:28px;padding:0 12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-size:12px;cursor:pointer;flex-shrink:0}',
        '.dsh-hidden-session-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
        '.dsh-hidden-session-btn:disabled{opacity:.45;cursor:default}',
        '.dsh-hidden-session-btn-primary{align-self:flex-start;border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}',
        '.dsh-hidden-session-toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
        '.dsh-hidden-session-menu-item{display:block;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:6px;white-space:nowrap}',
        '.dsh-hidden-session-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
        '.dsh-hidden-session-icon-button{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#86909c);cursor:pointer}',
        '.dsh-hidden-session-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115)}',
        '[data-dsh-hidden-session-toast]{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;' +
          'max-width:70vw;padding:8px 14px;border-radius:10px;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;' +
          'color:#f5f6f7;background:rgba(24,24,28,.94);border:1px solid rgba(255,255,255,.14);' +
          'box-shadow:0 6px 24px rgba(0,0,0,.28);transition:opacity .24s ease;pointer-events:none}',
      ].join('\n')

      /** 按需插入一个 style 元素（同一 data-plugin-css 只插一次）。 */
      function ensureStyleElement(id) {
        if (typeof document === 'undefined' || !document.head) return null
        var existing = document.querySelector('style[data-plugin-css=' + cssQuote(id) + ']')
        if (existing) return existing
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-hidden-session'
        tag.dataset.pluginCss = id
        tag.textContent = ''
        document.head.appendChild(tag)
        return tag
      }

      /** 把隐藏集合写成 CSS 规则：命中会话行即整行不显示。 */
      function syncHideRules() {
        var tag = ensureStyleElement(HIDE_CSS_ID)
        if (!tag) return
        var ids = store.get().ids
        var rules = []
        for (var i = 0; i < ids.length; i++) {
          if (!isSafeId(ids[i])) continue
          rules.push('[' + SESSION_KEY_ATTR + '="session:' + ids[i] + '"]{display:none !important}')
        }
        tag.textContent = rules.join('\n')
      }

      // ---------------------------------------------------------------- 轻量 toast

      var toastTimer = null

      /** 右下角提示（自建 DOM，不占用任何 slot，避免出错影响宿主界面）。 */
      function toast(message) {
        if (typeof document === 'undefined' || !document.body) return
        var existing = document.querySelector('[data-dsh-hidden-session-toast]')
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        var el = document.createElement('div')
        el.setAttribute('data-dsh-hidden-session-toast', '')
        el.textContent = message
        document.body.appendChild(el)
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(function () {
          el.style.opacity = '0'
          setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el)
          }, 260)
        }, 2600)
      }

      // ---------------------------------------------------------------- 客户端 sessions 面

      var sessionsService = null

      /** 当前 client sessions 列表快照（缺失时退化为空对象）。 */
      function sessionsSnapshot() {
        try {
          if (sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function') {
            return sessionsService.list.getSnapshot() || {}
          }
        } catch (e) { /* 忽略 */ }
        return {}
      }

      /**
       * 主视图当前会话的 id。权威判定是「byId 里 retainedBy.mainView > 0 的那一行」
       * （ui-workspace 与 open-in-app 全用这个写法）—— SessionListState 只有
       * ids / byId / phase / projectionsBySession，**没有 current 字段**。
       */
      function currentSessionId() {
        var byId = sessionsSnapshot().byId || {}
        for (var id in byId) {
          if (!Object.prototype.hasOwnProperty.call(byId, id)) continue
          var row = byId[id]
          var retain = row ? row.retainedBy : null
          if (retain && (retain.mainView || 0) > 0) return id
        }
        return undefined
      }

      /** 隐藏会话的标题集合（归一化后），用于抑制搜索结果行。 */
      function hiddenTitleSet() {
        var out = Object.create(null)
        var snapshot = sessionsSnapshot()
        var byId = snapshot.byId || {}
        var ids = store.get().ids
        for (var i = 0; i < ids.length; i++) {
          var entry = byId[ids[i]]
          var title = entry && typeof entry.displayTitle === 'string' ? entry.displayTitle : ''
          var normalized = normalizeText(title)
          if (normalized) out[normalized] = true
        }
        return out
      }

      /**
       * 搜索结果行（有 role="treeitem" 但没有 data-row-key）不在 slot 契约内，
       * 无法从数据层过滤，因此按「行内标题节点 == 某个隐藏会话标题」精确隐藏。
       * 只在没有 data-row-key 的行上操作，绝不误伤侧边栏的正常会话行。
       */
      function applySearchSuppression() {
        if (typeof document === 'undefined') return
        var rows = document.querySelectorAll('[role="treeitem"]')
        var suppress = store.get().suppressSearch
        var titles = suppress ? hiddenTitleSet() : null
        var hasTitles = false
        if (titles !== null) {
          for (var key in titles) { hasTitles = true; break }
        }
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i]
          if (row.hasAttribute(SESSION_KEY_ATTR)) continue
          var hit = hasTitles ? rowMatchesHiddenTitle(row, titles) : false
          if (hit) row.setAttribute(SEARCH_HIDDEN_ATTR, '')
          else row.removeAttribute(SEARCH_HIDDEN_ATTR)
        }
      }

      /**
       * 一个元素**自身直接文本**的归一化值（只统计直接子文本节点，不含后代元素）。
       * 搜索结果行的标题是行内的一个 span，用自身文本比对就只认标题本身：既不被摘要
       * 片段干扰，也不会像前缀匹配那样连带隐藏「以某个隐藏标题开头」的其它会话。
       */
      function ownText(el) {
        var out = ''
        var nodes = el.childNodes
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].nodeType === 3) out += nodes[i].nodeValue
        }
        return normalizeText(out)
      }

      /** 行内是否存在自身文本恰好等于某个隐藏会话标题的 span。 */
      function rowMatchesHiddenTitle(row, titles) {
        var spans = row.querySelectorAll('span')
        for (var i = 0; i < spans.length; i++) {
          var own = ownText(spans[i])
          if (own && titles[own] === true) return true
        }
        return false
      }

      /**
       * 给已知的隐藏行打上属性标记。
       * 为什么需要它：AnimatedRows 在行被移除时用 `cloneNode(true)` 复制该行来做退出
       * 动画，并显式摘掉 `data-row-key`（ui-workspace rows/AnimatedRows）。只靠 id 规则
       * 的话那个克隆会短暂可见；属性标记会被克隆继承，于是克隆也保持隐藏。
       * 克隆没有 data-row-key，无法反查 id，所以**保持**它的标记不动（它马上会被移除）。
       */
      function syncRowMarkers() {
        if (typeof document === 'undefined') return
        var ids = store.get().ids
        var marked = document.querySelectorAll('[' + ROW_HIDDEN_ATTR + ']')
        if (ids.length === 0 && marked.length === 0) return
        var wanted = Object.create(null)
        for (var i = 0; i < ids.length; i++) {
          if (isSafeId(ids[i])) wanted[ids[i]] = true
        }
        for (var m = 0; m < marked.length; m++) {
          var rawKey = marked[m].getAttribute(SESSION_KEY_ATTR) || ''
          if (rawKey.indexOf('session:') !== 0) continue // 退出克隆：保持标记
          if (wanted[rawKey.slice(8)] !== true) marked[m].removeAttribute(ROW_HIDDEN_ATTR)
        }
        for (var j = 0; j < ids.length; j++) {
          if (!isSafeId(ids[j])) continue
          var el = document.querySelector('[' + SESSION_KEY_ATTR + '="session:' + ids[j] + '"]')
          if (el) el.setAttribute(ROW_HIDDEN_ATTR, '')
        }
      }

      /** 清掉所有搜索抑制标记（关闭开关或卸载时）。 */
      function clearSearchSuppression() {
        if (typeof document === 'undefined') return
        var marked = document.querySelectorAll('[' + SEARCH_HIDDEN_ATTR + ']')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(SEARCH_HIDDEN_ATTR)
      }

      /** 清掉所有行标记（卸载时；含 AnimatedRows 的退出克隆）。 */
      function clearRowMarkers() {
        if (typeof document === 'undefined') return
        var marked = document.querySelectorAll('[' + ROW_HIDDEN_ATTR + ']')
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(ROW_HIDDEN_ATTR)
      }

      var searchSyncScheduled = false

      /** 一帧内合并多次触发。 */
      function scheduleSearchSync() {
        if (searchSyncScheduled) return
        searchSyncScheduled = true
        var run = function () {
          searchSyncScheduled = false
          try { syncRowMarkers() } catch (e) { /* 忽略 */ }
          try { applySearchSuppression() } catch (e) { /* 忽略 */ }
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else setTimeout(run, 16)
      }

      // ---------------------------------------------------------------- 与宿主通信

      /** 调一次插件 REST 接口；非 2xx 抛错。 */
      function request(path, body) {
        var options = { credentials: 'same-origin' }
        if (body !== undefined) {
          options.method = 'POST'
          options.headers = { 'content-type': 'application/json' }
          options.body = JSON.stringify(body)
        }
        return fetch(API_BASE + path, options).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
      }

      /** 把服务端返回的完整状态写回 store。 */
      function applyServerState(payload) {
        var hidden = payload && Array.isArray(payload.hidden) ? payload.hidden : []
        var ids = []
        for (var i = 0; i < hidden.length; i++) {
          if (isSafeId(hidden[i])) ids.push(hidden[i])
        }
        patchStore({ ids: ids, ready: true, error: null })
      }

      /** 隐藏一个会话。 */
      function hideSession(sessionId) {
        if (!isSafeId(sessionId)) return
        patchStore({ busy: true })
        request('/hide', { sessionId: sessionId }).then(function (payload) {
          applyServerState(payload)
          patchStore({ busy: false })
          var isCurrent = currentSessionId() === sessionId
          toast(isCurrent ? T().hiddenCurrentToast : T().hiddenToast)
        }).catch(function (err) {
          patchStore({ busy: false, error: T().hideFailed + describe(err) })
          toast(T().hideFailed + describe(err))
        })
      }

      /** 恢复若干会话。 */
      function showSessions(sessionIds) {
        var ids = []
        for (var i = 0; i < sessionIds.length; i++) {
          if (isSafeId(sessionIds[i])) ids.push(sessionIds[i])
        }
        if (ids.length === 0) return
        patchStore({ busy: true })
        request('/show', { sessionIds: ids }).then(function (payload) {
          applyServerState(payload)
          patchStore({ busy: false })
          toast(T().restoreToast)
        }).catch(function (err) {
          patchStore({ busy: false, error: T().restoreFailed + describe(err) })
          toast(T().restoreFailed + describe(err))
        })
      }

      /** 恢复全部。 */
      function showAll() {
        patchStore({ busy: true })
        request('/show-all', {}).then(function (payload) {
          applyServerState(payload)
          patchStore({ busy: false })
          toast(T().restoreAllToast)
        }).catch(function (err) {
          patchStore({ busy: false, error: T().restoreFailed + describe(err) })
          toast(T().restoreFailed + describe(err))
        })
      }

      /** 首次读取服务端状态。 */
      function loadState() {
        request('/state').then(function (payload) {
          applyServerState(payload)
        }).catch(function (err) {
          patchStore({ ready: true, error: T().loadFailed + describe(err) })
        })
      }

      /** 错误信息提取。 */
      function describe(err) {
        if (err && typeof err.message === 'string') return err.message
        return String(err)
      }

      /** 搜索抑制开关（记住在本浏览器）。 */
      function setSuppressSearch(value) {
        patchStore({ suppressSearch: value === true })
        try { window.localStorage.setItem(PREF_KEY, value === true ? '1' : '0') } catch (e) { /* 忽略 */ }
      }

      /** 读取持久化的开关取值。 */
      function readSuppressSearchPreference() {
        try {
          var raw = window.localStorage.getItem(PREF_KEY)
          if (raw === '0') return false
        } catch (e) { /* 忽略 */ }
        return true
      }

      // ---------------------------------------------------------------- 组件

      /** 兜底 hook：极老版本若未注入 useMenuOpenState，也不能把 Hook 调用放进条件分支。 */
      function useNoMenuState() {
        return [false, function () {}]
      }

      /** 「...」菜单里的一行：隐藏会话。 */
      function HideSessionMenuItem(props) {
        // Hook 必须无条件调用（Rules of Hooks）：先选函数、再调用，只对返回值兜底。
        var useMenuOpenState = props.useMenuOpenState || useNoMenuState
        var menuState = useMenuOpenState()
        var setMenuOpen = menuState && typeof menuState[1] === 'function' ? menuState[1] : function () {}
        return h('button', {
          type: 'button',
          role: 'menuitem',
          className: 'dsh-hidden-session-menu-item',
          onClick: function (event) {
            event.stopPropagation()
            if (typeof setMenuOpen === 'function') setMenuOpen(false)
            props.hideSession(props.sessionId)
          },
        }, T().menuHide)
      }

      /** 行尾悬停按钮：隐藏会话。 */
      function HideSessionRowButton(props) {
        return h('button', {
          type: 'button',
          className: 'dsh-hidden-session-icon-button',
          title: T().rowHide,
          'aria-label': T().rowHide,
          onClick: function (event) {
            event.stopPropagation()
            props.hideSession(props.sessionId)
          },
        }, h('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        }, [
          h('path', { key: 'eye', d: 'M9.9 5.2A9.6 9.6 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4.2' }),
          h('path', { key: 'pupil', d: 'M6.1 6.9A17 17 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 4.1-.9' }),
          h('path', { key: 'slash', d: 'M2 2l20 20' }),
        ]))
      }

      /** 当前页面是否还能看到会话行的 data-row-key 契约（版本漂移自诊断）。 */
      function rowContractVisible() {
        try {
          return typeof document !== 'undefined' && document.querySelector('[data-row-key^="session:"]') !== null
        } catch (e) {
          return false
        }
      }

      /** 设置导航条目「隐藏会话」的管理面板。 */
      function HiddenSessionsSection() {
        var state = useStore(store)
        var sessions = useStore(sessionsAdapter)
        var byId = (sessions && sessions.byId) || {}
        var ids = state.ids || []
        var text = T()
        var children = [
          h('h3', { key: 'title', className: 'dsh-hidden-session-title' }, text.sectionTitle),
          h('p', { key: 'lede', className: 'dsh-hidden-session-lede' }, text.sectionLede),
        ]
        if (state.error) {
          children.push(h('p', { key: 'error', className: 'dsh-hidden-session-error' }, state.error))
        }
        // 隐藏集合非空却看不到任何会话行锚点 → 说明这个 DSH 版本改了行 DOM，隐藏不会生效。
        // 明说原因，避免「设置里显示已隐藏、侧边栏却还在」这种莫名状态。
        if (ids.length > 0 && !rowContractVisible()) {
          children.push(h('p', { key: 'contract', className: 'dsh-hidden-session-error' }, text.contractMissing))
        }
        if (ids.length === 0) {
          children.push(h('div', { key: 'empty', className: 'dsh-hidden-session-empty' }, text.empty))
        } else {
          children.push(h('div', { key: 'count', className: 'dsh-hidden-session-count' }, text.count(ids.length)))
          children.push(h('ul', { key: 'list', className: 'dsh-hidden-session-list' }, ids.map(function (id) {
            var entry = byId[id]
            var title = entry && typeof entry.displayTitle === 'string' && entry.displayTitle ? entry.displayTitle : id
            return h('li', { key: id, className: 'dsh-hidden-session-item' }, [
              h('span', { key: 'title', className: 'dsh-hidden-session-item-title', title: title }, title),
              h('button', {
                key: 'restore',
                type: 'button',
                className: 'dsh-hidden-session-btn',
                disabled: state.busy === true,
                title: text.restoreOne.replace('{title}', title),
                onClick: function () { showSessions([id]) },
              }, text.restore),
            ])
          })))
          children.push(h('button', {
            key: 'restore-all',
            type: 'button',
            className: 'dsh-hidden-session-btn dsh-hidden-session-btn-primary',
            disabled: state.busy === true,
            onClick: function () { showAll() },
          }, text.restoreAll))
        }
        children.push(h('label', { key: 'toggle', className: 'dsh-hidden-session-toggle' }, [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: state.suppressSearch === true,
            onChange: function (event) { setSuppressSearch(event.target.checked) },
          }),
          h('span', { key: 'label' }, text.suppressSearch),
        ]))
        return h('div', { className: 'dsh-hidden-session-root', 'data-dsh-hidden-session': '' }, children)
      }

      // 设置卡片只需要 sessions 快照；用一个 store 形状的适配器接进 useStore。
      var sessionsAdapter = {
        get: function () { return sessionsSnapshot() },
        subscribe: function (fn) {
          try {
            if (sessionsService && sessionsService.list && typeof sessionsService.list.subscribe === 'function') {
              return sessionsService.list.subscribe(fn)
            }
          } catch (e) { /* 忽略 */ }
          return function () {}
        },
      }

      // ---------------------------------------------------------------- 插件主体

      /**
       * 客户端插件入口。
       * @param ctx - 客户端 cordis 根上下文（已声明 slots / sessions）。
       */
      function apply(ctx) {
        rootCtx = ctx
        lang = detectLang(ctx)
        // 取 client sessions 服务的官方惯用写法（ui-workspace 用 ctx.get("sessions")）；
        // 属性访问作为兜底，两步都失败则退化为「只有 id 没有标题」。
        sessionsService = null
        try {
          if (ctx && typeof ctx.get === 'function') sessionsService = ctx.get('sessions') || null
        } catch (e) { /* 忽略：服务缺失不影响隐藏本身 */ }
        if (!sessionsService) {
          try { sessionsService = ctx && ctx.sessions ? ctx.sessions : null } catch (e) { /* 忽略 */ }
        }
        patchStore({ suppressSearch: readSuppressSearchPreference() })

        // 1. 静态样式 + 动态隐藏规则。
        var staticTag = ensureStyleElement(CSS_ID)
        if (staticTag) staticTag.textContent = STATIC_CSS
        syncHideRules()
        var disposeStoreSub = store.subscribe(function () {
          syncHideRules()
          scheduleSearchSync()
        })
        patchStore({}) // 触发一次同步（样式与标记）

        // 2. 首次拉取服务端状态。
        loadState()

        // 3. 搜索结果抑制：跟随 DOM 变化按帧重算。
        var observer = null
        if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
          observer = new MutationObserver(function () { scheduleSearchSync() })
          try {
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          } catch (e) { observer = null }
        }
        var disposeSessionsSub = sessionsAdapter.subscribe(function () { scheduleSearchSync() })

        // 4. 两个官方 slot 扩展点：菜单项 + 悬停按钮。
        var disposeMenu = null
        var disposeRowAction = null
        var disposeSection = null

        if (ctx && ctx.slots) {
          disposeMenu = ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
            return ctx.slots.register({
              name: 'sidebar.workspaces.session.menu.item',
              id: 'dsh-hidden-session.hide',
              order: 500,
              inject: function () {
                return { hideSession: hideSession }
              },
            }, HideSessionMenuItem)
          })

          disposeRowAction = ctx.slots.inject('sidebar.workspaces.session.row.action', function () {
            return ctx.slots.register({
              name: 'sidebar.workspaces.session.row.action',
              id: 'dsh-hidden-session.hide-button',
              order: 300,
              inject: function () {
                return { hideSession: hideSession }
              },
            }, HideSessionRowButton)
          })

          disposeSection = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-hidden-session',
              order: 1010,
              label: function () { return T().sectionTitle },
            }, HiddenSessionsSection)
          })
        }

        // 5. fiber 释放时完整回滚（HMR / 卸载都不会残留样式与标记）。
        var dispose = function () {
          try { if (typeof disposeMenu === 'function') disposeMenu() } catch (e) { /* 忽略 */ }
          try { if (typeof disposeRowAction === 'function') disposeRowAction() } catch (e) { /* 忽略 */ }
          try { if (typeof disposeSection === 'function') disposeSection() } catch (e) { /* 忽略 */ }
          try { disposeStoreSub() } catch (e) { /* 忽略 */ }
          try { disposeSessionsSub() } catch (e) { /* 忽略 */ }
          if (observer) { try { observer.disconnect() } catch (e) { /* 忽略 */ } }
          clearSearchSuppression()
          clearRowMarkers()
          if (typeof document !== 'undefined') {
            var staticTag = document.querySelector('style[data-plugin-css=' + cssQuote(CSS_ID) + ']')
            if (staticTag && staticTag.parentNode) staticTag.parentNode.removeChild(staticTag)
            var hideTag = document.querySelector('style[data-plugin-css=' + cssQuote(HIDE_CSS_ID) + ']')
            if (hideTag && hideTag.parentNode) hideTag.parentNode.removeChild(hideTag)
            var toastEl = document.querySelector('[data-dsh-hidden-session-toast]')
            if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl)
          }
        }
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return dispose }, 'dsh-hidden-session: ui')
        }
      }

      exports.apply = apply
      // sessions 用于把隐藏 id 映射成标题，locale 用于跟随宿主语言（取不到时回退
      // navigator.language）。两者都是客户端运行时服务：核心包 ui-workspace 也注入它们。
      exports.inject = ['slots', 'sessions', 'locale']
      exports.default = { apply: apply, inject: ['slots', 'sessions', 'locale'] }

      return module.exports
    },
  })
})()
