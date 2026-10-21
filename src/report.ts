/**
 * Presentation layer: turn findings into text, JSON, GitHub annotations or SARIF.
 *
 * Kept apart from `core.ts` so the validation logic has no knowledge of
 * output formats.
 */

import { findingToDict, type Finding, type FindingDict, type Linter, type RuleDefinition, ruleCatalog, SEVERITY_ORDER, type Severity } from "./core.js";

export const SARIF_LEVELS: Record<Severity, string> = {
  CRITICAL: "error",
  WARN: "warning",
  INFO: "note",
};

/** Findings at or above `threshold` (CRITICAL < WARN < INFO). */
export function filterBySeverity(findings: readonly Finding[], threshold: Severity): Finding[] {
  const limit = SEVERITY_ORDER[threshold];
  return findings.filter((finding) => SEVERITY_ORDER[finding.severity] <= limit);
}

/**
 * Attach the source file, the task reference name and a line number.
 *
 * The linter reports a *structural* path (`tasks[3].decisionCases.c1[0]`);
 * the line number is recovered by looking the task's `taskReferenceName` up
 * in the raw file text, which is accurate because reference names are unique
 * within a workflow.
 */
export function annotate(
  findings: readonly Finding[],
  linter: Linter | null,
  fileLabel: string,
  sourceText = "",
): Finding[] {
  const lines = sourceText.split(/\r?\n/);
  for (const finding of findings) {
    finding.file = fileLabel;
    const node = linter ? linter.nodeForPath(finding.path) : null;
    if (node !== null) {
      finding.ref = node.ref;
    }
    if (node !== null && node.ref && lines.length > 0) {
      const needle = `"${node.ref}"`;
      const index = lines.findIndex((line) => line.includes(needle));
      if (index >= 0) {
        finding.line = index + 1;
      }
    }
  }
  return [...findings];
}

/** Human-readable report, grouped by severity. */
export function formatText(findings: readonly Finding[], label = "", threshold: Severity = "CRITICAL"): string {
  const shown = filterBySeverity(findings, threshold);
  const counts: Record<Severity, number> = { CRITICAL: 0, WARN: 0, INFO: 0 };
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }

  const lines: string[] = [];
  if (label) {
    lines.push(`workflow: ${label}`);
  }
  lines.push(
    `findings: CRITICAL=${counts.CRITICAL} WARN=${counts.WARN} INFO=${counts.INFO}`,
  );
  lines.push("-".repeat(72));
  if (shown.length === 0) {
    lines.push("没有达到该级别的问题。");
    return lines.join("\n");
  }

  for (const severity of ["CRITICAL", "WARN", "INFO"] as const) {
    const group = shown.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push("");
    lines.push(`[${severity}]`);
    for (const finding of group) {
      let location = finding.path;
      if (finding.line) {
        location = `${location} (line ${finding.line})`;
      }
      lines.push(`  ${location}`);
      lines.push(`    (${finding.rule}) ${finding.message}`);
      if (finding.fix) {
        lines.push(`    fix: ${finding.fix}`);
      }
    }
  }
  return lines.join("\n");
}

/** Machine-readable report: a JSON array of finding objects. */
export function formatJson(findings: readonly Finding[], threshold: Severity = "CRITICAL"): string {
  const payload: FindingDict[] = filterBySeverity(findings, threshold).map(findingToDict);
  return JSON.stringify(payload, null, 2);
}

function escapeGithub(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** GitHub Actions workflow commands (`::error file=...,line=...::message`). */
export function formatGithub(findings: readonly Finding[], threshold: Severity = "CRITICAL"): string {
  const lines: string[] = [];
  for (const finding of filterBySeverity(findings, threshold)) {
    const level = SARIF_LEVELS[finding.severity] ?? "notice";
    const attrs = [`file=${finding.file || "<stdin>"}`];
    if (finding.line) {
      attrs.push(`line=${finding.line}`);
    }
    attrs.push(`title=${finding.rule}`);
    let message = finding.message;
    if (finding.fix) {
      message = `${message} — ${finding.fix}`;
    }
    lines.push(`::${level} ${attrs.join(",")}::${escapeGithub(message)}`);
  }
  return lines.join("\n");
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
}

/** SARIF 2.1.0 report for GitHub code scanning. */
export function formatSarif(
  findings: readonly Finding[],
  label = "workflow.json",
  threshold: Severity = "CRITICAL",
): string {
  const catalog = new Map<string, RuleDefinition>(ruleCatalog().map((rule) => [rule.id, rule]));
  const rules: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];

  for (const finding of filterBySeverity(findings, threshold)) {
    const rule = catalog.get(finding.rule) ?? { id: finding.rule, severity: "INFO" as Severity, description: finding.message };
    if (!rules.some((item) => item.id === rule.id)) {
      rules.push({
        id: rule.id,
        name: rule.id,
        shortDescription: { text: rule.description },
        defaultConfiguration: {
          level: SARIF_LEVELS[rule.severity] ?? "note",
        },
      });
    }
    const physicalLocation: SarifLocation["physicalLocation"] = {
      artifactLocation: { uri: finding.file || label },
    };
    if (finding.line) {
      physicalLocation.region = { startLine: finding.line };
    }
    results.push({
      ruleId: finding.rule,
      level: SARIF_LEVELS[finding.severity] ?? "note",
      message: { text: finding.message },
      locations: [{ physicalLocation }],
    });
  }

  const document = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "conductor-validate",
            informationUri: "https://github.com/conductor-oss/conductor-validate",
            rules,
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(document, null, 2);
}
