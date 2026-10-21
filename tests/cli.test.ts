/** CLI behaviour and output-format tests. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";

const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));
const VALID = join(EXAMPLES, "valid_workflow.json");
const BROKEN = join(EXAMPLES, "workflow_with_issues.json");

interface Capture {
  out: () => string;
  err: () => string;
  stop: () => void;
}

function capture(): Capture {
  let out = "";
  let err = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  return {
    out: () => out,
    err: () => err,
    stop: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lint command", () => {
  it("exits zero for a valid workflow", async () => {
    const io = capture();
    expect(await main([VALID])).toBe(0);
    expect(io.out()).toContain("CRITICAL=0");
    io.stop();
  });

  it("exits one for a broken workflow", async () => {
    const io = capture();
    expect(await main([BROKEN])).toBe(1);
    expect(io.out()).toContain("CRITICAL=");
    io.stop();
  });

  it("defaults to the lint subcommand", async () => {
    const io = capture();
    const implicit = await main([VALID]);
    io.stop();
    const explicitIo = capture();
    const explicit = await main(["lint", VALID]);
    explicitIo.stop();
    expect(implicit).toBe(explicit);
  });

  it("hides INFO findings below the threshold", async () => {
    const io = capture();
    expect(await main([VALID, "--severity", "CRITICAL"])).toBe(0);
    expect(io.out()).toContain("CRITICAL=0");
    io.stop();
  });

  it("reports INFO findings at the INFO threshold", async () => {
    const io = capture();
    await main([VALID, "--severity", "INFO"]);
    expect(io.out()).toContain("INFO=");
    io.stop();
  });

  it("accepts --severity=INFO", async () => {
    const io = capture();
    await main([VALID, "--severity=INFO"]);
    expect(io.out()).toContain("INFO=");
    io.stop();
  });

  it("emits valid JSON", async () => {
    const io = capture();
    await main([BROKEN, "--format", "json"]);
    const payload = JSON.parse(io.out());
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBeGreaterThan(0);
    expect(Object.keys(payload[0])).toEqual(
      expect.arrayContaining(["rule", "severity", "path", "message"]),
    );
    io.stop();
  });

  it("emits GitHub workflow commands", async () => {
    const io = capture();
    await main([BROKEN, "--format", "github"]);
    expect(io.out()).toContain("::error ");
    io.stop();
  });

  it("emits valid SARIF", async () => {
    const io = capture();
    await main([BROKEN, "--format", "sarif"]);
    const payload = JSON.parse(io.out());
    expect(payload.version).toBe("2.1.0");
    expect(payload.runs[0].tool.driver.name).toBe("conductor-validate");
    expect(payload.runs[0].results.length).toBeGreaterThan(0);
    io.stop();
  });

  it("carries a line number", async () => {
    const io = capture();
    await main([BROKEN, "--format", "json"]);
    const payload = JSON.parse(io.out());
    expect(payload.some((item: { line?: number }) => item.line)).toBe(true);
    io.stop();
  });

  it("reads from stdin", async () => {
    const payload = await import("node:fs").then((fs) => fs.readFileSync(VALID, "utf8"));
    const original = process.stdin;
    Object.defineProperty(process, "stdin", {
      value: Readable.from([payload]),
      configurable: true,
    });
    const io = capture();
    const code = await main(["lint", "-"]);
    io.stop();
    Object.defineProperty(process, "stdin", { value: original, configurable: true });
    expect(code).toBe(0);
  });

  it("reports a missing file as an error", async () => {
    const io = capture();
    expect(await main(["lint", "/nonexistent/workflow.json"])).toBe(2);
    expect(io.err()).toContain("Error");
    io.stop();
  });

  it("reports invalid JSON as an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-validate-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    const io = capture();
    expect(await main(["lint", bad])).toBe(2);
    expect(io.err()).toContain("Error");
    io.stop();
  });

  it("rejects an unknown option", async () => {
    const io = capture();
    expect(await main([VALID, "--nope"])).toBe(2);
    expect(io.err()).toContain("Error");
    io.stop();
  });

  it("rejects an invalid severity", async () => {
    const io = capture();
    expect(await main([VALID, "--severity", "LOUD"])).toBe(2);
    expect(io.err()).toContain("Error");
    io.stop();
  });

  it("treats an empty command line as a usage error", async () => {
    const io = capture();
    expect(await main([])).toBe(2);
    expect(io.err()).toContain("Error");
    io.stop();
  });
});

describe("rules command", () => {
  it("prints the catalogue as text", async () => {
    const io = capture();
    expect(await main(["rules"])).toBe(0);
    expect(io.out()).toContain("W3");
    expect(io.out()).toContain("G-SWITCH-5");
    io.stop();
  });

  it("prints the catalogue as JSON", async () => {
    const io = capture();
    expect(await main(["rules", "--format", "json"])).toBe(0);
    const payload = JSON.parse(io.out());
    expect(Object.keys(payload[0]).sort()).toEqual(["description", "id", "severity"]);
    io.stop();
  });
});

describe("version", () => {
  it("prints the version", async () => {
    const io = capture();
    expect(await main(["--version"])).toBe(0);
    expect(io.out()).toContain("conductor-validate");
    io.stop();
  });
});
