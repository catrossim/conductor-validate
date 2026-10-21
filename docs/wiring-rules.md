# 节点串联与用法规则（Wiring Rules）

> 回答"节点怎么串、每种节点怎么用、哪些写法 server 不拦但运行时会挂"。
> 本文件是 `conductor-validate` 的规则手册：每条规则的 ID 与工具输出**一一对应**。
>
> 配套工具：`npm install -g conductor-validate` → `conductor-validate workflow.json`
> （`--format json|github|sarif`，`conductor-validate rules` 查看规则清单）。
>
> 来源：`conductor/core/.../execution/mapper/*`、`DeciderService.java`、
> `conductor/common/.../metadata/workflow/WorkflowDef.java` + `WorkflowTask.java`、
> `conductor/core/.../validations/WorkflowTaskTypeConstraint.java`、
> `conductor/core/.../utils/DateTimeUtils.java`。
>
> 标注约定：**「server 400」** = 注册期/validate 端点直接拒绝；**「server 放行」** = 注册通过但运行期会挂。

---

## 0. 心智模型：没有"连线"

工作流是**有序嵌套树**，执行时"下一个任务"由 `WorkflowDef.getNextTask(refName)`（`WorkflowDef.java:428`）算出：

> **下一个任务 = 同一层列表里的下一个兄弟；容器内的分支/循环体结束后，跨到该容器在父层的后继。**

四种结构：

| 结构 | 字段 | 语义 |
|---|---|---|
| 顶层链 | `tasks[]` | 串行依次执行 |
| 分支容器 | `decisionCases: {case: [tasks]}` / `defaultCase: [tasks]` | SWITCH / DECISION 的分支 |
| 并行容器 | `forkTasks: [[tasks], [tasks]]` | FORK_JOIN 的并行分支 |
| 循环容器 | `loopOver: [tasks]` | DO_WHILE 的循环体 |

由此推出三条硬规则：

1. **同层串行**：`tasks[]` 第 N 个完成后自动执行第 N+1 个，**不需要任何连线声明**。
2. **容器边界**：`decisionCases` / `forkTasks` / `loopOver` 里的任务是**子流程**，与父层同层的兄弟之间**没有隐式顺序**。
3. **汇聚点（逐层上浮）**：
   - SWITCH/DECISION 分支末 → **它所在那一层**的下一个兄弟；本层没有则再上浮一层，直到顶层。
   - FORK_JOIN 分支末 → 紧随其后的 JOIN（在它自己那一层）。
   - DO_WHILE 循环体末 → DO_WHILE 自己（重评 `loopCondition`）。

`getNextTask` 分支对照：

| 目标位置 | 后继 | 源码 |
|---|---|---|
| 目标是 TERMINATE | `null`（工作流终止） | `WorkflowDef.java:430` |
| 同层链里 | 同层下一个兄弟；本层没有则**逐层上浮** | `WorkflowDef.java:455` |
| SWITCH/DECISION 分支里 | 分支内下一个兄弟；分支末尾 → 它所在层的下一个兄弟 | `WorkflowTask.java:686` |
| FORK_JOIN 分支里 | 分支内下一个兄弟；分支末尾 → 紧随 FORK_JOIN 的 JOIN | `WorkflowTask.java:715` |
| DO_WHILE 循环体最后一个 | DO_WHILE 自己（重评循环条件） | `WorkflowTask.java:705` |

> ⚠️ 常见误解："SWITCH 之后的顶层任务只有 default 分支才走" —— **错**。它是**所有分支的公共后继**。

---

## 1. 串联规则 W

| ID | 规则 |
|---|---|
| W1 | 顶层 `tasks[]` 是串行链，相邻任务自动顺序执行。不要用 `decisionCases` 表达"简单先后"。 |
| W2 | `taskReferenceName` **全工作流唯一**（含 `decisionCases`/`defaultCase`/`forkTasks`/`loopOver` 递归）。server 400 拦截。 |
| W3 | **FORK_JOIN 之后必须紧跟一个 JOIN**（同层的下一个兄弟）。否则 mapper 抛 `TerminateWorkflowException`，**整个工作流失败**。（`ForkJoinTaskMapper.java:98`） |
| W4 | **JOIN 的 `joinOn` 必须恰好覆盖每个 fork 分支的最后一个任务**。`joinOn` 不自动填充；少写 → 提前放行（数据竞争），多写/写错 → 对应任务永不被调度，JOIN **永久挂起**。**server 不校验**。 |
| W5 | 嵌套 FORK_JOIN 的 JOIN 必须是它**在外层分支内的下一个兄弟**（`WorkflowTask.java:736`）。 |
| W6 | SWITCH/DECISION 分支的末任务执行完后 → **该 SWITCH/DECISION 所在层**的下一个兄弟（顶层 SWITCH → 顶层链后继；嵌套 SWITCH → 外层 case 内的兄弟）。本层没有则**逐层上浮**到顶层。**不要**在分支里复制顶层的后继（会跑两次）。 |
| W7 | SWITCH/DECISION 有分支时自身不接顶层后继（决策完成时 `getNextTask` 返回空集合），分支跑完才由 W6 恢复链路。 |
| W8 | DO_WHILE 的 `loopOver` 是子流程：循环体末任务 → DO_WHILE 自己（重评条件）；循环退出 → DO_WHILE 之后的顶层任务。循环体内引用的任务属于循环层级。 |
| W9 | **TERMINATE 是终点**（`getNextTask` 对它返回 `null`）：之后的任务**永不执行**。TERMINATE 必须是链尾，且**不能** `optional: true`（`WorkflowTaskTypeConstraint.java:477`）。 |
| W10 | JOIN 完成后 → 顶层链上 JOIN 之后的下一个任务。 |
| W11 | EXCLUSIVE_JOIN 需要 `joinOn` + `defaultExclusiveJoinTask`，两者都靠用户显式声明，**server 不校验**。 |
| W12 | 同一层不得有两个相邻 JOIN —— 第二个永远不会被调度。 |
| W13 | `${ref.output.x}` 的 `ref` 必须是工作流内存在的 `taskReferenceName`。**server 只校验顶层 tasks 的引用**（`ConstraintParamUtil` 走 `workflow.getTasks()`），嵌套任务里的引用**不校验** → 需自检。 |
| W14 | 不要手工内联上游输出：任务输入 = 自身 `inputParameters` + 上游输出（以 refName 为 key）自动注入。`inputParameters` 的 key 与某个 refName 同名 → 疑似手工覆盖。 |
| W15 | **嵌套分支的汇聚点是"它在外层 case 列表里的下一个兄弟"**，不是顶层后继。写在外层 case 内、内层 SWITCH 之后的"公共后继"**只在该 case 路径上执行**；走别的外层 case 不会经过它。 |
| W16 | **不要在分支里复制顶层的后继** —— 分支末会回到顶层再跑一次顶层后继 → **执行两次**。公共后继只写在顶层。 |

---

## 2. 节点用法 G

字段细节见 conductor 官方文档。下表只列**规则**与**server 是否校验**。

> ✅ **server 列的含义**：该规则在**注册期**（`POST /metadata/workflow`）与
> `POST /metadata/workflow/validate` 会被拦（HTTP 400）。
> 类型级必填字段由 `WorkflowTaskTypeConstraint` 实现，它通过
> `core/src/main/resources/META-INF/validation/constraints.xml` 挂到 `WorkflowTask` 上，**已生效**。
> 实测：SWITCH 缺 `evaluatorType` / `expression`、TERMINATE 缺 `terminationStatus`、
> HTTP 缺 `http_request`、DO_WHILE 缺 `loopCondition` 等，**全部 400**。
>
> ⚠️ **唯一的 server 盲区**：`loopOver` 里的任务**没有** `@Valid` 注解
> （而 `decisionCases` / `defaultCase` / `forkTasks` 都有），所以**循环体内部的任务不会被 server 校验** ——
> 它们的必填字段、嵌套结构都得自己保证。

| type | 规则 | server |
|---|---|---|
| SIMPLE / USER_DEFINED | `name`、`taskReferenceName` 非空；需要能解析到 TaskDef（内联 `taskDefinition` 或服务端已注册同名 TaskDef）。`optional: true` → 失败被跳过；`permissive: true` → 失败也继续 | 前两项 ✅，TaskDef ❌ |
| DYNAMIC | `dynamicTaskNameParam` 非空，且必须是 `inputParameters` 里的**字面 key**（引擎 `taskInput.get(key)` 取任务名，key **不做** `${}` 替换；指向上游 refName 只会取到整张上游结果 map）。该 key 的值必须是非空字符串。解析出的名字必须是已注册 TaskDef | 必填 ✅，key 存在 ❌ |
| FORK_JOIN | `forkTasks` 非空；同层下一个兄弟必须是 JOIN（W3）；JOIN 的 `joinOn` 覆盖每分支末任务（W4）。分支数建议 ≤ 10 | 非空 ✅，其余 ❌ |
| FORK_JOIN_DYNAMIC | **三选一**：`inputParameters.forkTaskInputs` / `dynamicForkJoinTasksParam` / (`dynamicForkTasksParam` **且** `dynamicForkTasksInputParamName`)。前两者与后两者**互斥**。`forkTaskInputs` 元素形如 `{"task": "<TaskDef name>", "input": {...}}` | ✅ 全部校验 |
| SWITCH | `evaluatorType` + `expression` + 非空 `decisionCases`（key = case 名）。**`value-param`：`expression` 是该任务 `inputParameters` 里的 key 名**（求值 = `taskInput.get(expression)`）——**不是**表达式模板，要引工作流入参得配 `inputParameters: {"pick": "${workflow.input.pick}"}`。**`javascript`：`$` = 该任务自己的 input map**，脚本写 `$.<key>`（`$.workflow.input.x` 是 INLINE / DO_WHILE 的形态）。建议配 `defaultCase` 兜底 | 前三项 ✅，其余 ❌ |
| DECISION | `caseValueParam` 或 `caseExpression` 二选一 + 非空 `decisionCases`。**已废弃**（相关字段均 `@Deprecated`）→ 新工作流用 SWITCH | ✅ / WARN |
| JOIN | `joinOn` 非空；每个 ref 都存在且是某分支末任务。输出 = `{refName: 该任务输出}`，下游用 `${join_ref.output.<branch_ref>.x}`。`joinOn` 任务失败且非 optional → JOIN 失败 → 整链失败 | 全部 ❌（JOIN 不在类型约束覆盖范围内） |
| EXCLUSIVE_JOIN | `joinOn` + `defaultExclusiveJoinTask` 非空 | ❌ |
| DO_WHILE | `loopCondition` + 非空 `loopOver`。`loopCondition` 是 GraalJS boolean；读循环外变量用 `$.workflow.input.x`，读上一轮输出用 `$.<ref>.output.x`。**必须**有迭代上限/退出保护 | 必填 ✅，保护 ❌ |
| SUB_WORKFLOW | `subWorkflowParam` 非空，`name` 非空，`version` ≥ 1（不填取最新）。`taskToDomain` 路由子流程任务到不同 worker 域。**父流程等待子流程完成**，子流程失败 → 父任务失败（除非 `optional: true`）。子流程输出用 `${sub_ref.output.x}` 取 | 必填 ✅，name ❌ |
| START_WORKFLOW | `inputParameters.startWorkflow` 必须是对象（`StartWorkflowRequest`：`name`/`version`/`workflowInput`/`taskToDomain`/`correlationId`/`priority`），`name` 非空。**不等待**子流程：父任务立刻 COMPLETED，输出 `{"workflowId": "<child id>"}`。要等结果请用 SUB_WORKFLOW | ❌ |
| EVENT | `sink` 非空。**异步**：工作流挂起，等外部推入 payload；后续任务用 `${event_ref.output.payload}` 取 | `sink` ✅ |
| WAIT | `duration` 与 `until` **二选一**（都给 → server 400；都不给 → server 放行但运行期失败）。`duration` 用 `10 seconds` / `5m` / `1 hour 30 minutes` 这类写法（`DateTimeUtils.DURATION_PATTERN`，**不支持 ISO-8601 的 `PT10S`**）；`until` 用 `yyyy-MM-dd` 或 `yyyy-MM-dd HH:mm`（可带时区），**不支持 `2030-01-01T00:00:00Z`**。`${...}` 形式 server 跳过检查 | 二选一 ✅，格式 ✅ |
| HTTP | **三选一**：`inputParameters.http_request` / `inputParameters.uri`(+`method`) / TaskDef 的 `inputTemplate.http_request`。`http_request` 内 `method` + `uri` 必填，`uri` 支持 `${...}`。重试/超时配在 **TaskDef** 上 | 三选一 ✅ |
| KAFKA_PUBLISH | `inputParameters.kafka_request` 或 TaskDef `inputTemplate.kafka_request` 二选一。`kafka_request` 需 `topic`/`key`/`value` | ✅ |
| JSON_JQ_TRANSFORM | `inputParameters.queryExpression` 或 TaskDef `inputTemplate.queryExpression`。输出是**数组**，下游用 `[0]` 取第一个元素 | ✅ |
| TERMINATE | 不能 `optional: true`；`inputParameters.terminationStatus` ∈ {`COMPLETED`,`FAILED`}（**参数名是 `terminationStatus`，不是 `status`**）；之后无后继（W9）；终止后 `workflow.output` 只保留终止前设置的值 | ✅ |
| NOOP / SET_VARIABLE / LAMBDA / INLINE | NOOP 占位；SET_VARIABLE 写 `${workflow.variables.x}` 供后续读；LAMBDA/INLINE 是**脚本任务**，`${...}` 语义与普通任务不同（见 §3 的 D8） | — |

---

## 3. 数据流 D

| ID | 规则 |
|---|---|
| D1 | 语法 `${path.to.value}`，`$${...}` 是转义（输出字面量 `${`）。占位符可出现在任意字符串值里。 |
| D2 | 作用域白名单：`workflow.{input,output,status,workflowId,parentWorkflowId,parentWorkflowTaskId,workflowType,version,correlationId,reasonForIncompletion,schemaVersion}`、`workflow.{variables,env,secrets}.*`；以及 `<refName>.{input,output,status,taskType,referenceTaskName,retryCount,correlationId,pollCount,taskDefName,scheduledTime,startTime,endTime,workflowInstanceId,taskId,reasonForIncompletion,callbackAfterSeconds,workerId,iteration}`。其余一律非法。（`ParametersUtils.java:100-200`） |
| D3 | `${ref...}` 用的是 **`taskReferenceName`**，不是任务 `name`。两个任务可能同名不同引用名。 |
| D4 | 被引用的 refName 必须在工作流内存在。server 只查顶层 tasks（W13），**嵌套任务里的引用不校验** → 自检要全量。 |
| D5 | 任务的输出**不会**自动进入 `workflow.output`；需在 WorkflowDef 的 `outputParameters` 里写 `"${ref.output.key}"`，或任务显式写 `workflow.output`。⚠️ `outputParameters` 的类型是 **`Map<String,Object>`**（`WorkflowDef.java:61`）—— **value 才是被替换的表达式**，key 只是输出字段名（旧的 `List<String>` 形态已不是当前服务端格式）。 |
| D6 | `${ref.output.x}` 只能引用**本工作流内**的任务；跨工作流用 SUB_WORKFLOW / START_WORKFLOW。 |
| D7 | `workflow.env.*` 在**注册期**就被校验：环境变量不存在直接 400（`ConstraintParamUtil` → `EnvUtils.isEnvironmentVariable`）。离线 lint 应降级为 WARN。 |
| D8 | GraalJS 表达式用 `$.` 而非 `${}`（`${}` 是引擎占位符替换，混用会静默拿到 `undefined`）。**`$` 绑的是"该任务自己的 input map"**（`ScriptEvaluator`：`jsBindings.putMember("$", input)`），所以：<br>· **SWITCH / DECISION**：`$` = 该任务的 `inputParameters` 解析后的 map → 只能写 `$.<你在 inputParameters 里定义的 key>`；**不存在 `$.workflow`**（写成 `$.workflow.input.x` 会得到 `undefined`，工作流直接 FAILED）。<br>· **INLINE / DO_WHILE / LAMBDA**：`$` = 完整任务 input map，里面**有** `workflow` key（`ParametersUtils.getTaskInputV2` 放入 `inputMap["workflow"]`）→ `$.workflow.input.x` 可用；读上一轮输出用 `$.<ref>.output.x`。<br>· **JSON_JQ_TRANSFORM** 的 `queryExpression` 是 JQ 表达式，**不是** JS，语法完全不同。 |

---

## 4. Server 校验 vs 自检

> 下表是**在真实 Conductor 服务端逐条实测**的结果（`POST /api/metadata/workflow/validate`）。

| 类别 | 注册期（400） | 不校验 → 运行期表现 |
|---|---|---|
| 定义级必填（name / tasks / schemaVersion） | ✅ | — |
| 各类型必填字段（`WorkflowTaskTypeConstraint`，覆盖 SWITCH / DECISION / EVENT / DYNAMIC / FORK_JOIN / FORK_JOIN_DYNAMIC / HTTP / KAFKA_PUBLISH / JSON_JQ_TRANSFORM / DO_WHILE / SUB_WORKFLOW / TERMINATE / WAIT） | ✅ | — |
| 引用名唯一（**递归，含 loopOver 内部**） | ✅ | — |
| 嵌套任务的 `name` 非空 | ✅（`decisionCases` / `defaultCase` / `forkTasks` 有 `@Valid`） | ⚠️ **`loopOver` 内部没有 `@Valid` → 循环体任务完全不被 server 校验** |
| `${}` 引用存在 | ⚠️ **只校验顶层 tasks** | 嵌套任务里引用错 → 运行期拿到 `null` |
| FORK_JOIN 后必须有 JOIN（W3） | ❌ | `TerminateWorkflowException`，**整个工作流失败** |
| JOIN 的 `joinOn` 正确（W4） | ❌ | 提前放行 / **永久挂起** |
| TERMINATE 在链尾（W9） | ❌ | 后续任务**静默不执行** |
| 嵌套 FORK_JOIN 的 JOIN 位置（W5） | ❌ | 同 W3，工作流失败 |
| `dynamicTaskNameParam` 在 inputParameters 里 | ❌ | 任务名解析为 null → 失败 |
| SWITCH `value-param` 的 `expression` 在 inputParameters 里 | ❌ | 求值为 `null` → 分支被跳过 |
| SWITCH `javascript` 表达式的语义 | ❌（只查语法） | `$.workflow` 之类写错 → 运行期 FAILED |
| 脚本表达式语义 | ❌（只查语法） | 运行期才炸 |
| JSON 里拼错的字段名 | ❌（`FAIL_ON_UNKNOWN_PROPERTIES=false`） | **静默丢弃**，参数丢失 |
| WAIT 只给一个 / 都不给 | 只给两个 → ✅ 400；都不给 → ❌ 放行 | 运行期任务失败 |

### 4.1 S 规则：server 400 的镜像

server 对**定义本身**做 Bean Validation（`WorkflowDef` / `WorkflowTask` 上的注解 + `WorkflowTaskTypeConstraint`），这几条在注册期与 `POST /metadata/workflow/validate` 都会 **400**。工具用 `S1`-`S4` 镜像它们，保证「lint 通过 = 一定注册得上」：

| ID | 规则 | server 约束 |
|---|---|---|
| S1 | `tasks` 不能为空（且必须是数组） | `WorkflowDef.tasks` `@NotEmpty` |
| S2 | 每个任务都要有 `name` | `WorkflowTask.name` `@NotEmpty` |
| S3 | `schemaVersion` **恰好是 2** | `WorkflowDef.schemaVersion` `@Min(2) @Max(2)`（实测 `1` 也被拒） |
| S4 | 工作流要有 `name` | `WorkflowDef.name` `@NotEmpty` |

> `taskReferenceName` 非空同样由 server 强制，但已由 `W2` 覆盖。
> 另外 server 还会拦两件 lint 离线管不了的事：`ownerEmail`（`conductor.app.workflow.owner-email-mandatory=true` 时必填）、`conductor.app.workflow.name-validation.enabled=true` 时的**名称字符集**（默认关闭）。
>
> 💡 想要**与服务端完全一致**的结论，直接用 `conductor-validate server workflow.json --server http://localhost:8080/api`：
> 它调的就是 `POST /metadata/workflow/validate`，服务端返回的 `validationErrors` 会原样列出来（不落库）。

---

## 5. 规则速查

完整清单：`conductor-validate rules`（或 `conductor-validate rules --format json`），ID 与 §1/§2/§3 一致。
严重级别：`CRITICAL`（server 400 或运行期必然失败）> `WARN`（多半会踩坑）> `INFO`（行为说明）。

---

## 6. 骨架示例

**并行 + JOIN**（JOIN 紧跟 FORK_JOIN，`joinOn` 是各分支末任务）
```jsonc
"tasks": [
  { "name": "fanout", "taskReferenceName": "fan_ref", "type": "FORK_JOIN",
    "forkTasks": [
      [ { "name": "a", "taskReferenceName": "a_ref", "type": "SIMPLE" } ],
      [ { "name": "b", "taskReferenceName": "b_ref", "type": "SIMPLE" } ]
    ] },
  { "name": "gather", "taskReferenceName": "gather_ref", "type": "JOIN",
    "joinOn": ["a_ref", "b_ref"] }
]
```

**分支 + 公共后继**：`after` 是所有 case 的公共后继，只写在顶层。
SWITCH 的 `value-param` 模式下 `expression` 是**任务 `inputParameters` 里的 key 名**
（不是表达式模板）；`javascript` 模式下 `$` = 该任务自己的 input map（`$.<key>`）。
```jsonc
{ "name": "route", "taskReferenceName": "route_ref", "type": "SWITCH",
  "evaluatorType": "value-param", "expression": "tier",
  "inputParameters": { "tier": "${workflow.input.tier}" },
  "decisionCases": {
    "vip":    [ { "name": "vip_call", "taskReferenceName": "vip_ref", "type": "SIMPLE" } ],
    "normal": [ { "name": "std_call", "taskReferenceName": "std_ref", "type": "SIMPLE" } ] } },
{ "name": "after", "taskReferenceName": "after_ref", "type": "SIMPLE" }
```

---

## 7. 交叉引用

规则手册（本文） ·
服务端校验说明 [server-validation.md](server-validation.md) ·
样例 `../examples/workflow_with_issues.json` ·
源码实现 `../src/core.ts`

---

## 8. 工具用法

```bash
# 离线校验（默认阈值：只报 CRITICAL）
conductor-validate workflow.json
conductor-validate workflow.json --severity WARN        # 连 WARN 一起报
conductor-validate workflow.json --severity INFO        # 全部，含行为说明
conductor-validate a.json b.json --format json          # 多个文件
cat workflow.json | conductor-validate -                # 从 stdin 读
conductor-validate rules                                # 规则清单
conductor-validate rules --format json

# 对着真实服务端再校验一遍（不落库）
conductor-validate server workflow.json --server http://localhost:8080/api
export CONDUCTOR_SERVER_URL=http://localhost:8080/api
export CONDUCTOR_AUTH_TOKEN=<token>                    # 需要鉴权时
conductor-validate lint --name my_registered_workflow --server $CONDUCTOR_SERVER_URL
```

退出码：`0` = 干净，`1` = 有达到阈值的问题，`2` = 参数/IO 错误。

### CI 集成

**GitHub Actions**（用 `github` 格式直接打注释到 PR 上）：

```yaml
- run: npm install -g conductor-validate
- run: conductor-validate workflows/*.json --format github --severity WARN
```

**SARIF**（上传到 GitHub code scanning）：

```yaml
- run: conductor-validate workflows/*.json --format sarif > results.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

### 作为库使用

```ts
import { lintDefinition } from "conductor-validate";

for (const finding of lintDefinition(workflow)) {
  console.log(finding.severity, finding.rule, finding.path, finding.message);
}
```

