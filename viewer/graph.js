/**
 * 把 Conductor WorkflowDef 解析成「节点 + 边」的图结构（纯展示用）。
 *
 * 语义与 conductor/ui/src/components/diagram/WorkflowDAG.js 的定义视图保持一致：
 *  - 顶层 tasks 数组按顺序串行
 *  - SWITCH / DECISION：互斥分支，case 值标注在边上
 *  - FORK_JOIN：外层并行、内层串行
 *  - DO_WHILE：loopOver 作为循环体，尾边连回 doWhile-END
 *
 * 重要约定：**结构路径（path）与「问题 → 任务」的映射完全由 conductor-validate 决定。**
 * 本文件不自己拼路径、也不自己做前缀匹配：
 *  - 路径取自 Linter 的节点树（`Linter#nodes[].path`，即 canonical path）；
 *  - 某条校验问题属于哪个任务，由 `Linter#nodeForPath()` 回答。
 * 这样页面和 CLI 永远讲同一套路径，规则改动不会让两边漂移。
 * 本文件只负责「边」——那是画布布局的事，不是校验的事。
 */

export const TERMINAL_TYPES = new Set([
  "TERMINATE",
  "TERMINAL",
  "START_WORKFLOW",
]);

/** 需要画成菱形（分支判定）的任务类型 */
export const DECISION_TYPES = new Set(["SWITCH", "DECISION"]);

/** 任务类型的可视化配色分组 */
export const TYPE_GROUPS = {
  SIMPLE: "task",
  HTTP: "task",
  HTTP_V2: "task",
  INLINE: "task",
  LAMBDA: "task",
  JSON_JQ_TRANSFORM: "task",
  SET_VARIABLE: "task",
  KAFKA_PUBLISH: "task",
  USER_DEFINED: "task",
  SWITCH: "decision",
  DECISION: "decision",
  FORK_JOIN: "fork",
  FORK_JOIN_DYNAMIC: "fork",
  DYNAMIC: "fork",
  DO_WHILE: "loop",
  SUB_WORKFLOW: "sub",
  EVENT: "sub",
  WAIT: "sub",
  HUMAN: "human",
  JOIN: "join",
  EXCLUSIVE_JOIN: "join",
  TERMINATE: "terminate",
  START_WORKFLOW: "terminate",
};

export function typeGroup(type) {
  return TYPE_GROUPS[type] || "task";
}

function refOf(task) {
  return task.taskReferenceName || task.name || `task_${Math.random().toString(36).slice(2, 9)}`;
}

export function buildGraph(workflowDef, linter) {
  const nodes = new Map();
  /** task 对象 → 节点：用对象身份把 conductor-validate 的节点和画布节点对上 */
  const byTask = new Map();
  const edges = [];
  const order = [];

  // canonical path 只有 conductor-validate 一处定义：按 task 对象身份索引
  const pathByTask = new Map();
  for (const node of linter?.nodes ?? []) {
    if (node.task && node.path) pathByTask.set(node.task, node.path);
  }

  const addNode = (task, extra = {}) => {
    const ref = refOf(task);
    const node = {
      ref,
      name: task.name || task.taskReferenceName || ref,
      type: task.type || "SIMPLE",
      task,
      group: typeGroup(task.type),
      // 路径直接取自 conductor-validate；它不认识的（比如三层 forkTasks 里的任务）就留空
      path: pathByTask.get(task) || "",
      ...extra,
    };
    byTask.set(task, node);
    if (!nodes.has(ref)) {
      nodes.set(ref, node);
      order.push(ref);
    }
    return node;
  };

  const addEdge = (from, to, label) => {
    if (!from || !to) return;
    if (edges.some((e) => e.from === from && e.to === to && e.label === label)) return;
    edges.push({ from, to, label });
  };

  const START = "__start";
  nodes.set(START, {
    ref: START,
    name: "start",
    type: "TERMINAL",
    group: "terminate",
    task: { name: "start", type: "TERMINAL" },
  });
  order.unshift(START);

  /**
   * 处理一个任务，返回它的「出口 ref 列表」（分支的尾巴）。
   *
   * 只算拓扑（边），不算路径——路径归 conductor-validate 管。
   */
  const processTask = (task, antecedents) => {
    const type = task.type || "SIMPLE";

    if (DECISION_TYPES.has(type)) {
      const node = addNode(task);
      antecedents.forEach((a) => addEdge(a, node.ref));

      const tails = [];
      const caseEntries = Object.entries(task.decisionCases || {});
      const defaultCase = task.defaultCase || [];

      const runBranch = (branchTasks, label) => {
        if (!branchTasks || branchTasks.length === 0) return;
        const branchTails = processTaskList(branchTasks, [node.ref], label);
        tails.push(...branchTails);
      };

      for (const [caseValue, branchTasks] of caseEntries) {
        runBranch(branchTasks, caseValue);
      }
      runBranch(defaultCase, "default");

      if (tails.length === 0) tails.push(node.ref);
      return tails;
    }

    if (type === "FORK_JOIN") {
      const node = addNode(task);
      antecedents.forEach((a) => addEdge(a, node.ref));

      const tails = [];
      const forkTasks = task.forkTasks || [];
      // Conductor 的 forkTasks 有两种写法：
      //   两层: [[t1, t2], [t3]]           -> 每层内串行，层间并行
      //   三层: [[[t1], [t2]], [[t3]]]     -> 外层是并行组，组内每条链串行
      const isNestedGroups =
        Array.isArray(forkTasks[0]) && Array.isArray(forkTasks[0][0]);

      forkTasks.forEach((branch) => {
        if (!Array.isArray(branch)) return;
        const chains = isNestedGroups ? branch : [branch];
        for (const chain of chains) {
          if (!Array.isArray(chain) || chain.length === 0) continue;
          const chainTails = processTaskList(chain, [node.ref]);
          tails.push(...chainTails);
        }
      });
      if (tails.length === 0) tails.push(node.ref);
      return tails;
    }

    if (type === "DO_WHILE") {
      const node = addNode(task);
      antecedents.forEach((a) => addEdge(a, node.ref));

      const endRef = `${node.ref}-END`;
      // 循环结束节点是画布上合成的，conductor-validate 不认识它，所以没有路径
      nodes.set(endRef, {
        ref: endRef,
        name: `${node.name} (end)`,
        type: "DO_WHILE_END",
        group: "loop",
        task: { name: node.name, type: "DO_WHILE_END" },
        path: "",
      });
      order.push(endRef);

      const loopTails = processTaskList(task.loopOver || [], [node.ref]);
      loopTails.forEach((t) => addEdge(t, endRef));
      addEdge(node.ref, endRef, "loop");
      return [endRef];
    }

    // 叶子节点
    const node = addNode(task);
    antecedents.forEach((a) => addEdge(a, node.ref));

    if (TERMINAL_TYPES.has(type)) {
      return []; // 终止，后续任务不再连入
    }
    return [node.ref];
  };

  const processTaskList = (tasks, antecedents, edgeLabel) => {
    let current = antecedents;
    for (const task of tasks || []) {
      const tails = processTask(task, current);
      if (edgeLabel && current.length === 1) {
        // 分支首节点带 case 标签
        const lastEdge = edges[edges.length - 1];
        if (lastEdge && lastEdge.to === tails[0] && lastEdge.label === undefined) {
          lastEdge.label = edgeLabel;
        }
      }
      current = tails;
    }
    return current;
  };

  const tailRefs = processTaskList(workflowDef?.tasks || [], [START]);

  // 结尾
  const END = "__final";
  if (tailRefs.length > 0) {
    nodes.set(END, {
      ref: END,
      name: "final",
      type: "TERMINAL",
      group: "terminate",
      task: { name: "final", type: "TERMINAL" },
    });
    order.push(END);
    tailRefs.forEach((t) => addEdge(t, END));
  }

  return { nodes, byTask, edges, order, start: START, end: END };
}

/** 遍历 forkTasks 里的每个任务，兼容两层/三层两种嵌套写法 */
export function eachForkTask(forkTasks, cb) {
  if (!Array.isArray(forkTasks)) return;
  const nested = Array.isArray(forkTasks[0]) && Array.isArray(forkTasks[0][0]);
  for (const branch of forkTasks) {
    if (!Array.isArray(branch)) continue;
    if (nested) {
      for (const chain of branch) {
        if (Array.isArray(chain)) chain.forEach(cb);
      }
    } else {
      branch.forEach(cb);
    }
  }
}

/** 收集工作流里引用到的子工作流名 */
export function collectSubWorkflows(workflowDef) {
  const found = new Set();
  const walk = (tasks) => {
    for (const t of tasks || []) {
      if (!t) continue;
      if (t.type === "SUB_WORKFLOW") {
        const n = t.subWorkflowName || t.workflowName;
        if (n) found.add(n);
      }
      if (t.decisionCases) {
        Object.values(t.decisionCases).forEach((branch) => walk(branch));
      }
      if (t.defaultCase) walk(t.defaultCase);
      if (t.loopOver) walk(t.loopOver);
      eachForkTask(t.forkTasks, (task) => walk([task]));
    }
  };
  walk(workflowDef?.tasks || []);
  return [...found];
}

/**
 * 统计工作流概况
 *
 * 注意：这里刻意**不**自己算路径，只用 linter 提供的 canonical path。
 */
export function summarize(workflowDef, linter) {
  const graph = buildGraph(workflowDef, linter);
  const byType = {};
  for (const [, node] of graph.nodes) {
    if (node.ref === graph.start || node.ref === graph.end) continue;
    byType[node.type] = (byType[node.type] || 0) + 1;
  }
  return {
    name: workflowDef?.name || "(未命名)",
    version: workflowDef?.version ?? 1,
    description: workflowDef?.description || "",
    taskCount: Object.values(byType).reduce((a, b) => a + b, 0),
    byType,
    subWorkflows: collectSubWorkflows(workflowDef),
  };
}
