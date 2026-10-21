/** Online-validation tests (server URL handling, config, error mapping). */

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEOUT,
  ServerConfig,
  ServerError,
  fetchWorkflow,
  normalizeBaseUrl,
  validateDefinition,
  type Transport,
} from "../src/server.js";

afterEach(() => {
  delete process.env.CONDUCTOR_SERVER_URL;
  delete process.env.CONDUCTOR_AUTH_TOKEN;
  delete process.env.CONDUCTOR_TIMEOUT;
});

function fakeTransport(status: number, body: string): Transport {
  return async () => ({ status, statusText: status >= 400 ? "Bad Request" : "OK", body });
}

describe("normalizeBaseUrl", () => {
  it.each([
    ["http://localhost:8080", "http://localhost:8080/api"],
    ["http://localhost:8080/", "http://localhost:8080/api"],
    ["http://localhost:8080/api", "http://localhost:8080/api"],
    ["https://conductor.example.com", "https://conductor.example.com/api"],
    ["https://conductor.example.com/orchestra", "https://conductor.example.com/orchestra"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });

  it.each(["", "localhost:8080", "ftp://x", "http://x?a=1"])("rejects %s", (raw) => {
    expect(() => normalizeBaseUrl(raw)).toThrow(ServerError);
  });
});

describe("ServerConfig.fromEnv", () => {
  it("reads the environment", () => {
    process.env.CONDUCTOR_SERVER_URL = "http://localhost:8080";
    process.env.CONDUCTOR_AUTH_TOKEN = " token ";
    process.env.CONDUCTOR_TIMEOUT = "12";
    const config = ServerConfig.fromEnv();
    expect(config.baseUrl).toBe("http://localhost:8080/api");
    expect(config.token).toBe("token");
    expect(config.timeout).toBe(12);
  });

  it("prefers explicit values", () => {
    process.env.CONDUCTOR_SERVER_URL = "http://localhost:8080";
    process.env.CONDUCTOR_AUTH_TOKEN = "from-env";
    const config = ServerConfig.fromEnv({ baseUrl: "https://other", token: "explicit", timeout: 5 });
    expect(config.baseUrl).toBe("https://other/api");
    expect(config.token).toBe("explicit");
    expect(config.timeout).toBe(5);
  });

  it("requires a server url", () => {
    expect(() => ServerConfig.fromEnv()).toThrow(ServerError);
  });

  it("has a default timeout", () => {
    const config = new ServerConfig("http://localhost:8080/api");
    expect(config.timeout).toBe(DEFAULT_TIMEOUT);
  });
});

describe("validateDefinition", () => {
  const definition = { name: "t_wf", version: 1, schemaVersion: 2, tasks: [] };

  it("returns no errors when the server accepts the definition", async () => {
    const errors = await validateDefinition(definition, new ServerConfig("http://x/api"), fakeTransport(200, ""));
    expect(errors).toEqual([]);
  });

  it("parses the validation errors the server reports", async () => {
    const body = JSON.stringify({
      validationErrors: [{ path: "tasks[0].name", message: "must not be null" }],
    });
    const errors = await validateDefinition(definition, new ServerConfig("http://x/api"), fakeTransport(400, body));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("tasks[0].name");
    expect(errors[0]?.message).toBe("must not be null");
  });

  it("maps a connection failure to a ServerError", async () => {
    const transport: Transport = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(
      validateDefinition(definition, new ServerConfig("http://127.0.0.1:1/api"), transport),
    ).rejects.toThrow(/无法连接/);
  });

  it("reports an unreachable server", async () => {
    const config = new ServerConfig("http://127.0.0.1:1/api", "", 2);
    await expect(validateDefinition(definition, config)).rejects.toThrow(ServerError);
  });

  it("reports a non-JSON answer", async () => {
    const transport = fakeTransport(200, "<html>not json</html>");
    await expect(
      validateDefinition(definition, new ServerConfig("http://x/api"), transport),
    ).rejects.toThrow(/不是 JSON/);
  });
});

describe("fetchWorkflow", () => {
  it("returns the definition", async () => {
    const body = JSON.stringify({ name: "t_wf", version: 1, tasks: [] });
    const definition = await fetchWorkflow(
      "t_wf",
      new ServerConfig("http://x/api"),
      undefined,
      fakeTransport(200, body),
    );
    expect(definition.name).toBe("t_wf");
  });

  it("escapes the workflow name", async () => {
    let seen = "";
    const transport: Transport = async (request) => {
      seen = request.url;
      return { status: 200, statusText: "OK", body: "{}" };
    };
    await fetchWorkflow("a/b", new ServerConfig("http://x/api"), 3, transport);
    expect(seen).toBe("http://x/api/metadata/workflow/a%2Fb?version=3");
  });
});
