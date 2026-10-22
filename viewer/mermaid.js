/**
 * 把 WorkflowDef 转成 Mermaid flowchart 文本，便于贴进 Markdown / PR / 文档。
 */
import { buildGraph, DECISION_TYPES } from "./graph.js";

function mermaidId(ref, index) {
  return `n${index}`;
}

function escapeLabel(text) {
  return String(text ?? "")
    .replace(/"/g, "#quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "#124;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;")
    .replace(/\n/g, "<br/>");
}

export function toMermaid(workflowDef) {
  const graph = buildGraph(workflowDef);
  const idByRef = new Map();
  graph.order.forEach((ref, i) => idByRef.set(ref, mermaidId(ref, i)));

  const lines = [];
  lines.push("```mermaid");
  lines.push("flowchart TD");

  for (const ref of graph.order) {
    const node = graph.nodes.get(ref);
    if (!node) continue;
    const id = idByRef.get(ref);
    const label = escapeLabel(`${node.name} · ${node.type}`);
    if (ref === graph.start) {
      lines.push(`    ${id}(("start"))`);
    } else if (ref === graph.end) {
      lines.push(`    ${id}(("end"))`);
    } else if (DECISION_TYPES.has(node.type)) {
      lines.push(`    ${id}{"${label}"}`);
    } else if (node.type === "FORK_JOIN" || node.type === "FORK_JOIN_DYNAMIC") {
      lines.push(`    ${id}[["${label}"]]`);
    } else if (node.type === "DO_WHILE" || node.type === "DO_WHILE_END") {
      lines.push(`    ${id}["${label}"]`);
    } else {
      lines.push(`    ${id}["${label}"]`);
    }
  }

  for (const edge of graph.edges) {
    const from = idByRef.get(edge.from);
    const to = idByRef.get(edge.to);
    if (!from || !to) continue;
    if (edge.label) {
      lines.push(`    ${from} -->|${escapeLabel(edge.label)}| ${to}`);
    } else {
      lines.push(`    ${from} --> ${to}`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}
