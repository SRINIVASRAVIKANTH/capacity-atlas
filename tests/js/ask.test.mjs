// Tests for functions/api/ask.js with a fake Anthropic API. Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest, sanitize, cleanHistory, buildMessages } from "../../functions/api/ask.js";

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
  assert.deepEqual(await res.json(), { place: "Albany, New York", min_mw: 2, utility: null, show_issues: false, show_changes: null, reset: false, nearest: false, reply: "Lines near Albany with at least 2 MW.", unclear: false, out_of_scope: false });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");
  assert.equal(calls[0].init.body.tool_choice.name, "set_map_view");
});

test("sanitize drops unknown utilities and impossible sizes", () => {
  const out = sanitize({ place: "  ", min_mw: -3, utility: "con_ed", show_issues: "yes", reply: 5, extra: "x" });
  assert.deepEqual(out, { place: null, min_mw: null, utility: null, show_issues: null, show_changes: null, reset: false, nearest: false, reply: "", unclear: false, out_of_scope: false });
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

test("odd Origin headers are refused, never crash", async () => {
  fakeClaude({});
  for (const origin of ["null", "not a url", "https://capacity-atlas.pages.dev.evil.example"]) {
    const res = await onRequest({ request: request({ question: "hi" }, { origin }), env: ENV });
    assert.equal(res.status, 403, origin);
  }
});

test("bodies that are not a question object get a 400, oversized bodies a 413", async () => {
  fakeClaude({ place: null, min_mw: null, utility: null, show_issues: false, reply: "ok", out_of_scope: false });
  const raw = (body) => new Request("https://capacity-atlas.pages.dev/api/ask", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `10.1.0.${++ipCounter}` }, body,
  });
  for (const body of ["not json", "null", "[1,2]", '"text"', '{"question": 42}', '{"question": {"a": 1}}']) {
    assert.equal((await onRequest({ request: raw(body), env: ENV })).status, 400, body);
  }
  assert.equal((await onRequest({ request: raw(JSON.stringify({ question: "x".repeat(5000) })), env: ENV })).status, 413);
});

test("a slow or broken Claude API gives a calm message", async () => {
  globalThis.fetch = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  let res = await onRequest({ request: request({ question: "2 MW near Troy" }), env: ENV });
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error, "AI search is unavailable right now.");

  globalThis.fetch = async () => new Response("<html>gateway</html>", { status: 200 });
  res = await onRequest({ request: request({ question: "2 MW near Troy" }), env: ENV });
  assert.equal(res.status, 502);

  globalThis.fetch = async () => Response.json({ content: "unexpected" });
  res = await onRequest({ request: request({ question: "2 MW near Troy" }), env: ENV });
  assert.equal(res.status, 502);
});

test("every response is JSON that browsers will not sniff as something else", async () => {
  fakeClaude({ place: null, min_mw: null, utility: null, show_issues: false, reply: "ok", out_of_scope: false });
  const res = await onRequest({ request: request({ question: "solar near Utica" }), env: ENV });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("whatever Claude returns, only known fields and values reach the browser", () => {
  const out = sanitize({ place: "<img src=x onerror=alert(1)>", min_mw: 1e9, utility: "national_grid_ny_pv", show_issues: true, reply: "x".repeat(1000), out_of_scope: false, html: "<script>" });
  assert.deepEqual(Object.keys(out).sort(), ["min_mw", "nearest", "out_of_scope", "place", "reply", "reset", "show_changes", "show_issues", "unclear", "utility"]);
  assert.equal(out.min_mw, null);
  assert.equal(out.reply.length, 300);
  assert.equal(out.utility, "national_grid_ny_pv");
});

test("large project sizes are kept, so the map can say honestly that no line fits", () => {
  assert.equal(sanitize({ min_mw: 500 }).min_mw, 500);
  assert.equal(sanitize({ min_mw: 1000 }).min_mw, 1000);
  assert.equal(sanitize({ min_mw: 0 }).min_mw, null);
  assert.equal(sanitize({ min_mw: -5 }).min_mw, null);
});

test("a request for the nearest line is passed on only as true or false", () => {
  assert.equal(sanitize({ nearest: true }).nearest, true);
  assert.equal(sanitize({ nearest: "yes" }).nearest, false);
  assert.equal(sanitize({}).nearest, false);
});

test("follow-ups: earlier turns reach Claude as its own earlier settings, in order", async () => {
  const calls = fakeClaude({ place: "Albany, New York", min_mw: 5, utility: null, show_issues: false, reply: "Now 5 MW.", out_of_scope: false });
  const history = [{ question: "Where near Albany can I connect 2 MW?", plan: { place: "Albany, New York", min_mw: 2, utility: null, show_issues: false, nearest: false } }];
  const res = await onRequest({ request: request({ question: "and for 5 MW?", history }), env: ENV });
  assert.equal(res.status, 200);
  const messages = calls[0].init.body.messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, "Where near Albany can I connect 2 MW?");
  assert.equal(messages[1].content[0].type, "tool_use");
  assert.equal(messages[1].content[0].input.min_mw, 2);
  assert.deepEqual(messages[2].content.map((b) => b.type), ["tool_result", "text"]);
  assert.equal(messages[2].content[0].tool_use_id, messages[1].content[0].id);
  assert.equal(messages[2].content[1].text, "and for 5 MW?");
});

test("history from the browser is checked like a question; bad turns are dropped, not trusted", () => {
  const good = { question: "Troy 2 MW", plan: { place: "Troy, New York", min_mw: 2 } };
  assert.deepEqual(cleanHistory("nope"), []);
  assert.deepEqual(cleanHistory([null, 5, { question: 7 }, { question: "x".repeat(301), plan: {} }, { question: "no plan" }]), []);
  const cleaned = cleanHistory([good, good, good, good, { question: " Kingston ", plan: { utility: "con_ed", min_mw: -1, reply: "<b>", extra: 1 } }]);
  assert.equal(cleaned.length, 3); // only the last three turns
  assert.deepEqual(cleaned[2], { question: "Kingston", settings: { place: null, min_mw: null, utility: null, show_issues: null, show_changes: null, reset: false, nearest: false } });
  assert.equal(buildMessages([], "hi").length, 1); // no history: a single question, as before
});

test("a long history still fits; a padded body is refused unread", async () => {
  fakeClaude({ place: null, min_mw: null, utility: null, show_issues: false, reply: "ok", out_of_scope: false });
  const turn = { question: "q".repeat(300), plan: { place: "p".repeat(120), min_mw: 9999.99, utility: "national_grid_ny_pv", show_issues: true, nearest: true } };
  const ok = await onRequest({ request: request({ question: "x".repeat(300), history: [turn, turn, turn] }), env: ENV });
  assert.equal(ok.status, 200);
  const big = await onRequest({ request: request({ question: "x", history: Array(20).fill(turn) }), env: ENV });
  assert.equal(big.status, 413);
});

test("highlights are on, off, or left as they are; anything else counts as leave", () => {
  assert.equal(sanitize({ show_issues: true }).show_issues, true);
  assert.equal(sanitize({ show_issues: false }).show_issues, false);
  assert.equal(sanitize({ show_issues: null }).show_issues, null);
  assert.equal(sanitize({ show_issues: "false" }).show_issues, null);
  assert.equal(sanitize({ show_changes: false }).show_changes, false);
  assert.equal(sanitize({ show_changes: 1 }).show_changes, null);
});

test("back to normal and could-not-understand pass only as true or false", () => {
  assert.equal(sanitize({ reset: true }).reset, true);
  assert.equal(sanitize({ reset: "yes" }).reset, false);
  assert.equal(sanitize({ unclear: true }).unclear, true);
  assert.equal(sanitize({ unclear: 1 }).unclear, false);
});

test("the instructions cover spelling mistakes, going back to normal and asking back", async () => {
  const calls = fakeClaude({ place: null, min_mw: null, utility: null, show_issues: null, show_changes: null, reset: true, nearest: false, reply: "Back to normal.", unclear: false, out_of_scope: false });
  const res = await onRequest({ request: request({ question: "back to normal please" }), env: ENV });
  assert.equal((await res.json()).reset, true);
  const { system, tools } = calls[0].init.body;
  for (const phrase of ["spelling mistakes", "reset: true", "unclear", "show_changes", "hide that"]) assert.ok(system.includes(phrase), phrase);
  assert.deepEqual(tools[0].input_schema.required.sort(), ["min_mw", "nearest", "out_of_scope", "place", "reply", "reset", "show_changes", "show_issues", "unclear", "utility"]);
});

test("earlier turns keep their highlight and reset settings, so 'hide that' has context", () => {
  const cleaned = cleanHistory([{ question: "any errors?", plan: { show_issues: true } }, { question: "clear", plan: { reset: true } }]);
  assert.equal(cleaned[0].settings.show_issues, true);
  assert.equal(cleaned[1].settings.reset, true);
  const messages = buildMessages(cleaned, "hide that");
  assert.equal(messages[1].content[0].input.show_issues, true);
  assert.equal(messages[1].content[0].input.unclear, false);
});
