/**
 * Offline validation core for Conductor workflow definitions.
 *
 * This module is pure: it takes a parsed workflow definition and returns
 * findings. No file access, no network, no third-party imports.
 *
 * Three families of checks live here:
 *
 * `S*`
 *   Mirrors of the server-side bean validation, so a definition that passes
 *   the linter can be registered without a 400.
 * `W*` / `G-*`
 *   Structural rules the server does **not** enforce at registration time and
 *   that only fail — or hang — at runtime.
 * `D*`
 *   Data-flow rules: `${...}` placeholder syntax, scope whitelist, and
 *   dangling task references.
 *
 * The rule catalogue with source-level evidence lives in `docs/wiring-rules.md`.
 */

import type { JsonValue, WorkflowDefinition, WorkflowTask } from "./types.js";
import { asArray, asInt, asRecord, asString, asStringArray, fullMatch, pyListRepr } from "./util.js";

export type Severity = "CRITICAL" | "WARN" | "INFO";

export const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, WARN: 1, INFO: 2 };

export interface RuleDefinition {
  id: string;
  severity: Severity;
  description: string;
}

export const RULES: RuleDefinition[] = [
  { id: "W1", severity: "INFO", description: "顶层 tasks[] 是串行链，相邻任务自动顺序执行" },
  { id: "W2", severity: "CRITICAL", description: "taskReferenceName 必须全工作流唯一（含嵌套）" },
  { id: "W3", severity: "CRITICAL", description: "FORK_JOIN 之后必须紧跟一个 JOIN（同层的下一个兄弟）" },
  { id: "W4", severity: "CRITICAL", description: "JOIN.joinOn 必须恰好覆盖每个 fork 分支的最后一个任务" },
  { id: "W5", severity: "CRITICAL", description: "嵌套 FORK_JOIN 的 JOIN 必须是它在外层分支内的下一个兄弟" },
  { id: "W6", severity: "INFO", description: "SWITCH/DECISION 分支末任务执行完后回到顶层链上该节点的后继" },
  { id: "W7", severity: "INFO", description: "SWITCH/DECISION 有分支时自身不接顶层后继" },
  { id: "W8", severity: "INFO", description: "DO_WHILE.loopOver 是子流程，循环体末任务回到 DO_WHILE" },
  { id: "W9", severity: "CRITICAL", description: "TERMINATE 没有后继：必须非 optional，且其后不再有任务" },
  { id: "W10", severity: "INFO", description: "JOIN 完成后接顶层链的下一个任务" },
  { id: "W11", severity: "CRITICAL", description: "EXCLUSIVE_JOIN 需要 joinOn 与 defaultExclusiveJoinTask" },
  { id: "W12", severity: "WARN", description: "同一层不得出现两个相邻的 JOIN" },
  { id: "W13", severity: "CRITICAL", description: "${ref...} 的 ref 必须是工作流内存在的 taskReferenceName" },
  { id: "W14", severity: "WARN", description: "不要手工内联上游输出（inputParameters 的 key 与某个 refName 同名）" },
  { id: "W15", severity: "INFO", description: "嵌套分支的汇聚点是它在外层 case 列表里的下一个兄弟，不是顶层后继" },
  { id: "W16", severity: "WARN", description: "不要在分支里复制顶层的后继（分支末会回到顶层再跑一次 → 执行两次）" },
  { id: "S1", severity: "CRITICAL", description: "工作流 tasks 不能为空（server @NotEmpty，注册即 400）" },
  { id: "S2", severity: "CRITICAL", description: "每个任务都要有 name（server WorkflowTask.name @NotEmpty）" },
  { id: "S3", severity: "CRITICAL", description: "schemaVersion 当前服务端要求恰好为 2（@Min(2) @Max(2)）" },
  { id: "S4", severity: "CRITICAL", description: "工作流要有 name（server WorkflowDef.name @NotEmpty）" },
  { id: "G-SIMPLE-3", severity: "INFO", description: "SIMPLE/USER_DEFINED 建议内联 taskDefinition" },
  { id: "G-DYNAMIC-1", severity: "CRITICAL", description: "DYNAMIC 必须有 dynamicTaskNameParam" },
  { id: "G-DYNAMIC-2", severity: "CRITICAL", description: "dynamicTaskNameParam 必须是 inputParameters 里的字面 key，且值为非空字符串" },
  { id: "G-FORK-1", severity: "CRITICAL", description: "FORK_JOIN 的 forkTasks 不能为空" },
  { id: "G-FORK-4", severity: "WARN", description: "并行分支数建议 <= 10" },
  { id: "G-FORKDYN-1", severity: "CRITICAL", description: "FORK_JOIN_DYNAMIC 三选一：forkTaskInputs / dynamicForkJoinTasksParam / (dynamicForkTasksParam + dynamicForkTasksInputParamName)" },
  { id: "G-FORKDYN-2", severity: "CRITICAL", description: "dynamicForkJoinTasksParam 与 dynamicForkTasks* 互斥" },
  { id: "G-FORKDYN-3", severity: "WARN", description: "forkTaskInputs 元素形如 {\"task\": \"<TaskDef name>\", \"input\": {...}}" },
  { id: "G-SWITCH-1", severity: "CRITICAL", description: "SWITCH 必须有 evaluatorType" },
  { id: "G-SWITCH-2", severity: "CRITICAL", description: "SWITCH 必须有 expression" },
  { id: "G-SWITCH-3", severity: "CRITICAL", description: "SWITCH 必须有非空 decisionCases" },
  { id: "G-SWITCH-4", severity: "WARN", description: "javascript 表达式的语义不会被服务端校验（只查语法）" },
  { id: "G-SWITCH-5", severity: "WARN", description: "SWITCH 的 javascript 表达式里 $ 是该任务自己的 input map，不是 $.workflow" },
  { id: "G-SWITCH-6", severity: "WARN", description: "SWITCH 建议提供 defaultCase 兜底" },
  { id: "G-SWITCH-7", severity: "CRITICAL", description: "value-param 的 expression 必须是该任务 inputParameters 里的 key 名" },
  { id: "G-DECISION-1", severity: "CRITICAL", description: "DECISION 必须有 caseValueParam 或 caseExpression" },
  { id: "G-DECISION-2", severity: "CRITICAL", description: "DECISION 必须有非空 decisionCases" },
  { id: "G-DECISION-3", severity: "WARN", description: "DECISION 已废弃，新工作流请使用 SWITCH" },
  { id: "G-JOIN-1", severity: "CRITICAL", description: "JOIN 必须有 joinOn" },
  { id: "G-JOIN-2", severity: "CRITICAL", description: "joinOn 的每个 ref 都必须存在" },
  { id: "G-JOIN-3", severity: "INFO", description: "JOIN 输出形如 {refName: 该任务输出}" },
  { id: "G-EXCL-1", severity: "CRITICAL", description: "EXCLUSIVE_JOIN 必须有 joinOn" },
  { id: "G-EXCL-2", severity: "CRITICAL", description: "EXCLUSIVE_JOIN 必须有 defaultExclusiveJoinTask" },
  { id: "G-DOWHILE-1", severity: "CRITICAL", description: "DO_WHILE 必须有 loopCondition" },
  { id: "G-DOWHILE-2", severity: "CRITICAL", description: "DO_WHILE 必须有非空 loopOver" },
  { id: "G-DOWHILE-3", severity: "WARN", description: "DO_WHILE 建议提供迭代上限/退出保护" },
  { id: "G-SUBWF-1", severity: "CRITICAL", description: "SUB_WORKFLOW 必须有 subWorkflowParam" },
  { id: "G-SUBWF-2", severity: "CRITICAL", description: "subWorkflowParam.name 非空" },
  { id: "G-SUBWF-4", severity: "INFO", description: "SUB_WORKFLOW 等待子流程完成；fire-and-forget 请用 START_WORKFLOW" },
  { id: "G-STARTWF-1", severity: "CRITICAL", description: "START_WORKFLOW 需要 inputParameters.startWorkflow 对象" },
  { id: "G-STARTWF-2", severity: "CRITICAL", description: "startWorkflow.name 必须非空" },
  { id: "G-STARTWF-3", severity: "INFO", description: "START_WORKFLOW 不等待子流程，父任务立刻完成并输出 workflowId" },
  { id: "G-EVENT-1", severity: "CRITICAL", description: "EVENT 必须有 sink" },
  { id: "G-EVENT-2", severity: "INFO", description: "EVENT 是异步任务，工作流挂起直到外部推入 payload" },
  { id: "G-WAIT-1", severity: "CRITICAL", description: "WAIT 的 duration 与 until 只能二选一" },
  { id: "G-WAIT-2", severity: "CRITICAL", description: "WAIT 的 duration/until 字面量格式非法（server 会在注册期 400）" },
  { id: "G-WAIT-3", severity: "WARN", description: "WAIT 既没有 duration 也没有 until（server 放行，运行期会失败）" },
  { id: "G-HTTP-1", severity: "CRITICAL", description: "HTTP 需要 inputParameters.http_request / uri / TaskDef.inputTemplate.http_request" },
  { id: "G-KAFKA-1", severity: "CRITICAL", description: "KAFKA_PUBLISH 需要 inputParameters.kafka_request / TaskDef.inputTemplate.kafka_request" },
  { id: "G-JQ-1", severity: "CRITICAL", description: "JSON_JQ_TRANSFORM 需要 inputParameters.queryExpression / TaskDef.inputTemplate.queryExpression" },
  { id: "G-TERM-1", severity: "CRITICAL", description: "TERMINATE 不能是 optional" },
  { id: "G-TERM-2", severity: "CRITICAL", description: "TERMINATE 的 inputParameters.terminationStatus 必须是 COMPLETED 或 FAILED" },
  { id: "D1", severity: "WARN", description: "表达式语法为 ${path.to.value}，$${...} 是转义" },
  { id: "D2", severity: "WARN", description: "${workflow.X} 的 X 必须在白名单内" },
  { id: "D3", severity: "WARN", description: "${ref...} 用的是 taskReferenceName，不是任务 name" },
  { id: "D4", severity: "WARN", description: "${ref...} 的第二段必须是该任务的已知字段" },
  { id: "D5", severity: "WARN", description: "outputParameters 里的引用必须指向工作流内存在的任务" },
  { id: "D7", severity: "WARN", description: "workflow.env.* 在注册期会被服务端校验（离线无法确认存在性）" },
  { id: "D8", severity: "WARN", description: "GraalJS 表达式里不要用 ${} 占位符" },
];

export const WORKFLOW_SCOPES: ReadonlySet<string> = new Set([
  "input",
  "output",
  "status",
  "workflowId",
  "parentWorkflowId",
  "parentWorkflowTaskId",
  "workflowType",
  "version",
  "correlationId",
  "reasonForIncompletion",
  "schemaVersion",
  "variables",
  "env",
  "secrets",
]);

export const TASK_PARAM_SCOPES: ReadonlySet<string> = new Set([
  "input",
  "output",
  "status",
  "taskType",
  "referenceTaskName",
  "retryCount",
  "correlationId",
  "pollCount",
  "taskDefName",
  "scheduledTime",
  "startTime",
  "endTime",
  "workflowInstanceId",
  "taskId",
  "reasonForIncompletion",
  "callbackAfterSeconds",
  "workerId",
  "iteration",
]);

/** `${...}` placeholder — `$${...}` is the escaped form and is skipped. */
const EXPR_RE = /(?<!\$)\$\{([^{}]*)\}/g;
/** Same pattern without the global flag, for `test()`. */
const EXPR_TEST_RE = /(?<!\$)\$\{([^{}]*)\}/;
/** WAIT.duration：server 的 DateTimeUtils.DURATION_PATTERN（**不是** ISO-8601）。 */
const DURATION_RE =
  /\s*(?:(\d+)\s*(?:days?|d))?\s*(?:(\d+)\s*(?:hours?|hrs?|h))?\s*(?:(\d+)\s*(?:minutes?|mins?|m))?\s*(?:(\d+)\s*(?:seconds?|secs?|s))?\s*/i;
/** WAIT.until：server 的 DateTimeUtils.DATE_PATTERNS。 */
const UNTIL_RES: RegExp[] = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/,
];

function isValidUntil(text: string): boolean {
  return UNTIL_RES.some((pattern) => fullMatch(pattern, text));
}

/**
 * GraalJS 表达式字段：这些字段由 JS 引擎求值，引擎不认 ${} 占位符
 * （实际生效的字段按任务类型判定，见 `Linter.jsFields`）。
 */
export const PLACEHOLDER_FIELDS = ["sink", "dynamicTaskNameParam", "evaluatorType"] as const;

const SEVERITY_BY_RULE = new Map<string, Severity>(RULES.map((rule) => [rule.id, rule.severity]));

/** Severity of a rule id; unknown rules degrade to INFO. */
export function severityOf(rule: string): Severity {
  return SEVERITY_BY_RULE.get(rule) ?? "INFO";
}

/** The rule catalogue as plain objects (id, severity, description). */
export function ruleCatalog(): RuleDefinition[] {
  return RULES.map((rule) => ({ ...rule }));
}

/** Recursively yield (expression, path) for every `${...}` placeholder inside value. */
function* walkExprs(value: unknown, where: string): Generator<[string, string]> {
  if (typeof value === "string") {
    for (const match of value.matchAll(EXPR_RE)) {
      yield [match[1] ?? "", where];
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      yield* walkExprs(value[index], `${where}[${index}]`);
    }
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, item] of Object.entries(record)) {
      yield* walkExprs(item, `${where}.${key}`);
    }
  }
}

/** A single problem found in a workflow definition. */
export interface Finding {
  rule: string;
  severity: Severity;
  path: string;
  message: string;
  fix: string;
  /** Filled in by the presentation layer: where the definition came from. */
  file: string;
  line: number;
  ref: string;
}

/** The JSON shape of a finding (the `file`/`line`/`ref` fields are optional). */
export interface FindingDict {
  rule: string;
  severity: Severity;
  path: string;
  message: string;
  fix: string;
  file?: string;
  line?: number;
  taskReferenceName?: string;
}

export function findingToDict(finding: Finding): FindingDict {
  const payload: FindingDict = {
    rule: finding.rule,
    severity: finding.severity,
    path: finding.path,
    message: finding.message,
    fix: finding.fix,
  };
  if (finding.file) payload.file = finding.file;
  if (finding.line) payload.line = finding.line;
  if (finding.ref) payload.taskReferenceName = finding.ref;
  return payload;
}

/** A task in the workflow tree, with its structural path and siblings. */
export interface Node {
  task: WorkflowTask;
  path: string;
  kind: string;
  siblings: WorkflowTask[];
  index: number;
  parent: Node | null;
  type: string;
  ref: string;
  name: string;
  nextSibling: WorkflowTask | null;
  prevSibling: WorkflowTask | null;
}

function inputParams(node: Node): Record<string, unknown> {
  return asRecord(node.task.inputParameters) ?? {};
}

function hasInlineTaskDef(node: Node): boolean {
  const taskDef = asRecord(node.task.taskDefinition);
  if (!taskDef) return false;
  return "inputTemplate" in taskDef || "outputTemplate" in taskDef;
}

export class Linter {
  readonly wf: WorkflowDefinition;
  readonly findings: Finding[] = [];
  readonly nodes: Node[] = [];
  refs = new Map<string, Node>();

  constructor(workflow: WorkflowDefinition) {
    this.wf = workflow;
  }

  report(rule: string, path: string, message: string, fix = ""): void {
    this.findings.push({
      rule,
      severity: severityOf(rule),
      path,
      message,
      fix,
      file: "",
      line: 0,
      ref: "",
    });
  }

  critical(rule: string, path: string, message: string, fix = ""): void {
    this.report(rule, path, message, fix);
  }

  collect(): void {
    this.walk(asArray(this.wf.tasks) ?? [], "tasks", "root", null);
  }

  private walk(tasks: unknown[], path: string, kind: string, parent: Node | null): void {
    const siblings = tasks as WorkflowTask[];
    for (let index = 0; index < siblings.length; index += 1) {
      const task = siblings[index];
      if (!task || !asRecord(task)) continue;
      const node = createNode(task, `${path}[${index}]`, kind, siblings, index, parent);
      this.nodes.push(node);

      const cases = asRecord(task.decisionCases);
      if (cases) {
        for (const [caseName, caseTasks] of Object.entries(cases)) {
          const list = asArray(caseTasks);
          if (list) {
            this.walk(list, `${node.path}.decisionCases.${caseName}`, "decision", node);
          }
        }
      }
      const defaultCase = asArray(task.defaultCase);
      if (defaultCase) {
        this.walk(defaultCase, `${node.path}.defaultCase`, "decision", node);
      }
      const branches = asArray(task.forkTasks) ?? [];
      branches.forEach((branch, branchIndex) => {
        const list = asArray(branch);
        if (list) {
          this.walk(list, `${node.path}.forkTasks[${branchIndex}]`, "fork", node);
        }
      });
      const loopOver = asArray(task.loopOver);
      if (loopOver) {
        this.walk(loopOver, `${node.path}.loopOver`, "loop", node);
      }
    }
  }

  refNames(): Set<string> {
    const refs = new Set<string>();
    for (const node of this.nodes) {
      if (node.ref) refs.add(node.ref);
    }
    return refs;
  }

  /**
   * The node whose structural path is the longest prefix of `path`.
   *
   * Lets the presentation layer attach a taskReferenceName (and therefore a
   * source line) to a finding without every check having to pass it along.
   */
  nodeForPath(path: string): Node | null {
    let best: Node | null = null;
    for (const node of this.nodes) {
      if (path === node.path || path.startsWith(`${node.path}.`) || path.startsWith(`${node.path}[`)) {
        if (best === null || node.path.length > best.path.length) {
          best = node;
        }
      }
    }
    return best;
  }

  run(): Finding[] {
    this.collect();
    this.checkServerRequired();
    this.checkRefUniqueness();
    this.checkForkJoin();
    this.checkJoin();
    this.checkExclusiveJoin();
    this.checkTerminate();
    this.checkAdjacentJoins();
    this.checkBranchConvergence();
    this.checkTypeSpecific();
    this.checkExpressions();
    this.checkOutputParameters();
    return this.findings;
  }

  /**
   * Mirror the bean-validation rules the server applies to the definition itself.
   *
   * These are rejected with HTTP 400 at registration time (and by
   * `POST /metadata/workflow/validate`), so a definition that passes lint
   * must not trip them.
   */
  private checkServerRequired(): void {
    if (!asString(this.wf.name).trim()) {
      this.critical("S4", "workflow", "工作流 name 不能为空", "server: WorkflowDef.name @NotEmpty，注册即 400");
    }
    const tasks = this.wf.tasks;
    if (Array.isArray(tasks)) {
      if (tasks.length === 0) {
        this.critical("S1", "workflow", "工作流 tasks 不能为空", "server: WorkflowDef.tasks @NotEmpty，至少要有一个任务");
      }
    } else if (tasks !== undefined && tasks !== null) {
      this.critical("S1", "workflow", "workflow.tasks 必须是数组", "server 反序列化直接失败");
    }
    const schema = this.wf.schemaVersion;
    if (schema !== undefined && schema !== null) {
      const value = asInt(schema);
      if (value === undefined) {
        this.critical("S3", "workflow", `schemaVersion=${JSON.stringify(schema)} 不是整数`, "schemaVersion 当前服务端要求恰好为 2");
      } else if (value > 2) {
        this.critical("S3", "workflow", `schemaVersion=${value} 超过上限 2`, "server: WorkflowDef.schemaVersion @Min(2) @Max(2)");
      } else if (value < 2) {
        this.report(
          "S3",
          "workflow",
          `schemaVersion=${value} 低于当前服务端下限 2`,
          "server: WorkflowDef.schemaVersion @Min(2) @Max(2) —— 当前版本只接受 2（较老的 3.x 接受 1）",
        );
      }
    }
    for (const node of this.nodes) {
      if (!node.name.trim()) {
        this.critical("S2", node.path, "任务 name 不能为空", "server: WorkflowTask.name @NotEmpty，注册即 400");
      }
    }
  }

  private checkRefUniqueness(): void {
    const seen = new Map<string, Node>();
    for (const node of this.nodes) {
      const ref = node.ref;
      if (!ref) {
        this.critical("W2", node.path, "taskReferenceName 不能为空", "每个任务都需要唯一引用名才能被 ${ref.output.x} 引用");
        continue;
      }
      const first = seen.get(ref);
      if (first) {
        this.critical("W2", node.path, `taskReferenceName '${ref}' 重复（首次在 ${first.path}）`, "taskReferenceName 必须全工作流唯一");
      } else {
        seen.set(ref, node);
      }
    }
    this.refs = seen;
  }

  private checkForkJoin(): void {
    for (const node of this.nodes) {
      if (node.type !== "FORK_JOIN") continue;
      const branches = asArray(node.task.forkTasks) ?? [];
      if (branches.length === 0) {
        this.critical("G-FORK-1", node.path, "FORK_JOIN 的 forkTasks 不能为空", "至少一条并行分支");
        continue;
      }
      if (branches.length > 10) {
        this.report("G-FORK-4", node.path, `并行分支数 ${branches.length} 偏大（建议 <= 10）`, "分支过宽会打爆 worker 并发");
      }
      const next = node.nextSibling;
      if (!next) {
        this.critical("W3", node.path, "FORK_JOIN 之后没有 JOIN 任务", "运行时会抛 TerminateWorkflowException，整个工作流失败");
      } else if (asString(next.type) !== "JOIN") {
        this.critical("W3", node.path, `FORK_JOIN 之后的下一个任务是 ${asString(next.type)}，必须是 JOIN`, "FORK_JOIN 与 JOIN 必须同层相邻");
      }
    }
  }

  private checkJoin(): void {
    const known = this.refNames();
    for (const node of this.nodes) {
      if (node.type !== "JOIN") continue;
      const joinOn = asStringArray(node.task.joinOn);
      if (joinOn.length === 0) {
        this.critical("G-JOIN-1", node.path, "JOIN 没有 joinOn，永远不会完成", "joinOn 必须列出每个 fork 分支最后一个任务的引用名");
        continue;
      }
      const prev = node.prevSibling;
      if (!prev || asString(prev.type) !== "FORK_JOIN") {
        this.critical("W4", node.path, "JOIN 前面不是 FORK_JOIN，JOIN 永远不会被调度", "JOIN 必须紧跟在 FORK_JOIN 之后");
        continue;
      }
      const expected = branchTerminalRefs(prev);
      const missing = expected.filter((ref) => !joinOn.includes(ref));
      const extra = joinOn.filter((ref) => !expected.includes(ref));
      const unknown = joinOn.filter((ref) => !known.has(ref));
      if (missing.length > 0) {
        this.critical("W4", node.path, `joinOn 缺少分支末任务 ${pyListRepr(missing)}`, `joinOn 应为 ${pyListRepr(expected)}`);
      }
      if (extra.length > 0) {
        this.critical(
          "W4",
          node.path,
          `joinOn 里的 ${pyListRepr(extra)} 不是任何分支的最后一个任务`,
          `joinOn 应为 ${pyListRepr(expected)}；列错会提前放行或永久挂起`,
        );
      }
      if (unknown.length > 0) {
        this.critical("G-JOIN-2", node.path, `joinOn 引用了不存在的引用名 ${pyListRepr(unknown)}`, "JOIN 会一直等这些任务，工作流永久挂起");
      }
    }
  }

  private checkExclusiveJoin(): void {
    const known = this.refNames();
    for (const node of this.nodes) {
      if (node.type !== "EXCLUSIVE_JOIN") continue;
      const joinOn = asStringArray(node.task.joinOn);
      if (joinOn.length === 0) {
        this.critical("G-EXCL-1", node.path, "EXCLUSIVE_JOIN 没有 joinOn", "joinOn 必须列出要等待的任务");
      }
      const unknown = joinOn.filter((ref) => !known.has(ref));
      if (unknown.length > 0) {
        this.critical("G-EXCL-2", node.path, `joinOn 引用了不存在的引用名 ${pyListRepr(unknown)}`, "修正引用名，否则 JOIN 永久挂起");
      }
      if (!node.task.defaultExclusiveJoinTask) {
        this.critical("G-EXCL-2", node.path, "EXCLUSIVE_JOIN 没有 defaultExclusiveJoinTask", "必须指定默认走哪条分支");
      }
    }
  }

  private checkTerminate(): void {
    for (const node of this.nodes) {
      if (node.type !== "TERMINATE") continue;
      if (node.task.optional) {
        this.critical("G-TERM-1", node.path, "TERMINATE 不能是 optional: true", "optional 任务失败会被跳过，而 TERMINATE 必须真正终止工作流");
      }
      const status = inputParams(node).terminationStatus;
      if (status === undefined || status === null) {
        this.critical(
          "G-TERM-2",
          node.path,
          "TERMINATE 缺少 inputParameters.terminationStatus",
          "terminationStatus 必须是 COMPLETED 或 FAILED（注意不是 status，server 用的是 terminationStatus）",
        );
      } else if (!["COMPLETED", "FAILED"].includes(asString(status))) {
        this.critical("G-TERM-2", node.path, `TERMINATE 的 terminationStatus='${asString(status)}' 非法`, "terminationStatus 必须是 COMPLETED 或 FAILED");
      }
      const dead = node.siblings.slice(node.index + 1).filter((task) => asRecord(task));
      if (dead.length > 0) {
        const names = dead.map((task) => asString(task.taskReferenceName || task.name));
        this.critical("W9", node.path, `TERMINATE 之后还有任务 ${pyListRepr(names)}，它们永远不会执行`, "TERMINATE 之后没有后继，请把它放到链尾");
      }
    }
  }

  private checkAdjacentJoins(): void {
    for (const node of this.nodes) {
      const next = node.nextSibling;
      if (next !== null && node.type === "JOIN" && asString(next.type) === "JOIN") {
        this.report("W12", node.path, "同一层出现两个相邻的 JOIN，第二个永远不会被调度", "每个 FORK_JOIN 只对应一个 JOIN");
      }
    }
  }

  private checkTypeSpecific(): void {
    for (const node of this.nodes) {
      const type = node.type;
      const params = inputParams(node);
      if (type === "SIMPLE" || type === "USER_DEFINED") {
        if (!hasInlineTaskDef(node)) {
          this.report("G-SIMPLE-3", node.path, `任务 '${node.name}' 没有内联 taskDefinition`, "离线 lint 无法确认它；建议内联 taskDefinition 保持自包含");
        }
      } else if (type === "DYNAMIC") {
        this.checkDynamic(node, params);
      } else if (type === "FORK_JOIN_DYNAMIC") {
        this.checkDynamicFork(node, params);
      } else if (type === "SWITCH") {
        this.checkSwitch(node);
      } else if (type === "DECISION") {
        this.checkDecision(node);
      } else if (type === "DO_WHILE") {
        this.checkDoWhile(node);
      } else if (type === "SUB_WORKFLOW") {
        this.checkSubWorkflow(node);
      } else if (type === "START_WORKFLOW") {
        this.checkStartWorkflow(node, params);
      } else if (type === "EVENT") {
        if (!node.task.sink) {
          this.critical("G-EVENT-1", node.path, "EVENT 缺少 sink", "sink 是事件名/队列");
        } else {
          this.report("G-EVENT-2", node.path, "EVENT 是异步任务，工作流挂起直到外部推入 payload", `下游用 \${${node.ref}.output.payload} 取事件内容`);
        }
      } else if (type === "WAIT") {
        this.checkWait(node, params);
      } else if (type === "HTTP") {
        this.checkHttp(node, params);
      } else if (type === "KAFKA_PUBLISH") {
        this.checkKafka(node, params);
      } else if (type === "JSON_JQ_TRANSFORM") {
        this.checkJq(node, params);
      }
    }
  }

  private checkDynamic(node: Node, params: Record<string, unknown>): void {
    const dyn = node.task.dynamicTaskNameParam;
    if (!dyn) {
      this.critical("G-DYNAMIC-1", node.path, "DYNAMIC 缺少 dynamicTaskNameParam", "指定任务名所在的 inputParameters key");
      return;
    }
    const key = asString(dyn);
    if (EXPR_TEST_RE.test(key)) {
      this.critical("G-DYNAMIC-2", node.path, `dynamicTaskNameParam='${key}' 不能是表达式`, "引擎用 input.get(key) 取任务名，key 不做 ${} 替换");
      return;
    }
    if (!(key in params)) {
      this.critical(
        "G-DYNAMIC-2",
        node.path,
        `dynamicTaskNameParam='${key}' 不在 inputParameters 里`,
        `引擎按字面 key 取值，inputParameters 需要包含 key '${key}'；指向上游 refName 无效（取到的是整张上游结果 map）`,
      );
      return;
    }
    const value = params[key];
    if (value === undefined || value === null) {
      this.critical("G-DYNAMIC-2", node.path, `dynamicTaskNameParam='${key}' 的值是 null`, "引擎取不到任务名，运行期抛 TerminateWorkflowException");
    } else if (typeof value === "object") {
      this.critical("G-DYNAMIC-2", node.path, `dynamicTaskNameParam='${key}' 的值是对象/数组`, "引擎会 String.valueOf(整张 map) 当任务名，必然找不到 TaskDef");
    } else if (typeof value === "string" && !value.trim()) {
      this.critical("G-DYNAMIC-2", node.path, `dynamicTaskNameParam='${key}' 的值是空字符串`, "取到空任务名，运行期找不到 TaskDef");
    }
  }

  private checkDynamicFork(node: Node, params: Record<string, unknown>): void {
    const hasInputs = "forkTaskInputs" in params;
    const legacy = node.task.dynamicForkJoinTasksParam;
    const dyn = node.task.dynamicForkTasksParam;
    const dynInput = node.task.dynamicForkTasksInputParamName;
    if (hasInputs) {
      if (legacy || dyn || dynInput) {
        this.critical(
          "G-FORKDYN-2",
          node.path,
          "forkTaskInputs 与 dynamicFork* 参数同时出现",
          "三选一：forkTaskInputs / dynamicForkJoinTasksParam / (dynamicForkTasksParam + dynamicForkTasksInputParamName)",
        );
      }
      const entries = asArray(params.forkTaskInputs);
      if (entries) {
        entries.forEach((entry, index) => {
          const record = asRecord(entry);
          if (!record || !record.task) {
            this.report("G-FORKDYN-3", node.path, `forkTaskInputs[${index}] 缺少 'task' 字段`, '元素形如 {"task": "<TaskDef name>", "input": {...}}');
          }
        });
      }
      return;
    }
    if (legacy && (dyn || dynInput)) {
      this.critical("G-FORKDYN-2", node.path, "dynamicForkJoinTasksParam 与 dynamicForkTasks* 参数互斥", "只能二选一");
      return;
    }
    if (!legacy) {
      if (!dyn) {
        this.critical("G-FORKDYN-1", node.path, "FORK_JOIN_DYNAMIC 缺少 dynamicForkTasksParam", "或改用 forkTaskInputs");
      }
      if (!dynInput) {
        this.critical("G-FORKDYN-1", node.path, "FORK_JOIN_DYNAMIC 缺少 dynamicForkTasksInputParamName", "或改用 forkTaskInputs");
      }
    }
  }

  private checkSwitch(node: Node): void {
    const evaluator = node.task.evaluatorType;
    const expression = node.task.expression;
    const params = inputParams(node);
    if (!evaluator) {
      this.critical("G-SWITCH-1", node.path, "SWITCH 缺少 evaluatorType", "javascript 或 value-param");
    }
    if (!expression) {
      this.critical("G-SWITCH-2", node.path, "SWITCH 缺少 expression", "决定走哪个 case");
    }
    if (!node.task.decisionCases) {
      this.critical("G-SWITCH-3", node.path, "SWITCH 缺少 decisionCases", "至少一个 case");
    }
    if (!node.task.defaultCase) {
      this.report("G-SWITCH-6", node.path, "SWITCH 没有 defaultCase", "所有 case 都不匹配时工作流会直接往下走，建议加兜底分支");
    }
    if (asString(evaluator) === "value-param" && typeof expression === "string" && expression) {
      // 求值 = taskInput.get(expression)：expression 是 inputParameters 的 key 名，不是表达式模板
      if (!(expression in params)) {
        this.critical(
          "G-SWITCH-7",
          node.path,
          `value-param 的 expression='${expression}' 不在 inputParameters 的 key 里`,
          `value-param 取的是 inputParameters['${expression}']；要引工作流入参请写成 inputParameters: {"${expression}": "\${workflow.input.xxx}"}`,
        );
      }
    }
    if (asString(evaluator) === "javascript" && typeof expression === "string") {
      if (expression.includes("$.workflow")) {
        this.report(
          "G-SWITCH-5",
          node.path,
          "SWITCH 的 javascript 表达式里出现了 $.workflow",
          "SWITCH 的 $ 是该任务自己的 input map，写 $.<key>；$.workflow.input.x 是 INLINE / DO_WHILE 的形态",
        );
      }
    }
  }

  private checkDecision(node: Node): void {
    if (!node.task.caseValueParam && !node.task.caseExpression) {
      this.critical("G-DECISION-1", node.path, "DECISION 缺少 caseValueParam / caseExpression", "二选一");
    }
    if (!node.task.decisionCases) {
      this.critical("G-DECISION-2", node.path, "DECISION 缺少 decisionCases", "至少一个 case");
    }
    this.report("G-DECISION-3", node.path, "DECISION 已废弃（caseValueParam / caseExpression 均为 @Deprecated）", "新工作流请改用 SWITCH");
  }

  private checkDoWhile(node: Node): void {
    if (!node.task.loopCondition) {
      this.critical("G-DOWHILE-1", node.path, "DO_WHILE 缺少 loopCondition", "返回 boolean 的 GraalJS 表达式");
    }
    if (!node.task.loopOver) {
      this.critical("G-DOWHILE-2", node.path, "DO_WHILE 缺少 loopOver", "循环体任务链");
    }
    this.report("G-DOWHILE-3", node.path, "DO_WHILE 需要显式退出保护", "用计数器上限或 break 条件兜底，避免无限循环");
  }

  private checkSubWorkflow(node: Node): void {
    const swp = node.task.subWorkflowParam;
    if (!swp) {
      this.critical("G-SUBWF-1", node.path, "SUB_WORKFLOW 缺少 subWorkflowParam", "对象需含 name / version");
      return;
    }
    const record = asRecord(swp);
    if (!record || !record.name) {
      this.critical("G-SUBWF-2", node.path, "subWorkflowParam.name 不能为空", "子工作流名");
    }
    this.report("G-SUBWF-4", node.path, "SUB_WORKFLOW 会等待子流程完成", "需要 fire-and-forget 请改用 START_WORKFLOW");
  }

  private checkStartWorkflow(node: Node, params: Record<string, unknown>): void {
    const req = params.startWorkflow;
    if (req === undefined || req === null) {
      this.critical(
        "G-STARTWF-1",
        node.path,
        "START_WORKFLOW 缺少 inputParameters.startWorkflow",
        "字段：name / version / workflowInput / taskToDomain / correlationId / priority",
      );
      return;
    }
    const record = asRecord(req);
    if (!record) {
      this.critical("G-STARTWF-1", node.path, "inputParameters.startWorkflow 必须是对象", "对应 StartWorkflowRequest");
      return;
    }
    if (!record.name) {
      this.critical("G-STARTWF-2", node.path, "startWorkflow.name 不能为空", "子工作流名");
    }
    this.report(
      "G-STARTWF-3",
      node.path,
      "START_WORKFLOW 不等待子流程，父任务立刻 COMPLETED 并输出 workflowId",
      "需要等结果请用 SUB_WORKFLOW",
    );
  }

  private checkWait(node: Node, params: Record<string, unknown>): void {
    const duration = params.duration;
    const until = params.until;
    const hasDuration = duration !== undefined && duration !== null && duration !== "";
    const hasUntil = until !== undefined && until !== null && until !== "";
    if (hasDuration && hasUntil) {
      this.critical("G-WAIT-1", node.path, "WAIT 同时给了 duration 和 until", "只能二选一（server 注册期直接 400）");
    } else if (!hasDuration && !hasUntil) {
      this.report("G-WAIT-3", node.path, "WAIT 既没有 duration 也没有 until", "server 放行，但运行期任务会失败");
    }
    if (typeof duration === "string" && duration && !duration.startsWith("${")) {
      if (!fullMatch(DURATION_RE, duration) || !/\d/.test(duration)) {
        this.critical(
          "G-WAIT-2",
          node.path,
          `WAIT 的 duration='${duration}' 格式非法`,
          "server 只认 '10 seconds' / '5m' / '1 hour 30 minutes' 这类写法，**不支持 ISO-8601 的 PT10S**",
        );
      }
    }
    if (typeof until === "string" && until && !until.startsWith("${")) {
      if (!isValidUntil(until)) {
        this.critical(
          "G-WAIT-2",
          node.path,
          `WAIT 的 until='${until}' 格式非法`,
          "server 只认 'yyyy-MM-dd' 或 'yyyy-MM-dd HH:mm'（可带时区），不支持 '2030-01-01T00:00:00Z' 这种 ISO-8601",
        );
      }
    }
  }

  private checkHttp(node: Node, params: Record<string, unknown>): void {
    const ok = "http_request" in params || "uri" in params || "method" in params;
    if (!ok && !hasInlineTaskDef(node)) {
      this.critical(
        "G-HTTP-1",
        node.path,
        "HTTP 缺少 http_request / uri / method，且没有内联 taskDefinition",
        "三选一：inputParameters.http_request、inputParameters.uri、TaskDef.inputTemplate.http_request",
      );
    }
  }

  private checkKafka(node: Node, params: Record<string, unknown>): void {
    if (!("kafka_request" in params) && !hasInlineTaskDef(node)) {
      this.critical(
        "G-KAFKA-1",
        node.path,
        "KAFKA_PUBLISH 缺少 kafka_request，且没有内联 taskDefinition",
        "inputParameters.kafka_request 或 TaskDef.inputTemplate.kafka_request",
      );
    }
  }

  private checkJq(node: Node, params: Record<string, unknown>): void {
    if (!("queryExpression" in params) && !hasInlineTaskDef(node)) {
      this.critical(
        "G-JQ-1",
        node.path,
        "JSON_JQ_TRANSFORM 缺少 queryExpression，且没有内联 taskDefinition",
        "inputParameters.queryExpression 或 TaskDef.inputTemplate.queryExpression",
      );
    }
  }

  private checkBranchConvergence(): void {
    for (const node of this.nodes) {
      if (node.type !== "SWITCH" && node.type !== "DECISION") continue;
      const caseTasks: Array<[string, WorkflowTask]> = [];
      const cases = asRecord(node.task.decisionCases);
      if (cases) {
        for (const [caseName, tasks] of Object.entries(cases)) {
          const list = asArray(tasks);
          if (!list) continue;
          for (const task of list) {
            if (asRecord(task)) {
              caseTasks.push([`${node.path}.decisionCases.${caseName}`, task as WorkflowTask]);
            }
          }
        }
      }
      const defaultCase = asArray(node.task.defaultCase);
      if (defaultCase) {
        for (const task of defaultCase) {
          if (asRecord(task)) {
            caseTasks.push([`${node.path}.defaultCase`, task as WorkflowTask]);
          }
        }
      }
      if (caseTasks.length === 0) continue;

      if (node.kind !== "root") {
        this.report(
          "W15",
          node.path,
          "嵌套分支的汇聚点是它在外层 case 列表里的下一个兄弟，不是顶层后继",
          "外层 case 里、内层分支之后的兄弟只在这条路径上执行；别的外层 case 走不到这里",
        );
      }

      const topNext = node.kind === "root" ? node.nextSibling : null;
      if (topNext) {
        const topName = asString(topNext.name);
        if (topName.length > 2) {
          for (const [where, task] of caseTasks) {
            if (asString(task.name) === topName) {
              this.report(
                "W16",
                where,
                `分支里出现了与顶层后继 '${topName}' 同名的任务`,
                "分支末会回到顶层再执行一次顶层后继 → 这个任务会跑两次；公共后继只写在顶层",
              );
            }
          }
        }
      }
    }
  }

  private checkExpressions(): void {
    const known = this.refNames();
    for (const node of this.nodes) {
      for (const [expr, where] of this.iterExpressions(node)) {
        this.checkOneExpression(node, expr, where, known);
      }
      for (const field of Linter.jsFields(node)) {
        const value = node.task[field];
        if (typeof value === "string" && EXPR_TEST_RE.test(value)) {
          this.report(
            "D8",
            `${node.path}.${field}`,
            `${field} 里出现了 \${...} 占位符`,
            "GraalJS 表达式里用 $. 访问数据，不要和 ${} 模板占位符混用（两套机制混用会静默拿到 undefined）",
          );
        }
      }
      for (const key of Object.keys(inputParams(node))) {
        if (known.has(key) && key !== node.ref) {
          this.report(
            "W14",
            node.path,
            `inputParameters 的 key '${key}' 与任务引用名同名`,
            "上游输出会自动注入，不要手工内联；用 ${" + key + ".output.x} 引用",
          );
        }
      }
    }
  }

  /** 该任务上真正由 GraalJS/Nashorn 求值的字段（其余不是 JS，误报代价高）。 */
  private static jsFields(node: Node): string[] {
    const type = node.type;
    if (type === "SWITCH") {
      // value-param 模式下 expression 只是 inputParameters 的 key 名，不是脚本
      return node.task.evaluatorType === "javascript" ? ["expression"] : [];
    }
    if (type === "DECISION") {
      return node.task.caseExpression ? ["caseExpression"] : [];
    }
    if (type === "DO_WHILE") {
      return node.task.loopCondition ? ["loopCondition"] : [];
    }
    return [];
  }

  private *iterExpressions(node: Node): Generator<[string, string]> {
    const params = asRecord(node.task.inputParameters);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        yield* walkExprs(value, `inputParameters.${key}`);
      }
    }
    for (const field of PLACEHOLDER_FIELDS) {
      const value = node.task[field];
      if (typeof value === "string") {
        for (const match of value.matchAll(EXPR_RE)) {
          yield [match[1] ?? "", field];
        }
      }
    }
    const swp = asRecord(node.task.subWorkflowParam);
    if (swp) {
      const name = asString(swp.name);
      for (const match of name.matchAll(EXPR_RE)) {
        yield [match[1] ?? "", "subWorkflowParam.name"];
      }
    }
  }

  private checkOneExpression(node: Node, expr: string, where: string, known: Set<string>): void {
    if (!expr) {
      this.report("D1", `${node.path}.${where}`, "空的 ${} 占位符", "移除它或补上路径");
      return;
    }
    const parts = expr.split(".");
    const head = parts[0] ?? "";
    if (head === "workflow") {
      const scope = parts.length > 1 ? (parts[1] ?? "") : "";
      if (!WORKFLOW_SCOPES.has(scope)) {
        this.report(
          "D2",
          `${node.path}.${where}`,
          `\${workflow.${scope}} 不在支持的作用域白名单内`,
          "可用：" + [...WORKFLOW_SCOPES].sort().join(", "),
        );
      } else if (scope === "env") {
        this.report(
          "D7",
          `${node.path}.${where}`,
          "${workflow.env.*} 会在注册期被服务端校验（环境变量不存在直接 400）",
          "确认该环境变量在目标环境存在",
        );
      }
      return;
    }
    if (known.has(head)) {
      if (parts.length > 1 && !TASK_PARAM_SCOPES.has(parts[1] ?? "")) {
        this.report(
          "D4",
          `${node.path}.${where}`,
          `\${${expr}} 的第二段 '${parts[1] ?? ""}' 不是该任务的已知字段`,
          "可用：" + [...TASK_PARAM_SCOPES].sort().join(", "),
        );
      }
      return;
    }
    this.critical(
      "W13",
      `${node.path}.${where}`,
      `\${${expr}} 引用了不存在的 taskReferenceName '${head}'`,
      "引用名必须存在；注意是 taskReferenceName 而非任务 name",
    );
  }

  private checkOutputParameters(): void {
    const known = this.refNames();
    const raw = this.wf.outputParameters;
    let entries: Array<[string, unknown]> = [];
    const record = asRecord(raw);
    if (record) {
      // WorkflowDef.outputParameters 是 Map<String, Object>：值才是被替换的表达式
      entries = Object.entries(record).map(([key, value]) => [`outputParameters.${key}`, value] as [string, unknown]);
    } else if (Array.isArray(raw)) {
      // 兼容旧格式（List<String>）
      entries = raw.map((value, index) => [`outputParameters[${index}]`, value] as [string, unknown]);
    }
    for (const [where, value] of entries) {
      for (const [expr, path] of walkExprs(value, where)) {
        if (!expr) continue;
        const head = expr.split(".")[0] ?? "";
        if (head !== "workflow" && !known.has(head)) {
          this.report(
            "D5",
            path,
            `outputParameters 里的 \${${expr}} 引用了不存在的引用名 '${head}'`,
            "引用名必须存在",
          );
        }
      }
    }
  }
}

function createNode(
  task: WorkflowTask,
  path: string,
  kind: string,
  siblings: WorkflowTask[],
  index: number,
  parent: Node | null,
): Node {
  return {
    task,
    path,
    kind,
    siblings,
    index,
    parent,
    type: asString(task.type),
    ref: asString(task.taskReferenceName),
    name: asString(task.name),
    nextSibling: index + 1 < siblings.length ? (siblings[index + 1] ?? null) : null,
    prevSibling: index > 0 ? (siblings[index - 1] ?? null) : null,
  };
}

/** The reference name of the last task of every fork branch. */
function branchTerminalRefs(forkTask: WorkflowTask): string[] {
  const refs: string[] = [];
  const branches = asArray(forkTask.forkTasks) ?? [];
  for (const branch of branches) {
    const list = asArray(branch);
    if (!list || list.length === 0) continue;
    const last = list[list.length - 1];
    const record = asRecord(last);
    if (!record) continue;
    const ref = record.taskReferenceName;
    if (ref) refs.push(asString(ref));
  }
  return refs;
}

/** Validate a parsed workflow definition and return its findings. */
export function lintDefinition(workflow: WorkflowDefinition): Finding[] {
  return new Linter(workflow).run();
}