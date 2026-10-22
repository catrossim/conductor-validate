# Workflow Viewer

一个**独立**的纯前端工作流查看器：把 workflow 定义画成 DAG，并且**在浏览器里跑
conductor-validate 的规则**。不依赖后端、不依赖 npm 包构建产物之外的任何东西。

```bash
# 在 conductor-validate 项目根目录
npm install            # 只需要一次（用于编译校验内核）
npm run viewer         # 等价于 ./viewer/view.sh

./viewer/view.sh                          # 打开空界面，拖入自己的 JSON
./viewer/view.sh path/to/workflow.json    # 启动并直接加载
PORT=8080 ./viewer/view.sh                # 换端口（默认 5173）
```

服务地址：<http://127.0.0.1:5173/viewer/>

| 要求 | 说明 |
| --- | --- |
| Node 18+ | 只在**构建校验内核**时需要；打开页面本身不需要 Node |
| `python3` | `view.sh` 用它起静态服务（换成任何静态服务器也行） |
| 能访问 `esm.sh` | 页面里的 React / htm / orkes-workflow-visualizer 走 CDN，**首次打开需要联网** |

> `view.sh` 以 **conductor-validate 项目根目录** 为站点根，所以 `/viewer/` 和
> `/examples/` 都能访问到（示例里的 `workflow_with_issues.json` 就是在页面上
> 直接点「issues-demo」加载的）。用 `127.0.0.1` 而不是 `localhost`，避免本机代理。
>
> `viewer/vendor/` 是 gitignore 的构建产物。`view.sh` 启动时发现它缺失、或它比
> `src/core.ts` 旧，会自动重建——所以**新克隆的仓库第一次必须先 `npm install`**。

## 界面导览

页面分四块：

| 区域 | 说明 |
| --- | --- |
| 顶部工具栏 | 工作流名 · 版本 · 任务数；`✔ 校验`（带问题数徽标）、`规则`、`Mermaid`、`SVG`、`PNG`、`JSON` |
| 左侧任务列表 | 点任务即选中；带问题的任务显示问题数徽标（颜色=最高严重级别）；底部「换一个工作流」 |
| 中间画布 | 拖拽平移、滚轮以指针为锚点缩放、`−` / `+` / `适` 按钮、缩放百分比、`原始 JSON` 开关；顶部状态药丸显示节点数、边数、子工作流、校验结论 |
| 右侧检查面板 | 三个标签页：**属性** / **校验** / **规则**，可关闭 |

### 三个标签页

| 标签 | 说明 |
| --- | --- |
| **属性** | 选中任务的**全部字段**（对象/数组可展开成 JSON）、在定义中的路径、该节点命中的问题、`复制节点 JSON`；没选中任务时显示工作流级属性 |
| **校验** | 跑一遍 conductor-validate，按严重级别过滤，每条问题给出规则号、位置、说明、修复建议；`定位到节点` 把画布平移到出问题的任务并高亮 |
| **规则** | 全部 69 条规则的说明，可搜索（规则号 / 说明 / 级别）；带命中的规则会标出次数 |

加载工作流后会自动做一次**静默校验**（结果体现在左侧任务列表的徽标和顶部状态药丸上），
点顶部 `✔ 校验` 会打开校验结果面板。

### 把工作流喂进去（4 种方式）

| 方式 | 怎么做 |
| --- | --- |
| 命令行直接加载 | `./viewer/view.sh path/to/workflow.json`（文件会被复制成 `viewer/_user-workflow.json`，脚本退出时删除） |
| 拖文件 | 把 `.json` 拖到页面**任意位置**（左侧上传区也可以） |
| 粘贴 JSON | 左侧「粘贴 JSON 文本」→ `解析`；支持 `{ "workflowDef": { ... } }` 这类包裹形式 |
| 点示例 | 左侧示例 chip：`fork-join`、`do-while-loop`、`llm-chaining`、`weather-notification`、`agent-fork-specialists`、`issues-demo`（故意有问题）、`valid-demo`（合法） |

页面只要求 JSON 里有 `tasks` 数组，其余字段缺失不影响画图。

### 导出

| 按钮 | 产出 | 备注 |
| --- | --- | --- |
| `Mermaid` | `<name>.mermaid.md` | 流程图文本，同时尝试复制到剪贴板（浏览器策略禁用时只下载） |
| `SVG` | `<name>.svg` | 把 `<style>` 内联进 SVG，单独打开即可看 |
| `PNG` | `<name>.png` | 2 倍像素比导出当前画布 |
| `JSON` | `<name>.json` | 当前加载的定义，格式化输出（`JSON.stringify(wf, null, 2)`） |

文件名取工作流的 `name` 字段，没有就退化成 `workflow`。

### 典型用法

1. **定位结构问题**：加载定义 → 左侧任务列表看哪个任务带徽标 → `✔ 校验` → 点 `定位到节点` → 在 `属性` 标签里核对/改字段。
2. **给 PR 附流程图**：`Mermaid` 导出后贴进 PR 描述（GitHub 原生渲染 mermaid）。
3. **评审别人的定义**：拖 JSON 进去 → `规则` 标签对照规则说明 → 用 `原始 JSON` 开关核对字段。

### 页面不做的两件事

- **在线 server 校验**：页面只有离线规则（`src/core.ts`）。要问服务端自己的结论，仍需用 CLI：`conductor-validate server workflow.json --server http://localhost:8080/api`。
- **判断运行时行为**：它检查的是定义结构，不是工作流跑起来会怎样。

### 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `Address already in use` | 端口被占：`PORT=8080 ./viewer/view.sh` |
| `需要 python3 来提供静态服务` | 没装 python3；自己起静态服务器也行：`npx serve .`，然后打开 `/viewer/` |
| 页面空白、控制台报 `esm.sh` 加载失败 | CDN 不可达（离线环境）：需要能访问 esm.sh，或把 CDN 依赖换成本地副本 |
| 页面规则和 CLI 对不上 | 改了 `src/core.ts` 但没重编译：另开终端 `npm run dev:viewer`，或重启 `view.sh`（会自动重建过期产物） |
| 打开的是旧页面 | 浏览器缓存了 `viewer/vendor/*.js`：强制刷新（Cmd/Ctrl+Shift+R） |
| `npm install` 装不上 | 只需要 devDependencies（typescript / vitest / tsx）；只想构建内核的话 `npx -y tsc -p tsconfig.viewer.json` 就够 |
| 拖拽没反应 | 确认是 `.json` 文件；一次只认第一个文件 |

## 目录

```
viewer/
  index.html      importmap（react / htm / orkes-workflow-visualizer 走 CDN）+ 入口
  app.js          视图、缩放平移、属性/校验/规则面板、导出
  graph.js        把 workflow 定义解析成 DAG（边是它算的，路径不是）
  mermaid.js      workflow → mermaid
  styles.css
  samples/        演示用的 workflow
  vendor/         校验内核的浏览器编译产物（由 npm run build:viewer 生成，已 gitignore）
  view.sh         启动脚本
```

## 规则只有一套：页面 = CLI

页面的校验**不是**另写的一份实现，而是把 `src/core.ts` 编译成浏览器 ESM 后
直接跑：

```
src/core.ts ──tsc -p tsconfig.viewer.json──▶ viewer/vendor/core.js ──▶ 页面
     │                                              │
     └──────────────▶ CLI (src/cli.ts) ◀──────────┘
```

`src/core.ts` + `src/util.ts` 是纯函数、没有 I/O，所以能直接编译给浏览器用：

```bash
npm run build:viewer      # tsc -p tsconfig.viewer.json → viewer/vendor/*.js
```

`viewer/vendor/` 已 gitignore，只能由 `npm run build:viewer` 生成，不存在手改的可能。

**开发时怎么保证页面跑的不是旧内核：**

| 场景 | 机制 |
| --- | --- |
| `npm test` | `pretest` 先跑 `build:viewer`，测的永远是当前源码 |
| `./viewer/view.sh` 启动 | 产物缺失**或**源码比产物新 → 自动重建 |
| 改着 `src/core.ts`、服务已在跑 | 另开终端 `npm run dev:viewer`（`tsc --watch`），刷新页面即可 |

**页面不碰的三件事，一律由 conductor-validate 决定：**

| 关注点 | 谁说了算 | 页面怎么用 |
| --- | --- | --- |
| 规则（69 条）、严重级别、消息、修复建议 | `src/core.ts` | `lintDefinition(wf)` 拿结果 |
| 结构路径（`tasks[1].decisionCases.vip[0]`） | `Linter#nodes[].path` | 只负责显示；`graph.js` 用 task 对象身份去取 |
| 「这条问题属于哪个任务」 | `Linter#nodeForPath()` | 页面不再自己做前缀匹配 |
| 严重级别的排序 | `SEVERITY_ORDER` | 直接 import，不自己抄一份 |

`viewer/graph.js` 只负责**边**（画布拓扑）——那是布局的事，不是校验的事。
页面里唯一自己写的是中文文案（`严重/警告/提示`），级别本身仍来自 conductor-validate。

### 防止漂移

`tests/viewer-parity.test.ts` 把上面这些变成可执行的断言：

1. viewer 显示的每个路径，必须和 linter 的 canonical path **逐字相同**；
2. 每条 finding 都必须能通过 `Linter#nodeForPath()` 定位到 viewer 里的节点；
3. `viewer/vendor/core.js`（页面实际跑的产物）与 `src/core.ts` 对同一批工作流
   产出的结果**完全一致**（规则、级别、路径、消息、修复建议）；
4. `viewer/*.js` 里**不允许**出现规则号字面量，也不允许自带一份级别排序表
   —— 想在页面加规则，只能改 `src/core.ts`。

```bash
npm test            # 93 项，含 5 项一致性守卫
npm run test:viewer # 只跑一致性守卫
```

> 补充：conductor-validate 目前只下探到两层 `forkTasks`，三层 fork 里的任务
> 不会产生路径、也不参与校验——页面如实显示为「-」，不做二次推测。

## 另一个实现点：缩放/平移放在库外面

`orkes-workflow-visualizer` 内部把平移/缩放关掉了（`zoomable:false, pannable:false`），
而且每次渲染都会重写画布 `<g>` 的 `transform`。所以缩放和平移都作用在包在组件
外面的 `.graph-viewport` 容器上：平移量叠加在「居中 + 缩放」之上，库重绘时不会把
用户拖动的位置冲掉。

## 依赖

`index.html` 用 importmap 从 `esm.sh` 加载 `react@18.3.1`、`htm@3.1.1`、
`dom-to-image` 和 `orkes-workflow-visualizer@1.1.1`，因此没有打包步骤：
改完 `app.js` / `styles.css` 刷新页面即可。
