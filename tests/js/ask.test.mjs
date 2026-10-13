// Tests for functions/api/ask.js with a fake Anthropic API. Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest, sanitize } from "../../functions/api/ask.js";

const ENV = { ANTHROPIC_API_KEY: "test-key" };
let ipCounter = 0;

function request(body, { method = "POST", origin = "https://capacity-atlas.pages.dev" } = {}) {
  return new Request("https://capacity-atlas.pages.dev/api/ask", {
    method,
    headers: { "content-type": "application/json", origin, "cf-connecting-ip": `10.0.0.${++ipCounter}` },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function fakeClaude(input, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    if (status !== 200) return new Response("error", { status });
    return Response.json({ content: [{ type: "tool_use", name: "set_map_view", input }] });
  };
  return calls;
}

test("turns a question into clean map settings and sends the key only to Anthropic", async () => {
  const calls = fakeClaude({ place: "Albany, New York", min_mw: 2, utility: null, show_issues: false, reply: "Lines near Albany with at least 2 MW.", out_of_scope: false });
  const res = await onRequest({ request: request({ question: "Where near Albany can I connect 2 MW?" }), env: ENV });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { place: "Albany, New York", min_mw: 2, utility: null, show_issues: false, reply: "Lines near Albany with at least 2 MW.", out_of_scope: false });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");
  assert.equal(calls[0].init.body.tool_choice.name, "set_map_view");
});

test("sanitize drops unknown utilities and impossible sizes", () => {
  const out = sanitize({ place: "  ", min_mw: -3, utility: "con_ed", show_issues: "yes", reply: 5, extra: "x" });
  assert.deepEqual(out, { place: null, min_mw: null, utility: null, show_issues: false, reply: "", out_of_scope: false });
});

test("refuses other websites, other methods, empty and long questions", async () => {
  fakeClaude({});
  assert.equal((await onRequest({ request: request({ question: "hi" }, { origin: "https://evil.example" }), env: ENV })).status, 403);
  assert.equal((await onRequest({ request: request(null, { method: "GET" }), env: ENV })).status, 405);
  assert.equal((await onRequest({ request: request({ question: " " }), env: ENV })).status, 400);
  assert.equal((await onRequest({ request: request({ question: "x".repeat(301) }), env: ENV })).status, 400);
});

test("a missing key or an API failure gives a calm message, never the API error", async () => {
  assert.equal((await onRequest({ request: request({ question: "2 MW near Troy" }), env: {} })).status, 503);
  fakeClaude({}, 401);
  const res = await onRequest({ request: request({ question: "2 MW near Troy" }), env: ENV });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "AI search is unavailable right now.");
});

test("limits how often one visitor can ask", async () => {
  fakeClaude({ place: null, min_mw: null, utility: null, show_issues: false, reply: "ok", out_of_scope: false });
  const same = () => new Request("https://capacity-atlas.pages.dev/api/ask", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.9.9.9" },
    body: JSON.stringify({ question: "solar near Utica" }),
  });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await onRequest({ request: same(), env: ENV })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
});
