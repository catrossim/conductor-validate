/**
 * conductor-validate — validate Conductor workflow definitions.
 *
 * Two layers:
 *
 * * **offline** (`lintDefinition`) — structural, usage and data-flow rules
 *   that the Conductor server does *not* enforce at registration time;
 * * **online** (`validateDefinition`) — the server's own bean validation, via
 *   `POST /metadata/workflow/validate`.
 *
 * Both are dependency-free — only Node's standard library is used.
 */

export { VERSION } from "./version.js";

export type { JsonObject, JsonPrimitive, JsonValue, WorkflowDefinition, WorkflowTask } from "./types.js";

export {
  Linter,
  PLACEHOLDER_FIELDS,
  RULES,
  SEVERITY_ORDER,
  TASK_PARAM_SCOPES,
  WORKFLOW_SCOPES,
  findingToDict,
  lintDefinition,
  ruleCatalog,
  severityOf,
} from "./core.js";
export type { Finding, FindingDict, Node, RuleDefinition, Severity } from "./core.js";

export {
  SARIF_LEVELS,
  annotate,
  filterBySeverity,
  formatGithub,
  formatJson,
  formatSarif,
  formatText,
} from "./report.js";

export { DEFAULT_TIMEOUT, ServerConfig, ServerError, fetchWorkflow, nodeTransport, normalizeBaseUrl, validateDefinition } from "./server.js";
export type { HttpRequestSpec, HttpResponseSpec, ServerValidationError, Transport } from "./server.js";
