# 服务端到底校验什么（实测）

> 全部结论来自在真实 Conductor 服务端逐条打 `POST /api/metadata/workflow/validate` 的结果。
> 该端点返回 **200（空 body）= 合法**，**400 + `{"validationErrors":[...]}` = 非法**，且**不会落库**。
> 复现：`conductor-validate server workflow.json --server http://localhost:8080/api`

## 1. 会 400 的（注册期直接拒绝）

| 触发条件 | server 报错 |
|---|---|
| `workflow.name` 为空 | `WorkflowDef name cannot be null or empty` |
| `workflow.tasks` 为空数组 | `WorkflowTask list cannot be empty` |
| `schemaVersion` ≠ 2（`1` 也不行） | `workflowDef schemaVersion: 2 is only supported` |
| 任务的 `name` 为空 | `WorkflowTask name cannot be empty or null` |
| 任务的 `taskReferenceName` 为空 | `WorkflowTask taskReferenceName name cannot be empty or null` |
| `taskReferenceName` 重复（**递归，含 `loopOver` 内部**） | `taskReferenceName: X should be unique across tasks...` |
| SWITCH 缺 `evaluatorType` | `evaluatorType field is required for taskType: SWITCH` |
| SWITCH 缺 `expression` | `expression field is required for taskType: SWITCH` |
| SWITCH 的 `decisionCases` 为空 | `decisionCases should have atleast one task for taskType: SWITCH` |
| SWITCH/DECISION 的 JS 表达式语法错误 | `Expression is not well formatted: SyntaxError...` |
| DECISION 既无 `caseValueParam` 也无 `caseExpression` | `caseValueParam or caseExpression field is required` |
| EVENT 缺 `sink` | `sink field is required for taskType: EVENT` |
| DYNAMIC 缺 `dynamicTaskNameParam` | `dynamicTaskNameParam field is required for taskType: DYNAMIC` |
| FORK_JOIN 的 `forkTasks` 为空 | `forkTasks should have atleast one task for taskType: FORK_JOIN` |
| FORK_JOIN_DYNAMIC 三个选项一个都没给 | `dynamicForkTasksParam field is required for taskType: FORK_JOIN_DYNAMIC` |
| FORK_JOIN_DYNAMIC 同时给了互斥的两组 | `dynamicForkJoinTasksParam or combination of dynamicForkTasksInputParamName and dynamicForkTasksParam cam be used` |
| TERMINATE `optional: true` | `terminate task cannot be optional` |
| TERMINATE 缺 `terminationStatus`（**注意：不是 `status`**） | `terminate task must have an terminationStatus parameter and must be set to COMPLETED or FAILED` |
| TERMINATE 的 `terminationStatus` 不是 COMPLETED/FAILED | 同上 |
| DO_WHILE 缺 `loopCondition` | `loopCondition field is required for taskType: DO_WHILE` |
| SUB_WORKFLOW 缺 `subWorkflowParam` | `subWorkflowParam field is required for taskType: SUB_WORKFLOW` |
| HTTP 既无 `http_request` 也无 `uri` | `inputParameters.http_request or inputParameters.uri field is required` |
| KAFKA_PUBLISH 缺 `kafka_request` | `inputParameters.kafka_request field is required` |
| JSON_JQ_TRANSFORM 缺 `queryExpression` | `inputParameters.queryExpression field is required` |
| WAIT 同时给 `duration` 和 `until` | `Both 'duration' and 'until' specified. Please provide only one input` |
| WAIT 的 `duration` 格式非法（如 `PT10S`） | `Either date or duration is passed as null` |
| WAIT 的 `until` 格式非法（如 `2030-01-01T00:00:00Z`） | 同上 |
| `decisionCases` / `defaultCase` / `forkTasks` 里嵌套任务的 `name` 为空 | `tasks[0].decisionCases[c].<map value>[0].name: WorkflowTask name cannot be empty or null` |

## 2. 放行但运行期会挂的（server 的盲区）

| 触发条件 | 运行期表现 |
|---|---|
| FORK_JOIN 后面没有紧跟 JOIN | `TerminateWorkflowException` → **整个工作流失败** |
| JOIN 的 `joinOn` 少写 | **提前放行**（数据竞争） |
| JOIN 的 `joinOn` 多写 / 写错 | JOIN **永久挂起** |
| SWITCH `value-param` 的 `expression` 不在 `inputParameters` 里 | 求值为 `null` → 分支被跳过 |
| SWITCH `javascript` 写 `$.workflow.input.x` | `undefined` → **工作流 FAILED** |
| DYNAMIC 的 `dynamicTaskNameParam` 不在 `inputParameters` 里 | 任务名解析为 null → 失败 |
| EXCLUSIVE_JOIN 缺 `defaultExclusiveJoinTask` | 运行期行为不确定 |
| WAIT 既不给 `duration` 也不给 `until` | 运行期任务失败 |
| TERMINATE 之后还有任务 | 后续任务**静默不执行** |
| JSON 里字段名拼错（如 `inputParameterz`） | **静默丢弃**，参数丢失 |
| `loopOver` 循环体里的任务缺 `name` / `taskReferenceName` | server 不校验（`loopOver` 没有 `@Valid`）→ 运行期行为不确定 |

## 3. 嵌套校验的覆盖范围

`WorkflowDef.tasks` 是 `List<@Valid WorkflowTask>`，`WorkflowTask` 的容器字段注解如下：

| 容器 | 有 `@Valid`？ | server 会校验内部任务？ |
|---|---|---|
| `decisionCases` | ✅ | ✅ |
| `defaultCase` | ✅ | ✅ |
| `forkTasks` | ✅ | ✅ |
| `loopOver` | ❌ | ❌ **唯一盲区** |

也就是说：**除循环体外，server 会递归校验嵌套任务的必填字段**；循环体内部只能靠自己（或本工具）。

## 4. 相关的服务端源码位置

| 事实 | 位置 |
|---|---|
| `POST /metadata/workflow/validate` 端点 | `core/.../api/MetadataServiceImpl.java` → `core/.../service/MetadataServiceImpl.java` |
| 类型级必填字段 | `core/.../validations/WorkflowTaskTypeConstraint.java` |
| 约束挂载（XML 方式，所以 `@WorkflowTaskTypeConstraint` 在类上看不到） | `core/src/main/resources/META-INF/validation/constraints.xml` |
| `WorkflowDef` 的 Bean Validation | `common/.../metadata/workflow/WorkflowDef.java`（`@NotEmpty` / `@Min(2)` `@Max(2)`） |
| `WorkflowTask` 的 Bean Validation 与容器 `@Valid` | `common/.../metadata/workflow/WorkflowTask.java` |
| WAIT 的日期/时长解析 | `core/.../utils/DateTimeUtils.java` |
| SWITCH 的 `value-param` 求值（取 input map 的 key） | `core/.../execution/mapper/SwitchTaskMapper.java` |
| DECISION 的 `caseValueParam` 求值 | `core/.../execution/mapper/DecisionTaskMapper.java` |
| GraalJS 的 `$` 绑定 | `core/.../events/ScriptEvaluator.java`（`jsBindings.putMember("$", input)`） |
| 任务 input map 的构造（`workflow` key 从哪来） | `core/.../core/utils/ParametersUtils.java`（`getTaskInputV2`） |
