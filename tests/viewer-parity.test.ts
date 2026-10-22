/**
 * Guard: the browser viewer must never grow its own validation logic.
 *
 * The page and the CLI have to agree on three things:
 *
 *  1. **the rules** — the viewer runs `src/core.ts`, compiled to browser ESM;
 *  2. **the structural paths** (`tasks[1].decisionCases.vip[0]`) — a path is
 *     defined once, by conductor-validate; the viewer only displays it;
 *  3. **"which task does this finding belong to"** — answered by
 *     `Linter#nodeForPath()`, not by a second prefix matcher in the viewer.
 *
 * This test makes that a checkable fact instead of a convention: if somebody
 * re-implements a rule, a path scheme or a severity table inside `viewer/`,
 * it fails here.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  Linter,
  type Finding,
  lintDefinition,
  ruleCatalog,
  SEVERITY_ORDER,
} from "../src/core.js";
import type { WorkflowDefinition } from "../src/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIEWER = fileURLToPath(new URL("../viewer", import.meta.url));
const VENDOR_CORE = fileURLToPath(new URL("../viewer/vendor/core.js", import.meta.url));
const DOC_RULES = fileURLToPath(new URL("../docs/wiring-rules.md", import.meta.url));

/** The slice of viewer/graph.js this test needs. */
interface ViewerGraph {
  nodes: Map<string, { ref: string; path: string; task: unknown }>;
  byTask: Map<unknown, { ref: string; path: string; task: unknown }>;
  edges: unknown[];
  order: string[];
}
interface GraphModule {
  buildGraph(workflow: WorkflowDefinition, linter: Linter): ViewerGraph;
}

// 动态 import：viewer/ 是纯 JS，没有 .d.ts，用变量路径绕开 TS 的静态解析
const graphModulePath = "../viewer/graph.js";
const { buildGraph } = (await import(/* @vite-ignore */ graphModulePath)) as GraphModule;

function readJson(path: string): WorkflowDefinition {
  return JSON.parse(readFileSync(path, "utf8")) as WorkflowDefinition;
}

/** 所有用来做对照的工作流：项目自带示例 + viewer 演示样例 */
function corpus(): { name: string; workflow: WorkflowDefinition }[] {
  const files: { name: string; dir: string }[] = [
    { name: "examples", dir: fileURLToPath(new URL("../examples", import.meta.url)) },
    { name: "viewer/samples", dir: fileURLToPath(new URL("../viewer/samples", import.meta.url)) },
  ];
  const out: { name: string; workflow: WorkflowDefinition }[] = [];
  for (const { name, dir } of files) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      out.push({ name: `${name}/${file}`, workflow: readJson(`${dir}/${file}`) });
    }
  }
  return out;
}

const WORKFLOWS = corpus();

describe("viewer ↔ conductor-validate 一致性", () => {
  it("对照样本不是空的", () => {
    expect(WORKFLOWS.length).toBeGreaterThan(0);
  });

  it("结构路径只有 conductor-validate 一处定义：viewer 显示的路径与 linter 完全一致", () => {
    for (const { name, workflow } of WORKFLOWS) {
      const linter = new Linter(workflow);
      linter.collect();
      const graph = buildGraph(workflow, linter);

      for (const node of linter.nodes) {
        const viewerNode = graph.byTask.get(node.task);
        expect(viewerNode, `${name}: ${node.path} 在 viewer 里找不到对应节点`).toBeTruthy();
        expect(viewerNode?.path, `${name}: ${node.path} 的路径不一致`).toBe(node.path);
      }
    }
  });

  it("「问题属于哪个任务」由 conductor-validate 决定，viewer 能据此定位到节点", () => {
    for (const { name, workflow } of WORKFLOWS) {
      const linter = new Linter(workflow);
      linter.collect();
      const graph = buildGraph(workflow, linter);
      const findings = lintDefinition(workflow);

      for (const finding of findings) {
        const node = linter.nodeForPath(finding.path);
        if (!node) {
          // 工作流级别的检查（没有落到具体任务上），允许没有归属
          expect(finding.path.startsWith("tasks[")).toBe(false);
          continue;
        }
        const viewerNode = graph.byTask.get(node.task);
        expect(viewerNode, `${name}: ${finding.path} 定位不到节点`).toBeTruthy();
        expect(viewerNode?.ref, `${name}: ${finding.path} 的 ref 不一致`).toBe(node.ref);
      }
    }
  });

  it("页面用的浏览器产物与源码行为完全一致（规则、级别、路径、消息）", async () => {
    expect(existsSync(VENDOR_CORE), "缺少 viewer/vendor/core.js，先跑 npm run build:viewer").toBe(true);

    const vendor = (await import(/* @vite-ignore */ VENDOR_CORE)) as {
      lintDefinition: typeof lintDefinition;
      ruleCatalog: typeof ruleCatalog;
      SEVERITY_ORDER: typeof SEVERITY_ORDER;
    };

    // 规则目录必须一模一样
    expect(vendor.ruleCatalog()).toEqual(ruleCatalog());
    expect(vendor.SEVERITY_ORDER).toEqual(SEVERITY_ORDER);

    for (const { name, workflow } of WORKFLOWS) {
      const fromSource = lintDefinition(workflow);
      const fromBundle = vendor.lintDefinition(workflow);
      expect(fromBundle, `${name}: 浏览器产物与源码的校验结果数量不一致`).toHaveLength(
        fromSource.length,
      );
      const strip = (f: Finding) => ({
        rule: f.rule,
        severity: f.severity,
        path: f.path,
        message: f.message,
        fix: f.fix,
      });
      expect(fromBundle.map(strip), `${name}: 浏览器产物与源码的校验结果不一致`).toEqual(
        fromSource.map(strip),
      );
    }
  });

  it("规则手册文档里列出的规则号都真实存在（文档不能凭空多出规则）", () => {
    // 已知缺口：文档已描述、代码尚未实现的规则。实现后应从这里移除。
    const KNOWN_DOC_ONLY = new Set(["D6"]);

    const doc = readFileSync(DOC_RULES, "utf8");
    const catalogIds = new Set(ruleCatalog().map((r) => r.id));
    const mentioned = new Set(
      [...doc.matchAll(/^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\d+)\s*\|/gm)]
        .map((m) => m[1])
        .filter((id): id is string => Boolean(id)),
    );

    expect(mentioned.size).toBeGreaterThan(0);
    for (const id of mentioned) {
      if (KNOWN_DOC_ONLY.has(id)) continue;
      expect(catalogIds.has(id), `文档里的规则 ${id} 在代码里不存在`).toBe(true);
    }
  });

  it("viewer 源码里没有自己的规则实现（不出现规则号，也不自带级别表）", () => {
    const sources = ["app.js", "graph.js", "mermaid.js"]
      .map((file) => `${VIEWER}/${file}`)
      .filter((file) => existsSync(file));

    for (const file of sources) {
      const code = readFileSync(file, "utf8");
      for (const rule of ruleCatalog()) {
        // 规则号只允许出现在注释里，不允许作为字符串字面量硬编码
        const literal = new RegExp(`["'\`]${rule.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
        expect(literal.test(code), `${file} 里硬编码了规则 ${rule.id}`).toBe(false);
      }
      // 级别顺序必须来自 conductor-validate，不能自己抄一份排序表
      expect(code, `${file} 里自己定义了一份严重级别排序表`).not.toMatch(
        /CRITICAL:\s*0\s*,\s*WARN:\s*1/,
      );
    }

    // app.js 必须从浏览器产物里取规则与级别顺序
    const app = readFileSync(`${VIEWER}/app.js`, "utf8");
    expect(app).toMatch(/from "\.\/vendor\/core\.js"/);
    expect(app).toMatch(/SEVERITY_ORDER/);
  });
});
