# conductor-validate

Validate Conductor workflow definitions — **before** you register them.

Conductor's server validates the *shape* of a workflow at registration time
(required fields, task types, unique reference names) but it does not validate
the *wiring*. A workflow with a `FORK_JOIN` that has no `JOIN`, a `JOIN` whose
`joinOn` points at nothing, or a `SWITCH` whose expression can never match will
be **accepted** and then fail (or hang forever) at runtime. `conductor-validate`
finds those before they reach production.

- **Offline** — no server, no network, no runtime dependencies (Node 18+, stdlib only).
- **Online** — optionally ask a running Conductor for its own verdict via
  `POST /metadata/workflow/validate` (nothing is persisted).
- **Machine-readable** — `text`, `json`, GitHub Actions annotations, SARIF 2.1.0.
- **Rules with evidence** — every rule in `docs/wiring-rules.md` points at the
  server source (or a live-server probe) that justifies it.
- **TypeScript** — the implementation, the CLI and the tests are all TypeScript.

Drop it into CI, a pre-commit hook, or any repo that stores workflow
definitions — it has no runtime dependencies and needs no Conductor server.

---

## Install

```bash
npm install -g conductor-validate        # from a package index
npm install conductor-validate           # as a project dependency
```

From a checkout:

```bash
npm install
npm run build
node dist/cli.js workflow.json
```

No install needed either — the package has no runtime dependencies, so the
compiled output runs on a bare Node:

```bash
npm run build && node dist/cli.js workflow.json
```

## Use

```bash
# offline lint — reports only CRITICAL by default
conductor-validate workflow.json

# include warnings / informational notes
conductor-validate workflow.json --severity WARN
conductor-validate workflow.json --severity INFO

# several files, machine-readable output
conductor-validate a.json b.json --format json
conductor-validate a.json --format github     # GitHub Actions annotations
conductor-validate a.json --format sarif      # GitHub code scanning

# from stdin
cat workflow.json | conductor-validate -

# the rule catalogue
conductor-validate rules
conductor-validate rules --format json

# ask a live server for its own verdict (does not persist anything)
conductor-validate server workflow.json --server http://localhost:8080/api

# lint a workflow that is already registered
conductor-validate lint --name my_workflow --server http://localhost:8080/api
```

Environment variables: `CONDUCTOR_SERVER_URL`, `CONDUCTOR_AUTH_TOKEN`, `CONDUCTOR_TIMEOUT`.

**Exit codes**: `0` clean · `1` findings at or above the threshold · `2` usage/IO error.

## What it checks

| Group | What |
|---|---|
| `S*` | Mirrors of the server's own bean validation — a definition that passes these registers without a 400. |
| `W*` | Structural wiring: `FORK_JOIN` needs a `JOIN`, `joinOn` must name the real branch terminals, `TERMINATE` must be last, reference names must be unique, branch convergence. |
| `G-*` | Per-task-type usage: required fields, illegal combinations, deprecated task types, evaluation-mode semantics. |
| `D*` | Data flow: `${...}` placeholder syntax, scope whitelist, dangling references, GraalJS `$` binding. |

Full catalogue with source evidence: **[docs/wiring-rules.md](docs/wiring-rules.md)** ·
what the server really checks: **[docs/server-validation.md](docs/server-validation.md)**

### A few examples of what it catches

```
$ conductor-validate workflow.json --severity WARN
workflow: workflow.json
findings: CRITICAL=1 WARN=2 INFO=5
------------------------------------------------------------------------
[CRITICAL]
  tasks[1]
    (W4) joinOn 里的 ['c_ref'] 不是任何分支的最后一个任务
    fix: joinOn 应为 ['a_ref', 'b_ref']；列错会提前放行或永久挂起
```

Things the server does **not** catch, that this tool does:

- `FORK_JOIN` with no `JOIN` after it → whole workflow dies with `TerminateWorkflowException`
- `JOIN.joinOn` naming a task that does not exist → JOIN hangs forever
- `TERMINATE` in the middle of a chain → the tasks after it silently never run
- `SWITCH` with `evaluatorType: value-param` whose `expression` is not a key of the
  task's `inputParameters` → the expression evaluates to `null` and the branch is skipped
- `SWITCH` with `evaluatorType: javascript` using `$.workflow.input.x` → `undefined`,
  the workflow fails (for `SWITCH`, `$` is the task's own input map; `$.workflow` only
  exists for `INLINE` / `DO_WHILE` / `LAMBDA` tasks)
- `TERMINATE` using `inputParameters.status` instead of `inputParameters.terminationStatus`
- `WAIT` using ISO-8601 durations (`PT10S`) → the server rejects the definition

## As a library

```ts
import { lintDefinition, ruleCatalog } from "conductor-validate";

for (const finding of lintDefinition(workflow)) {
  console.log(finding.severity, finding.rule, finding.path, finding.message);
}

console.log(ruleCatalog().length, "rules");
```

The online half lives behind the same package:

```ts
import { ServerConfig, validateDefinition } from "conductor-validate";

const config = ServerConfig.fromEnv({ baseUrl: "http://localhost:8080/api" });
const errors = await validateDefinition(workflow, config);
```

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/
```

The project is written in strict TypeScript (`strict`, `noUncheckedIndexedAccess`)
and ships **no runtime dependencies** — only Node's standard library is used.

## Layout

```
src/
  core.ts     rule catalogue + the linter (pure, no I/O)
  report.ts   text / json / github / sarif formatters
  server.ts   optional live-server validation
  cli.ts      argument parsing + the command line front end
  types.ts    the shape of a workflow definition
  util.ts     runtime accessors for untrusted JSON
  index.ts    public API
docs/         rule manual + server-behaviour notes
examples/     a clean workflow and one with known problems
tests/        vitest suite
```

## License

Apache-2.0
