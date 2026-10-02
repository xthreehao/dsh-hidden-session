# dsh-hidden-session —— DSH 隐藏会话插件

把不想出现在侧边栏的会话**隐藏**起来，随时可以恢复。隐藏只作用于显示层：会话本身、
历史记录、磁盘数据、Workspace 归属都不会被改动。

- **入口**：会话行「⋯」菜单 + 会话行尾部悬停按钮
- **管理**：设置里的「隐藏会话」页（列出 / 逐个恢复 / 全部恢复）
- **持久化**：宿主侧 `~/.dsh/storages/dsh-hidden-session.json`，重启与换浏览器都保持
- **可选**：同时抑制搜索结果中的隐藏会话

---

## 1. 工作原理

DSH 的插件体系 = Cordis 行栈（宿主半）+ Module Loader 客户端 bundle（浏览器半）。
本插件两半都在，且**浏览器半是免构建的普通 JS**，直接用 loader 提供的 `react`，
不引入任何 npm 运行时依赖 —— 这样本地 `link:` 安装即可工作。

### 1.1 动作入口（官方可扩展 slot，零侵入）

`@deepseek-ai/dsh-client-ui-workspace` 把会话行的两个动作区声明为 **list slot**，
并把自己内置的 pin / rename / fork / archive 也当作普通条目注册进去：

| slot | 位置 | 内置条目 order |
| --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | 会话行「⋯」菜单的一行 | pin 100 / rename 200 / fork 300 / archive 400 |
| `sidebar.workspaces.session.row.action` | 会话行尾部悬停按钮 | archive 100 / pin 200 |

本插件在这两处各注册一条 `order: 500 / 300`，因此排在官方动作之后：

```js
ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
  name: 'sidebar.workspaces.session.menu.item',
  id: 'dsh-hidden-session.hide',
  order: 500,
  inject: () => ({ hideSession }),
}, HideSessionMenuItem))
```

条目只拿到行身份（`sessionId`、`displayTitle`）与 `useMenuOpenState`，其余自己负责 ——
这是官方文档 `Getting-started` 示例的同一套写法，不依赖任何私有 API。

### 1.2 真正把行藏掉（DOM 契约 + CSS）

侧边栏会话行由核心包渲染，插件无法改它的数据派生，但会话行的根元素带有稳定标识：

```tsx
// ui-workspace/src/client/rows/Rows.tsx
<div ref={rowRef} data-row-key={`session:${node.id}`} role="treeitem" className={…}>
```

于是隐藏 = 生成一条按 id 的规则：

```css
[data-row-key="session:<sessionId>"] { display: none !important; }
```

好处是**不需要 MutationObserver 打补丁**：React 重渲染、切换分组/排序、重新展开
Workspace 之后规则依然命中，开销是零。`sessionId` 经过白名单校验
（`^[A-Za-z0-9._-]{1,128}$`），不可能注入 CSS 或路径。

还有第二条**属性标记** `[data-dsh-hidden-row]{display:none!important}`，由去抖的 DOM 扫描
打在已知隐藏行上。它不是冗余：`AnimatedRows` 在行被移除时用 `cloneNode(true)` 复制该行做
退出动画，并显式摘掉 `data-row-key`（`ui-workspace/lib/client.js:1725-1726`）——只靠 id 规则
那个克隆会短暂可见，而属性会被克隆继承，于是克隆也保持隐藏。

### 1.3 设置页管理卡片

`settings.section` slot 注册一张卡片，列出隐藏集合；标题取自客户端 sessions 列表
快照（`ctx.sessions.list.getSnapshot().byId[id].displayTitle`），会话摘要尚未加载时
退化显示会话 id。

### 1.4 宿主侧 REST 接口

```
GET  /api/dsh-hidden-session/state     → { version, hidden: [id…], updatedAt }
POST /api/dsh-hidden-session/hide      body { sessionId } | { sessionIds: [] }
POST /api/dsh-hidden-session/show      body { sessionId } | { sessionIds: [] }
POST /api/dsh-hidden-session/show-all
```

所有路由都做 **loopback + 同源** 校验（与 DSH `/api` 网关的信任栅栏同一套判定），
写操作返回写入后的完整状态；状态文件原子写入（tmp + rename，权限 0600）。
宿主半只声明 `webServer` 一个依赖，刻意不碰 `workspaceRegistry`、会话存储或
`session_projcache.json`。

---

## 2. 安装

下面用 `<profile>` 指代目标 profile 名（桌面版是 `desktop`，CLI Web 版是 `web`）。
**先确认应用实际用的是哪个 profile**——进程命令行里那个路径才算：

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Select-Object -ExpandProperty CommandLine
# 输出形如：... <安装目录>\resources\app.asar\dsh <用户目录>\.dsh\profiles\<profile> ...
```

### 两条激活路径 —— 只能选一条，绝不能同时用

| 路径 | 做法 | 生效时机 |
| --- | --- | --- |
| **A. bundle**（推荐/分发用） | 包加进 `dsh.profile.bundles`；本包自带的 `cordis.patch.yml` 插入行 | 重启后 |
| **B. profile patch 层** | 往 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加下面的 `insert` | **热重载，无需重启**（实测） |

```yaml
- insert:
    - id: hidden-session
      name: 'dsh-hidden-session'
```

> **为什么不能同时用**：`dsh-app-boot` 的 `applyEntryPatches()` 里 `insert` 是**无条件 append**
> （`buildMap` 只按 id 建索引，**不做去重、不覆盖**）。两条路径都插入就会得到**两行**，
> 同一个插件被实例化两次，第二次注册会撞上 `webserver: duplicate exact route`。
> 宿主半已经为此加了幂等防护（逐条 `try/catch`，重复路由只跳过并告警），所以最坏情况不会
> 拖垮启动；但正确做法仍然是只保留一条路径。

无论走哪条路径，**包本身必须能从 profile 目录被按名字解析到**（Loader 是按包名解析行 `name` 的）：

- 走 CLI：`dsh plugin --profile <profile> add -w "link:<本仓库的绝对路径>"`
  （会写 `dependencies` + 自动 reconcile `bundles`）。
- 或手工建一个目录链接/拷贝：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-hidden-session" `
  -Target '<本仓库的绝对路径>'
```

用 junction（而非拷贝）的好处：插件只有一份源码，改 `lib/client.js` 会被宿主 500ms 的
stat 轮询原地热换（见第 7 节）；`dependencies` 里照 CLI 的形式写 `link:` 便于以后 `pnpm install`。

也可以只用「路径 B」而不动 `package.json`：插入行已经让 Loader 去解析包名，
只要 junction/拷贝在位即可。

### 一次真实安装的落地形态（可照抄）

- `node_modules\dsh-hidden-session` → junction 指向本仓库
- `package.json` 的 `dependencies` 里写 `"dsh-hidden-session": "link:<本仓库路径>"`；
  **`dsh.profile.bundles` 里刻意不写它**（保证只有一条插入路径）
- `<profile>\cordis.patch.yml` 末尾追加上面的 `insert` 行 → 保存后运行中即时生效（无需重启）

要卸载：删掉 `cordis.patch.yml` 里那三行 + `package.json` 的 dependency + junction，然后重启。
临时停用更方便：把该行改成 `{ id: hidden-session, name: 'dsh-hidden-session', disabled: true }`。

---

## 3. 使用

1. 侧边栏会话行右侧出现「⋯」→ 点击 **隐藏会话**（或行尾悬停按钮）。
2. 该行立刻从侧边栏消失；底部弹出一条提示。
3. 恢复：**设置 → 隐藏会话**（`settings.section` 注册的是一级设置导航条目）→ 「恢复」/「全部恢复」。
4. 开关「同时抑制搜索结果中的隐藏会话」可控制搜索面板是否也过滤（默认开启，记在本浏览器）。

---

## 4. 自检

### 4.1 清单自检（不需要装进 DSH，随时可跑）

```bash
npm run check        # = node scripts/check-manifest.mjs
```

校验的是加载管线的硬性要求，而不是风格：`dsh.client.platform === "web"`、
`exports["./client"]` 与 `dsh.bundle.patch` 是否指向**真实存在**的文件、
浏览器半注册的模块 id 是否**等于包名**、patch 是否引用了包名。
CI（`.github/workflows/check.yml`）跑的就是 `node --check` 全量语法 + 这个脚本，本地与 CI 同一份代码。

### 4.2 宿主半端到端自检（插件已装好并在运行）

```bash
node scripts/smoke.mjs                        # 默认 http://127.0.0.1:3080
node scripts/smoke.mjs 19387                  # 桌面端的实际端口（见 GUI 地址栏）
node scripts/smoke.mjs http://127.0.0.1:19387
```

脚本只用一个假 id 做增删，并在结束时还原运行前的隐藏集合；`/show-all` 仅在运行前
集合为空时才测试，不会抹掉你真实的列表。它覆盖不到浏览器半（菜单项 / CSS 隐藏 /
设置页面），那部分需要人工点一遍（第 3 节）。

### 4.3 仓库里的排查工具（只读）

| 文件 | 用途 |
| --- | --- |
| [tools/asar-peek.mjs](tools/asar-peek.mjs) | 直接读取 `app.asar` 里的**运行中**源码/类型，用来核对真实构建的 DOM 与 slot 契约 |
| [tools/graph-peek.mjs](tools/graph-peek.mjs) | 连 `dsh-client-hmr` 的 SSE（`/plugins/events`）读**运行中**的客户端插件图，确认某插件的浏览器半是否已注册 |

```bash
# 运行构建里会话行的 DOM 锚点
node tools/asar-peek.mjs "<安装目录>\resources\app.asar" \
  "dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js" "data-row-key"
# 浏览器半是否在图里
node tools/graph-peek.mjs http://127.0.0.1:19387/plugins/events dsh-hidden-session
```

这两个工具对**任何** DSH 插件作者都有用：本插件的契约不是照抄文档，而是用它们从运行中的
构建里逐条核对出来的（见第 7 节）。

---

## 5. 已知限制（诚实清单）

1. **搜索结果抑制靠标题节点精确匹配**：搜索面板的结果行不在 slot 契约内（没有
   `data-row-key`），所以按「行内标题 span 的**自身文本**恰好等于某个隐藏会话标题」隐藏
   ——不会像前缀匹配那样连带隐藏「以该标题开头」的其它会话。标题比对是启发式的：
   会话摘要尚未加载到客户端时匹配不到（此时宁可不隐藏，失败方向是安全的）。
2. **分组计数不变**：分组头的会话数与「展开其余」配额由核心包派生，隐藏后仍计入。
   隐藏的是行，不是计数。
3. **隐藏当前打开的会话不会关闭对话**：对话保持打开（提示里也有说明），
   这与「归档当前会话并清空选择」的核心行为不同 —— 本插件不调用归档 RPC。
4. **不影响其它入口**：已归档筛选、Workspace 切换器、内容搜索的**服务端**命中不受影响；
   本插件只改侧边栏行的可见性。
5. **依赖 DOM 契约**：`data-row-key="session:<id>"` 是 ui-workspace 的稳定实现细节，
   若上游改版需同步更新 `lib/client.js` 中的 `SESSION_KEY_ATTR` / 选择器。
6. **文案语言**：客户端 `apply` 注入 `['slots','sessions','locale']`，优先按宿主 locale
   （`ctx.locale.getSnapshot().active`）选 zh/en，取不到时回退 `navigator.language`。
   未走 `ctx.locale` 的字典注册（`register()` 的两参/三参两种签名在已装插件里都存在，
   为了不在未验证版本上炸掉而自带文案表）；代价是**切语言后需要刷新页面**才更新。

---

## 6. 卸载与回滚

```bash
dsh plugin --profile web remove dsh-hidden-session
```

并确认 `dsh.profile.bundles` 中已无该行，然后重启 DSH。

- 隐藏集合本身在 `~/.dsh/storages/dsh-hidden-session.json`；删掉它等同于「全部恢复」。
- 卸载后所有会话立即回到侧边栏（隐藏从未改动会话数据，无需数据回滚）。

---

## 7. 兼容性与验证状态

### 已在运行中的构建上实测（DSH 0.2.0-rc.2 · Electron 桌面版 · profile `desktop`）

- `node --check` 通过：`lib/index.js`、`lib/client.js`、`scripts/smoke.mjs`（Node v24.11.1）。
- `scripts/smoke.mjs` **9/9 通过**：`GET /state` 200、`POST /hide` 落盘并在重读后仍在、
  非法 id 被 400 拒绝、`POST /show` 移除、`POST /show-all` 200。
- **浏览器半已注册**：从 `dsh-client-hmr` 的 SSE（`/plugins/events`）读到运行中的客户端插件图，
  72 项里含 `dsh-hidden-session`（rev `099b9b6071bf`）。
- **免重启装载已验证**：走第 2 节的「路径 B」（profile patch 层）插入行后，运行中的应用即时
  加载了宿主半与浏览器半，无需重启。
- 行 DOM 与判据**直接取自运行中的 `app.asar`**，不是照抄旧版本：
  `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
  - `1592: "data-row-key": \`session:${node.id}\`` ← 隐藏规则的锚点
  - `1729: clone.removeAttribute("data-row-key")` ← 退出克隆仍存在，故需要属性规则兜底
  - `1803: readPositions()` 只读 `getBoundingClientRect()`，零尺寸行不会抛错
  - `1502` 搜索结果行 `role:"treeitem"` 且**无** `data-row-key` ← 抑制逻辑的作用域安全
  - `106/260/2319/2651/2746/2827: retainedBy.mainView` ← 当前会话判定的权威写法

### 静态结论（未随运行构建变化）

- 契约依据：`@deepseek-ai/dsh-client-ui-workspace`（slot 契约 `contract/slots.d.ts`、行渲染）与
  `@deepseek-ai/dsh-host-webserver`（`register({kind:'exact',path,handler})`）。
  `dsh.engines.dsh` 标记为 `>=0.1.1-rc.1`（仅为文档性标注，见下）。
- **路由可达性**：`dsh-host-webserver` 的 `match()` 是「先查 exact 表，未命中再按最长前缀」；
  `dsh-client-connection` 的 `/api` 是 **prefix** 路由并在内部做 token 鉴权。因此本插件的
  exact 路由优先命中、**不在 RPC 桥的鉴权之后**——这正是宿主半必须自带 loopback + 同源校验
  的原因（第 1.4 节），也是 `scripts/smoke.mjs` 能不带 cookie 直接跑通的原因。
- **`insert` 不去重**（`dsh-app-boot` 的 `applyEntryPatches`）：这是第 2 节「两条路径不能同时用」
  的根源；宿主半已做幂等注册防护。
- **改动生效边界**：包已启用后，只改 `lib/client.js` 会被宿主 500ms 的 stat 轮询捕获并
  **原地热换**（不用刷新、不用重启、也不需要 `pnpm run dev:web`）；改 `package.json` 的
  `dsh.client.*`/`exports`、改包内 `cordis.patch.yml`、改 `dsh.profile.bundles`、或改宿主半
  `lib/index.js`，**都必须重启宿主**（profile 自己的 `cordis.patch.yml` 例外，它热重载）。
  热换失败不回滚（旧 fiber 已拆），此时刷新页面即可回到干净状态。
- **`dsh.engines.dsh` 只是元数据**：不被消费；真正的兼容门是 `peerDependencies` 里的
  `@deepseek-ai/dsh*` 约束（本包没有声明任何依赖，因此不会被版本门拦下）。
- **两种 inject 不是一回事**：`package.json` 的 `dsh.client.inject` 是**包名列表**，只影响
  client bundle 的到达/预取顺序（未知名字会被静默跳过，所以把 `dsh-client-ui-slots`
  这种 web shell 的 seed 模块写进去也无害）；`lib/client.js` 里的
  `exports.inject = ['slots','sessions','locale']` 才是 cordis **服务**注入声明。

### 仍需人工确认的一项

浏览器半是否**执行成功**（而不只是被注册）只能看界面：会话行「⋯」菜单里应出现「隐藏会话」，
设置导航里应出现「隐藏会话」条目。若没有，先刷新页面（Ctrl+R）；仍没有就看浏览器控制台报错
——客户端插件 `apply` 抛错只会影响它自己，不会拖垮界面。
接口侧可直接验证：`curl http://127.0.0.1:<port>/api/dsh-hidden-session/state`。

## 8. 许可证

MIT
