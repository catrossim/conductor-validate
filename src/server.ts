/**
 * Optional live-server validation against a running Conductor instance.
 *
 * The offline linter (`core.ts`) covers the rules the server does *not*
 * enforce. This module adds the other half: it asks the server itself, using
 * `POST /metadata/workflow/validate` — the exact same bean validation that
 * registration runs, but without storing anything.
 *
 * It is optional on purpose: the tool stays useful with no server at all.
 *
 * The transport talks to the server directly (no proxy environment variables
 * are honoured), which is what a local Conductor needs: a global `http_proxy`
 * would otherwise turn every request into a confusing `502 Bad Gateway`.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { JsonObject, WorkflowDefinition } from "./types.js";

export const DEFAULT_TIMEOUT = 30;

const MAX_REDIRECTS = 5;

export interface HttpRequestSpec {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
}

export interface HttpResponseSpec {
  status: number;
  statusText: string;
  body: string;
  /** Response headers (lower-cased names), used for redirect handling. */
  headers?: Record<string, string | string[] | undefined>;
}

/** How a request reaches the server. Swap it out in tests. */
export type Transport = (request: HttpRequestSpec) => Promise<HttpResponseSpec>;

/** Raised when the server cannot be reached or answers unexpectedly. */
export class ServerError extends Error {
  /** The HTTP status code (if there was a response). */
  readonly status?: number;
  /** The raw response body. */
  readonly payload: string;

  constructor(message: string, status?: number, payload = "") {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.payload = payload;
  }
}

/** Where the server is and how to authenticate against it. */
export class ServerConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeout: number;

  constructor(baseUrl: string, token = "", timeout: number = DEFAULT_TIMEOUT) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeout = timeout;
  }

  /**
   * Build a config from explicit values and the environment.
   *
   * `CONDUCTOR_SERVER_URL`, `CONDUCTOR_AUTH_TOKEN` and `CONDUCTOR_TIMEOUT`
   * fill in whatever is not given explicitly.
   */
  static fromEnv(options: { baseUrl?: string; token?: string; timeout?: number } = {}): ServerConfig {
    const url = (options.baseUrl ?? process.env.CONDUCTOR_SERVER_URL ?? "").trim();
    if (!url) {
      throw new ServerError(
        "未指定 Conductor server：请用 --server http://host:port/api 或设置环境变量 CONDUCTOR_SERVER_URL",
      );
    }
    const token = options.token !== undefined ? options.token : (process.env.CONDUCTOR_AUTH_TOKEN ?? "");
    const timeout =
      options.timeout !== undefined
        ? options.timeout
        : Number(process.env.CONDUCTOR_TIMEOUT ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT;
    return new ServerConfig(normalizeBaseUrl(url), token.trim(), timeout);
  }
}

/**
 * Normalize a server URL to an API base (always ending in `/api`).
 *
 * `http://host:8080` and `http://host:8080/api` both become
 * `http://host:8080/api`; a custom deployment path is preserved.
 */
export function normalizeBaseUrl(value: string): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    throw new ServerError("server URL 不能为空");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ServerError(`server URL 必须是绝对 http(s) 地址：${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ServerError(`server URL 必须是绝对 http(s) 地址：${JSON.stringify(raw)}`);
  }
  if (!parsed.hostname) {
    throw new ServerError(`server URL 必须是绝对 http(s) 地址：${JSON.stringify(raw)}`);
  }
  if (parsed.search || parsed.hash) {
    throw new ServerError("server URL 不能带 query 或 fragment");
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path) {
    path = "/api";
  }
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** The default transport: a direct HTTP(S) request, no proxy involved. */
export const nodeTransport: Transport = (spec) =>
  new Promise<HttpResponseSpec>((resolve, reject) => {
    const url = new URL(spec.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: spec.method,
        headers: spec.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
      },
    );
    req.setTimeout(spec.timeout, () => {
      req.destroy(new Error(`timeout after ${spec.timeout}s`));
    });
    req.on("error", reject);
    if (spec.body !== undefined) {
      req.write(spec.body);
    }
    req.end();
  });

async function request(
  config: ServerConfig,
  path: string,
  method = "GET",
  body?: JsonObject | WorkflowDefinition,
  transport: Transport = nodeTransport,
): Promise<unknown> {
  let url = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (config.token) {
    headers["X-Authorization"] = config.token;
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);

  let response: HttpResponseSpec;
  for (let hop = 0; ; hop += 1) {
    try {
      response = await transport({ url, method, headers, body: payload, timeout: config.timeout });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServerError(`无法连接 ${url}：${reason}`);
    }
    const location = response.headers?.location;
    const isRedirect = response.status >= 300 && response.status < 400 && typeof location === "string";
    if (!isRedirect) {
      break;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new ServerError(`重定向次数过多：${url}`);
    }
    url = new URL(location, url).toString();
  }

  if (response.status >= 400) {
    const detail = response.body;
    throw new ServerError(
      `HTTP ${response.status} ${response.statusText}: ${detail}`,
      response.status,
      detail,
    );
  }
  if (!response.body.trim()) {
    return null;
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ServerError(`${url} 返回的不是 JSON：${JSON.stringify(response.body.slice(0, 200))}`);
  }
}

/** One validation error reported by the server. */
export interface ServerValidationError {
  path: string;
  message: string;
  invalidValue?: unknown;
}

/**
 * Run the server's own validation and return its errors (empty list = valid).
 *
 * `POST /metadata/workflow/validate` returns 200 with an empty body when the
 * definition is valid, and 400 with `{"validationErrors": [...]}` when it is
 * not.
 */
export async function validateDefinition(
  definition: WorkflowDefinition,
  config: ServerConfig,
  transport: Transport = nodeTransport,
): Promise<ServerValidationError[]> {
  try {
    await request(config, "/metadata/workflow/validate", "POST", definition, transport);
    return [];
  } catch (error) {
    if (!(error instanceof ServerError) || error.status !== 400) {
      throw error;
    }
    const payload = (error.payload ?? "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [{ path: "", message: error.message }];
    }
    const errors =
      parsed && typeof parsed === "object" && "validationErrors" in parsed
        ? (parsed as { validationErrors?: unknown }).validationErrors
        : undefined;
    if (!Array.isArray(errors) || errors.length === 0) {
      return [{ path: "", message: error.message }];
    }
    return errors.map((item) => {
      const record = (item ?? {}) as { path?: unknown; message?: unknown; invalidValue?: unknown };
      const result: ServerValidationError = {
        path: typeof record.path === "string" ? record.path : "",
        message: typeof record.message === "string" ? record.message : "",
      };
      if (record.invalidValue !== undefined) {
        result.invalidValue = record.invalidValue;
      }
      return result;
    });
  }
}

/** Download a registered workflow definition. */
export async function fetchWorkflow(
  name: string,
  config: ServerConfig,
  version?: number,
  transport: Transport = nodeTransport,
): Promise<WorkflowDefinition> {
  let path = `/metadata/workflow/${encodeURIComponent(name)}`;
  if (version !== undefined && version !== null) {
    path += `?version=${Math.trunc(version)}`;
  }
  const result = await request(config, path, "GET", undefined, transport);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ServerError(`工作流 ${JSON.stringify(name)} 未返回定义`);
  }
  return result as WorkflowDefinition;
}
