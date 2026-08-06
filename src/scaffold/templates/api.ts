/**
 * The `api` kind: an HTTP service on hono, served by `@hono/node-server`.
 *
 * hono is the TypeScript analogue of the Python sibling's FastAPI choice: a
 * small, typed router with no code generation and no runtime magic. It builds
 * on the platform `Request`/`Response` types, which is what lets the test suite
 * call `app.request(...)` directly with no server, no port, and no HTTP client
 * dependency.
 *
 * DELIBERATELY MINIMAL. Two routes: a health probe and one that exercises the
 * layered path down to a service. Adding middleware, validation wiring, or an
 * error-handling framework here would be inventing decisions on the project's
 * behalf that its first real route should make.
 */

/** Source and test files for the `api` kind. */
export function apiFiles(): Record<string, string> {
  return {
    "src/entrypoints/api.ts": API_ENTRYPOINT,
    "src/entrypoints/bin.ts": API_BIN,
    "test/api.test.ts": API_TEST,
  };
}

const API_ENTRYPOINT = `/**
 * Entrypoint: HTTP API.
 *
 * Exports the app rather than starting a server, so tests can drive it
 * in-process. \`bin.ts\` is what binds a port.
 */

import { Hono } from "hono";

import { buildGreeting } from "../services/greeting.ts";

/** The application. Routes parse input and delegate; no logic lives here. */
export const app = new Hono();

app.get("/health", (context) => context.json({ status: "ok" }));

app.get("/greet/:name", (context) => {
  const name = context.req.param("name") ?? "world";
  return context.json({ message: buildGreeting(name) });
});
`;

const API_BIN = `#!/usr/bin/env node
/**
 * Executable shim: bind a port and serve the app.
 *
 * HOST and PORT are read with no fallback beyond a documented default, and
 * PORT is VALIDATED rather than coerced. \`Number(process.env.PORT) || 8000\`
 * is the bug this avoids twice over: it turns a typo into a silent 8000, and
 * \`||\` would also rewrite a deliberate \`0\`.
 */

import { env, exit, stderr } from "node:process";

import { serve } from "@hono/node-server";

import { app } from "./api.ts";

const hostname = env["HOST"] ?? "127.0.0.1";
const rawPort = env["PORT"] ?? "8000";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  stderr.write(\`PORT is not a valid port number: \${rawPort}\\n\`);
  exit(2);
}

serve({ fetch: app.fetch, hostname, port });
stderr.write(\`listening on http://\${hostname}:\${String(port)}\\n\`);
`;

const API_TEST = `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app } from "../src/entrypoints/api.ts";

describe("api", () => {
  it("reports health", async () => {
    const response = await app.request("/health");
    assert.equal(response.status, 200);
    // Typed \`unknown\` on the way in: a response body is external data, and
    // the fact that this one came from our own route does not change that.
    const body: unknown = await response.json();
    assert.deepEqual(body, { status: "ok" });
  });

  it("greets by name", async () => {
    const response = await app.request("/greet/Ada");
    const body: unknown = await response.json();
    assert.deepEqual(body, { message: "Hello, Ada!" });
  });

  it("404s an unknown route", async () => {
    assert.equal((await app.request("/nope")).status, 404);
  });
});
`;
