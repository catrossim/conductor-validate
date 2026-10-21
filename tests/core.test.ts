/** Rule-level tests for the offline validation core. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Finding, Linter, lintDefinition, ruleCatalog } from "../src/core.js";
import type { WorkflowDefinition, WorkflowTask } from "../src/types.js";

const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));

function rulesIn(findings: Finding[]): Set<string> {
  return new Set(findings.map((finding) => finding.rule));
}

function makeWorkflow(tasks: unknown[], extra: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    name: "t_wf",
    version: 1,
    schemaVersion: 2,
    tasks,
    ...extra,
  } as WorkflowDefinition;
}

function noop(ref: string, name = "a"): WorkflowTask {
  return { name, taskReferenceName: ref, type: "NOOP" };
}

// --------------------------------------------------------------- server mirrors
describe("server mirrors", () => {
  it("flags an empty workflow name", () => {
    const findings = lintDefinition(makeWorkflow([noop("a_ref")], { name: "" }));
    expect(rulesIn(findings)).toContain("S4");
  });

  it("flags empty tasks", () => {
    const findings = lintDefinition(makeWorkflow([]));
    expect(rulesIn(findings)).toContain("S1");
  });

  it("flags a task without a name", () => {
    const findings = lintDefinition(makeWorkflow([{ taskReferenceName: "a_ref", type: "NOOP" }]));
    expect(rulesIn(findings)).toContain("S2");
  });

  it.each([1, 3])("flags schemaVersion %i", (schema) => {
    const findings = lintDefinition(makeWorkflow([noop("a_ref")], { schemaVersion: schema }));
    expect(rulesIn(findings)).toContain("S3");
  });

  it("accepts schemaVersion 2", () => {
    const findings = lintDefinition(makeWorkflow([noop("a_ref")]));
    expect(rulesIn(findings)).not.toContain("S3");
  });
});

// ------------------------------------------------------------------ uniqueness
describe("reference name uniqueness", () => {
  it("flags duplicate reference names", () => {
    const findings = lintDefinition(makeWorkflow([noop("dup"), noop("dup", "b")]));
    expect(rulesIn(findings)).toContain("W2");
  });

  it("flags duplicate reference names across nesting levels", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "value-param",
        expression: "k",
        decisionCases: { c: [noop("a_ref")] },
      },
      noop("a_ref", "b"),
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W2");
  });
});

// ------------------------------------------------------------------- fork/join
describe("fork / join", () => {
  it("flags a FORK_JOIN without a JOIN", () => {
    const tasks = [
      {
        name: "f",
        taskReferenceName: "f_ref",
        type: "FORK_JOIN",
        forkTasks: [[noop("a_ref")], [noop("b_ref", "b")]],
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W3");
  });

  it("flags a JOIN that misses a branch terminal", () => {
    const tasks = [
      {
        name: "f",
        taskReferenceName: "f_ref",
        type: "FORK_JOIN",
        forkTasks: [[noop("a_ref")], [noop("b_ref", "b")]],
      },
      { name: "j", taskReferenceName: "j_ref", type: "JOIN", joinOn: ["a_ref"] },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W4");
  });

  it("flags a JOIN that references an unknown task", () => {
    const tasks = [
      {
        name: "f",
        taskReferenceName: "f_ref",
        type: "FORK_JOIN",
        forkTasks: [[noop("a_ref")]],
      },
      { name: "j", taskReferenceName: "j_ref", type: "JOIN", joinOn: ["nope"] },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-JOIN-2");
  });

  it("accepts a correct FORK_JOIN / JOIN pair", () => {
    const tasks = [
      {
        name: "f",
        taskReferenceName: "f_ref",
        type: "FORK_JOIN",
        forkTasks: [[noop("a_ref")], [noop("b_ref", "b")]],
      },
      { name: "j", taskReferenceName: "j_ref", type: "JOIN", joinOn: ["a_ref", "b_ref"] },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("W3");
    expect(rulesIn(findings)).not.toContain("W4");
  });
});

// ------------------------------------------------------------------- terminate
describe("terminate", () => {
  it("requires the terminationStatus key", () => {
    const tasks = [
      {
        name: "t",
        taskReferenceName: "t_ref",
        type: "TERMINATE",
        inputParameters: { status: "COMPLETED" },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-TERM-2");
  });

  it("accepts terminationStatus", () => {
    const tasks = [
      {
        name: "t",
        taskReferenceName: "t_ref",
        type: "TERMINATE",
        inputParameters: { terminationStatus: "COMPLETED" },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("G-TERM-2");
  });

  it("cannot be optional", () => {
    const tasks = [
      {
        name: "t",
        taskReferenceName: "t_ref",
        type: "TERMINATE",
        optional: true,
        inputParameters: { terminationStatus: "COMPLETED" },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-TERM-1");
  });

  it("must be last", () => {
    const tasks = [
      {
        name: "t",
        taskReferenceName: "t_ref",
        type: "TERMINATE",
        inputParameters: { terminationStatus: "COMPLETED" },
      },
      noop("a_ref", "after"),
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W9");
  });
});

// ------------------------------------------------------------------------ wait
describe("wait", () => {
  it.each(["PT10S", "10", "abc"])("rejects the duration %s", (duration) => {
    const tasks = [
      {
        name: "w",
        taskReferenceName: "w_ref",
        type: "WAIT",
        inputParameters: { duration },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-WAIT-2");
  });

  it.each(["10 seconds", "5m", "1 hour 30 minutes"])("accepts the duration %s", (duration) => {
    const tasks = [
      {
        name: "w",
        taskReferenceName: "w_ref",
        type: "WAIT",
        inputParameters: { duration },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("G-WAIT-2");
  });

  it.each(["2030-01-01T00:00:00Z", "not-a-date"])("rejects the until value %s", (until) => {
    const tasks = [
      {
        name: "w",
        taskReferenceName: "w_ref",
        type: "WAIT",
        inputParameters: { until },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-WAIT-2");
  });

  it.each(["2030-01-01", "2030-01-01 10:30"])("accepts the until value %s", (until) => {
    const tasks = [
      {
        name: "w",
        taskReferenceName: "w_ref",
        type: "WAIT",
        inputParameters: { until },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("G-WAIT-2");
  });

  it("rejects duration and until together", () => {
    const tasks = [
      {
        name: "w",
        taskReferenceName: "w_ref",
        type: "WAIT",
        inputParameters: { duration: "5m", until: "2030-01-01" },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-WAIT-1");
  });

  it("only warns when neither is given", () => {
    const tasks = [
      { name: "w", taskReferenceName: "w_ref", type: "WAIT", inputParameters: {} },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    const gWait = findings.filter((finding) => finding.rule === "G-WAIT-3");
    expect(gWait).toHaveLength(1);
    expect(gWait[0]?.severity).toBe("WARN");
  });

  it("does not check placeholders", () => {
    const tasks = [
      {
        name: "w",
        taskReferenceName: "w_ref",
        type: "WAIT",
        inputParameters: { duration: "${workflow.input.d}" },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("G-WAIT-2");
  });
});

// ---------------------------------------------------------------------- switch
describe("switch", () => {
  it("requires the value-param expression to be an input key", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "value-param",
        expression: "${workflow.input.pick}",
        decisionCases: { c: [noop("a_ref")] },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-SWITCH-7");
  });

  it("accepts a value-param expression that is an input key", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "value-param",
        expression: "pick",
        inputParameters: { pick: "${workflow.input.pick}" },
        decisionCases: { c: [noop("a_ref")] },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("G-SWITCH-7");
  });

  it("flags $.workflow inside a javascript expression", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "javascript",
        expression: "$.workflow.input.pick",
        decisionCases: { c: [noop("a_ref")] },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("G-SWITCH-5");
  });

  it("accepts the task's own $ binding", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "javascript",
        expression: "$.pick",
        inputParameters: { pick: "${workflow.input.pick}" },
        decisionCases: { c: [noop("a_ref")] },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("G-SWITCH-5");
  });
});

// ------------------------------------------------------------- branch convergence
describe("branch convergence", () => {
  it("warns when a branch copies a top level successor", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "value-param",
        expression: "k",
        inputParameters: { k: "v" },
        decisionCases: { c: [noop("after_ref", "after")] },
      },
      noop("after_ref", "after"),
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W16");
  });

  it("reports the convergence point of a nested branch", () => {
    const tasks = [
      {
        name: "outer",
        taskReferenceName: "outer_ref",
        type: "SWITCH",
        evaluatorType: "value-param",
        expression: "k",
        inputParameters: { k: "v" },
        decisionCases: {
          c: [
            {
              name: "inner",
              taskReferenceName: "inner_ref",
              type: "SWITCH",
              evaluatorType: "value-param",
              expression: "k",
              inputParameters: { k: "v" },
              decisionCases: { c2: [noop("x_ref")] },
            },
          ],
        },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W15");
  });
});

// ------------------------------------------------------------------- data flow
describe("data flow", () => {
  it("flags a dangling reference", () => {
    const tasks = [noop("a_ref")];
    (tasks[0] as WorkflowTask).inputParameters = { x: "${missing_ref.output.y}" };
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("W13");
  });

  it("flags an unknown workflow scope", () => {
    const tasks = [noop("a_ref")];
    (tasks[0] as WorkflowTask).inputParameters = { x: "${workflow.nope}" };
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("D2");
  });

  it("flags a placeholder inside a javascript expression", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "javascript",
        expression: "$.x === ${workflow.input.y}",
        decisionCases: { c: [noop("a_ref")] },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).toContain("D8");
  });

  it("does not trip the javascript placeholder rule for value-param", () => {
    const tasks = [
      {
        name: "s",
        taskReferenceName: "s_ref",
        type: "SWITCH",
        evaluatorType: "value-param",
        expression: "pick",
        inputParameters: { pick: "${workflow.input.pick}" },
        decisionCases: { c: [noop("a_ref")] },
      },
    ];
    const findings = lintDefinition(makeWorkflow(tasks));
    expect(rulesIn(findings)).not.toContain("D8");
  });
});

// -------------------------------------------------------------------- examples
describe("examples", () => {
  it("keeps the valid example free of critical and warning findings", () => {
    const definition = JSON.parse(readFileSync(`${EXAMPLES}/valid_workflow.json`, "utf8"));
    const findings = lintDefinition(definition);
    const offenders = findings.filter((finding) => finding.severity === "CRITICAL" || finding.severity === "WARN");
    expect(offenders.map((finding) => finding.message)).toEqual([]);
  });

  it("triggers the expected rules on the broken example", () => {
    const definition = JSON.parse(readFileSync(`${EXAMPLES}/workflow_with_issues.json`, "utf8"));
    const found = rulesIn(lintDefinition(definition));
    for (const expected of ["W4", "W9", "W13"]) {
      expect(found).toContain(expected);
    }
  });
});

// -------------------------------------------------------------------- catalogue
describe("catalogue", () => {
  it("is consistent", () => {
    const catalog = ruleCatalog();
    expect(new Set(catalog.map((rule) => rule.id)).size).toBe(catalog.length);
    expect(catalog.every((rule) => ["CRITICAL", "WARN", "INFO"].includes(rule.severity))).toBe(true);
  });

  it("contains every reported rule", () => {
    const definition = JSON.parse(readFileSync(`${EXAMPLES}/workflow_with_issues.json`, "utf8"));
    const known = new Set(ruleCatalog().map((rule) => rule.id));
    for (const finding of lintDefinition(definition)) {
      expect(known).toContain(finding.rule);
    }
  });

  it("finds the owning task for a path", () => {
    const linter = new Linter(makeWorkflow([noop("a_ref")]));
    linter.run();
    const node = linter.nodeForPath("tasks[0].inputParameters.x");
    expect(node).not.toBeNull();
    expect(node?.ref).toBe("a_ref");
  });
});

// -------------------------------------------------- definition-level fixtures
describe("definition-level fixtures", () => {
  const cases: Array<[string, string]> = [
    ["s1_empty_tasks.json", "S1"],
    ["s2_task_without_name.json", "S2"],
    ["s3_schema_version_1.json", "S3"],
    ["s4_missing_name.json", "S4"],
  ];

  for (const [file, rule] of cases) {
    it(`${file} triggers exactly ${rule}`, () => {
      const definition = JSON.parse(readFileSync(`${EXAMPLES}/deflevel/${file}`, "utf8"));
      expect([...rulesIn(lintDefinition(definition))]).toEqual([rule]);
    });
  }
});

// ----------------------------------------------------------- manual playground
describe("manual playground", () => {
  it("flags the structural, usage and data-flow mistakes in the fixture", () => {
    const definition = JSON.parse(readFileSync(`${EXAMPLES}/manual_verify_workflow.json`, "utf8"));
    const found = rulesIn(lintDefinition(definition));
    for (const expected of ["W3", "W4", "W9", "W13", "D4", "D8", "G-SWITCH-7", "G-TERM-2"]) {
      expect(found).toContain(expected);
    }
  });
});
