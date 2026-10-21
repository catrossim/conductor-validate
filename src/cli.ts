#!/usr/bin/env node
/**
 * Command line interface for `conductor-validate`.
 *
 * The argument parser is hand-written on purpose: the tool ships with zero
 * runtime dependencies, and the surface it needs (three subcommands, a handful
 * of options) does not justify a parser library.
 */

import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Linter, type Finding, type Severity, ruleCatalog, SEVERITY_ORDER } from "./core.js";
import { annotate, filterBySeverity, formatGithub, formatJson, formatSarif, formatText } from "./report.js";
import { ServerConfig, ServerError, fetchWorkflow, validateDefinition } from "./server.js";
import type { WorkflowDefinition } from "./types.js";
import { VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export const COMMANDS = ["lint", "rules", "server"] as const;

export type Command = (typeof COMMANDS)[number];

type OptionType = "string" | "number" | "boolean";

interface OptionSpec {
  type: OptionType;
  choices?: readonly string[];
}

const SEVERITY_CHOICES = Object.keys(SEVERITY_ORDER) as readonly string[];

const LINT_OPTIONS: Record<string, OptionSpec> = {
  "--severity": { type: "string", choices: SEVERITY_CHOICES },
  "--format": { type: "string", choices: ["text", "json", "github", "sarif"] },
  "--name": { type: "string" },
  "--server": { type: "string" },
  "--auth-token": { type: "string" },
  "--timeout": { type: "number" },
  "--quiet": { type: "boolean" },
};

const RULES_OPTIONS: Record<string, OptionSpec> = {
  "--format": { type: "string", choices: ["text", "json"] },
};

const SERVER_OPTIONS: Record<string, OptionSpec> = {
  "--severity": { type: "string", choices: SEVERITY_CHOICES },
  "--format": { type: "string", choices: ["text", "json"] },
  "--server": { type: "string" },
  "--auth-token": { type: "string" },
  "--timeout": { type: "number" },
};

/** Every option that consumes a value — needed before the command is known. */
const VALUE_OPTIONS = new Set([
  "--severity",
  "--format",
  "--name",
  "--server",
  "--auth-token",
  "--timeout",
]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedArgs {
  command: Command;
  positionals: string[];
  options: Record<string, string | number | boolean>;
}

function optionSpecFor(command: Command): Record<string, OptionSpec> {
  if (command === "rules") return RULES_OPTIONS;
  if (command === "server") return SERVER_OPTIONS;
  return LINT_OPTIONS;
}

/** The command name, if the first positional is one of the subcommands. */
function detectCommand(argv: readonly string[]): Command | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") break;
    if (token.startsWith("-")) {
      const name = token.split("=")[0] ?? token;
      if (VALUE_OPTIONS.has(name) && !token.includes("=")) {
        index += 1;
      }
      continue;
    }
    const command = COMMANDS.find((candidate) => candidate === token);
    return command ?? null;
  }
  return null;
}

/** Parse the command line. Throws `UsageError` on anything unexpected. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const detected = detectCommand(argv);
  const command: Command = detected ?? "lint";
  const specs = optionSpecFor(command);

  const positionals: string[] = [];
  const options: Record<string, string | number | boolean> = {};
  let positionalIndex = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals >= 0 ? token.slice(0, equals) : token;
      const spec = specs[name];
      if (!spec) {
        throw new UsageError(`未知参数：${name}`);
      }
      if (spec.type === "boolean") {
        if (equals >= 0) {
          throw new UsageError(`参数 ${name} 不接受取值`);
        }
        options[name] = true;
        continue;
      }
      let raw: string | undefined;
      if (equals >= 0) {
        raw = token.slice(equals + 1);
      } else {
        raw = argv[index + 1];
        index += 1;
      }
      if (raw === undefined) {
        throw new UsageError(`参数 ${name} 缺少取值`);
      }
      if (spec.choices && !spec.choices.includes(raw)) {
        throw new UsageError(`参数 ${name} 的取值必须是 ${spec.choices.join(" | ")}（收到 ${raw}）`);
      }
      if (spec.type === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new UsageError(`参数 ${name} 必须是数字（收到 ${raw}）`);
        }
        options[name] = value;
      } else {
        options[name] = raw;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      throw new UsageError(`未知参数：${token}`);
    }
    // The first positional may be the subcommand name.
    if (positionalIndex === 0 && detected !== null && token === detected) {
      positionalIndex += 1;
      continue;
    }
    positionals.push(token);
    positionalIndex += 1;
  }

  return { command, positionals, options };
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

const USAGE = `usage: conductor-validate [-h] {lint,rules,server} ...

Validate Conductor workflow definitions: node wiring, node usage and data flow.
Offline by default; \`server\` additionally asks a running Conductor to validate
the definition with its own bean validation.

commands:
  lint    offline lint of one or more workflow definitions
  rules   print the rule catalogue
  server  validate definitions against a running Conductor

lint options:
  --severity {CRITICAL,WARN,INFO}  lowest severity to report (default CRITICAL)
  --format {text,json,github,sarif}  output format (default text)
  --name NAME                      lint a registered workflow by name
  --server URL                     Conductor server base URL
  --auth-token TOKEN               server token (default CONDUCTOR_AUTH_TOKEN)
  --timeout SECONDS                server timeout in seconds
  --quiet                          only print the summary`;

interface Source {
  label: string;
  text: string;
  definition: WorkflowDefinition;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a workflow definition from a path or from stdin (`-`). */
export async function readSource(path: string): Promise<Source> {
  let text: string;
  let label: string;
  if (path === "-") {
    text = await readStdin();
    label = "<stdin>";
  } else {
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`无法读取 ${path}: ${reason}`);
    }
    label = path;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 不是合法 JSON: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}: 工作流定义必须是 JSON 对象`);
  }
  return { label, text, definition: parsed as WorkflowDefinition };
}

function serverConfigFrom(options: Record<string, string | number | boolean>): ServerConfig {
  return ServerConfig.fromEnv({
    baseUrl: options["--server"] as string | undefined,
    token: options["--auth-token"] as string | undefined,
    timeout: options["--timeout"] as number | undefined,
  });
}

function severityOf(options: Record<string, string | number | boolean>): Severity {
  return (options["--severity"] as Severity | undefined) ?? "CRITICAL";
}

async function runLint(parsed: ParsedArgs): Promise<number> {
  const { options, positionals } = parsed;
  const severity = severityOf(options);
  const format = (options["--format"] as string | undefined) ?? "text";
  const targets: Source[] = [];

  const name = options["--name"] as string | undefined;
  if (name) {
    let config: ServerConfig;
    try {
      config = serverConfigFrom(options);
    } catch (error) {
      printError(`Error: ${(error as Error).message}`);
      return EXIT_ERROR;
    }
    try {
      const definition = await fetchWorkflow(name, config);
      targets.push({ label: name, text: JSON.stringify(definition, null, 2), definition });
    } catch (error) {
      printError(`Error: ${(error as Error).message}`);
      return EXIT_ERROR;
    }
  }

  for (const path of positionals) {
    let source: Source;
    try {
      source = await readSource(path);
    } catch (error) {
      printError(`Error: ${(error as Error).message}`);
      return EXIT_ERROR;
    }
    targets.push(source);
  }

  if (targets.length === 0) {
    printError(
      "Error: 没有可校验的工作流定义（给一个文件路径，或用 --name 指定已注册的工作流）",
    );
    return EXIT_ERROR;
  }

  const allFindings: Finding[] = [];
  for (const target of targets) {
    const linter = new Linter(target.definition);
    const findings = linter.run();
    annotate(findings, linter, target.label, target.text);
    allFindings.push(...findings);
  }

  if (format === "json") {
    print(formatJson(allFindings, severity));
  } else if (format === "github") {
    print(formatGithub(allFindings, severity));
  } else if (format === "sarif") {
    print(formatSarif(allFindings, targets[0]?.label ?? "workflow.json", severity));
  } else {
    if (!options["--quiet"]) {
      for (const target of targets) {
        const labelFindings = allFindings.filter((finding) => finding.file === target.label);
        const name2 = String(target.definition.name ?? "");
        const header = name2 && name2 !== target.label ? name2 : target.label;
        if (name2 && name2 !== target.label) {
          print(formatText(labelFindings, `${header}  (${target.label})`, severity));
        } else {
          print(formatText(labelFindings, header, severity));
        }
        print("");
      }
    }
    const shown = filterBySeverity(allFindings, severity);
    if (shown.length > 0) {
      print(`${shown.length} 个问题（阈值 ${severity}）`);
    }
  }

  return filterBySeverity(allFindings, severity).length > 0 ? EXIT_FINDINGS : EXIT_OK;
}

function runRules(parsed: ParsedArgs): number {
  const catalog = ruleCatalog();
  const format = (parsed.options["--format"] as string | undefined) ?? "text";
  if (format === "json") {
    print(JSON.stringify(catalog, null, 2));
    return EXIT_OK;
  }
  const width = Math.max(...catalog.map((rule) => rule.id.length));
  for (const rule of catalog) {
    print(`${rule.id.padEnd(width)}  ${rule.severity.padEnd(8)}  ${rule.description}`);
  }
  return EXIT_OK;
}

async function runServer(parsed: ParsedArgs): Promise<number> {
  const { options, positionals } = parsed;
  const format = (options["--format"] as string | undefined) ?? "text";
  let config: ServerConfig;
  try {
    config = serverConfigFrom(options);
  } catch (error) {
    printError(`Error: ${(error as Error).message}`);
    return EXIT_ERROR;
  }
  if (positionals.length === 0) {
    printError("Error: 请给至少一个工作流定义文件");
    return EXIT_ERROR;
  }

  let failures = 0;
  const results: Array<{ file: string; errors: Array<{ path?: string; message?: string }> }> = [];
  for (const path of positionals) {
    let source: Source;
    try {
      source = await readSource(path);
    } catch (error) {
      printError(`Error: ${(error as Error).message}`);
      return EXIT_ERROR;
    }
    let errors: Array<{ path: string; message: string; invalidValue?: unknown }>;
    try {
      errors = await validateDefinition(source.definition, config);
    } catch (error) {
      if (error instanceof ServerError) {
        printError(`Error: ${error.message}`);
        return EXIT_ERROR;
      }
      throw error;
    }
    results.push({ file: source.label, errors });
    if (errors.length > 0) {
      failures += 1;
    }
  }

  if (format === "json") {
    print(JSON.stringify({ server: config.baseUrl, results }, null, 2));
  } else {
    print(`server: ${config.baseUrl}`);
    for (const entry of results) {
      if (entry.errors.length === 0) {
        print(`  ${entry.file}: OK`);
        continue;
      }
      print(`  ${entry.file}: ${entry.errors.length} 个服务端校验错误`);
      for (const error of entry.errors) {
        const where = error.path || "workflow";
        print(`    ${where}: ${error.message ?? ""}`);
      }
    }
  }
  return failures > 0 ? EXIT_FINDINGS : EXIT_OK;
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--version") || argv.includes("-V")) {
    print(`conductor-validate ${VERSION}`);
    return EXIT_OK;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    print(USAGE);
    return EXIT_OK;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      printError(`Error: ${error.message}`);
      printError(USAGE);
      return EXIT_ERROR;
    }
    throw error;
  }

  if (parsed.command === "rules") {
    return runRules(parsed);
  }
  if (parsed.command === "server") {
    return runServer(parsed);
  }
  if (parsed.positionals.length === 0 && !parsed.options["--name"]) {
    printError("Error: 没有可校验的工作流定义（给一个文件路径，或用 --name 指定已注册的工作流）");
    printError(USAGE);
    return EXIT_ERROR;
  }
  return runLint(parsed);
}

/**
 * Whether this file is the process entry point.
 *
 * `process.argv[1]` may be a symlink (npm's global `bin` shim), so both paths
 * are resolved before they are compared.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      printError(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT_ERROR;
    });
}
