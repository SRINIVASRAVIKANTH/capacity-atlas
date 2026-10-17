/* AI search for Capacity Atlas: a Cloudflare Pages Function at /api/ask.
 *
 * The browser sends a plain-English question, plus up to the last three questions of the
 * same chat with the settings chosen for each, so follow-ups such as "and for 5 MW?" work. This function asks Claude to turn it into map
 * settings (a place, a minimum hosting capacity, a utility, whether to show data issues,
 * whether to find the nearest line with room). Claude never states capacity numbers or
 * distances: the map computes every number from the utilities' own data after it applies
 * these settings.
 *
 * The API key lives only in Cloudflare (Pages project > Settings > Variables and Secrets,
 * name ANTHROPIC_API_KEY, type Secret). It is never sent to the browser.
 */

const MODEL = "claude-haiku-5-5";
const MAX_QUESTION = 300;           // characters
const MAX_HISTORY = 3;              // earlier questions of the same chat sent back as context
const MAX_BODY_BYTES = 4000;        // a question, the short history and JSON wrapping; bigger is refused unread
const API_TIMEOUT_MS = 15000;       // give up on the Claude API after this long
const LIMIT_PER_MINUTE = 6;         // per visitor IP, best effort (per Cloudflare instance)
const LIMIT_PER_DAY = 60;

const UTILITIES = ["central_hudson_ny_pv", "national_grid_ny_pv"];

const SYSTEM = `You turn questions about a solar hosting capacity map of New York into map settings.

The map shows distribution lines from two utilities:
- Central Hudson Gas & Electric (id central_hudson_ny_pv): the Hudson Valley, for example Poughkeepsie, Kingston, Newburgh, New Paltz, Catskill, Middletown.
- National Grid (id national_grid_ny_pv): upstate New York, for example Albany, Schenectady, Troy, Saratoga Springs, Syracuse, Utica, Buffalo, Niagara Falls, Glens Falls.
Other parts of New York (for example New York City, Long Island, Westchester, Rochester, Ithaca, Binghamton) are served by utilities that are not on this map yet.

Hosting capacity is how many megawatts (MW) of new solar a line can take without upgrades.

Always call the set_map_view tool. Rules:
- place: the town, city, county or address the person names, written so a geocoder can find it, with ", New York" added. null if they name no place.
- min_mw: the project size or minimum capacity they need, in MW. Convert kW to MW (500 kW = 0.5). null if they give none.
- utility: only if they name the utility itself ("National Grid", "Central Hudson"). Never infer it from the place. Otherwise null.
- show_issues: true only if they ask about data quality, errors, problems or reliability of the data.
- nearest: true if they ask for the nearest or closest line, how far a line is, or where to connect from a specific address or spot. The map then measures the distance from that place to the nearest line with room for min_mw.
- reply: one short sentence saying what the map will show. Never state or guess any capacity value, count, feeder name or location of lines; the map computes those from the data.
- General questions about solar, hosting capacity, interconnection or how to use this map that name no place and no size: answer in reply in one or two plain sentences, and leave place, min_mw and utility null and show_issues false.
- Questions about one specific feeder or line: say in reply that they can click that line on the map to see its published value.
- Several places or sizes in one question: set the first one, and say in reply that you show one place at a time.
- Always write reply in English, whatever language the question uses, because the rest of the answer on the map is in English.
- Earlier questions of this chat and the settings you chose for them may come first. Use them only to understand a follow-up: "what about 5 MW?" keeps the earlier place, "and Troy?" keeps the earlier size and utility. A question that names its own place and size stands on its own.
- out_of_scope: true if the question is not about solar, the grid, hosting capacity or places on this map, or the place is outside New York. Then reply politely says what you can help with.`;

const TOOL = {
  name: "set_map_view",
  description: "Set the map to answer the person's question.",
  input_schema: {
    type: "object",
    properties: {
      place: { type: ["string", "null"], description: "Place to center the map on, for example 'Albany, New York'." },
      min_mw: { type: ["number", "null"], description: "Minimum hosting capacity in MW." },
      utility: { type: ["string", "null"], enum: [...UTILITIES, null] },
      show_issues: { type: "boolean" },
      nearest: { type: "boolean", description: "Find the nearest line with room for min_mw from the place." },
      reply: { type: "string", description: "One short sentence, no numbers about capacity." },
      out_of_scope: { type: "boolean" },
    },
    required: ["place", "min_mw", "utility", "show_issues", "nearest", "reply", "out_of_scope"],
  },
};

// Best-effort rate limit, kept in memory of this Cloudflare instance. The prepaid API
// credit (auto-reload off) is the hard spending cap behind it.
const visits = new Map();
function allowed(ip, now) {
  const recent = (visits.get(ip) || []).filter((t) => now - t < 86_400_000);
  const lastMinute = recent.filter((t) => now - t < 60_000).length;
  if (lastMinute >= LIMIT_PER_MINUTE || recent.length >= LIMIT_PER_DAY) return false;
  recent.push(now);
  visits.set(ip, recent);
  if (visits.size > 5000) visits.clear(); // keep memory bounded
  return true;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

// True when the request comes from a page on this same site. Browsers always send Origin on
// POST; a missing header means a non-browser client, which the rate limit and credit cap cover.
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false; // "null" (sandboxed frames, local files) or a malformed header
  }
}

// Clean what Claude returned, so the browser only ever receives known fields and values.
export function sanitize(input) {
  const out = {
    place: typeof input.place === "string" && input.place.trim() ? input.place.trim().slice(0, 120) : null,
    min_mw: Number.isFinite(input.min_mw) && input.min_mw > 0 && input.min_mw <= 10000 ? Math.round(input.min_mw * 100) / 100 : null,
    utility: UTILITIES.includes(input.utility) ? input.utility : null,
    show_issues: input.show_issues === true,
    nearest: input.nearest === true,
    reply: typeof input.reply === "string" ? input.reply.trim().slice(0, 300) : "",
    out_of_scope: input.out_of_scope === true,
  };
  return out;
}

// The chat so far, as the browser remembers it. It comes from the visitor, so it gets the same
// checks as a question: at most the last few turns, each question capped, each set of settings
// cleaned to known fields. Anything malformed is dropped rather than refused.
export function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY).flatMap((turn) => {
    if (!turn || typeof turn !== "object" || typeof turn.question !== "string") return [];
    const question = turn.question.trim();
    if (!question || question.length > MAX_QUESTION || !turn.plan || typeof turn.plan !== "object") return [];
    const clean = sanitize(turn.plan);
    const settings = { place: clean.place, min_mw: clean.min_mw, utility: clean.utility,
      show_issues: clean.show_issues, nearest: clean.nearest };
    return [{ question, settings }];
  });
}

// Earlier turns become real tool calls in the conversation, so the model sees exactly what it
// decided before. Each needs a tool result before the next question.
export function buildMessages(history, question) {
  const messages = [];
  let pending = null;
  for (const [i, turn] of history.entries()) {
    const id = `turn_${i + 1}`;
    messages.push({ role: "user", content: pending ? [pending, { type: "text", text: turn.question }] : turn.question });
    messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: TOOL.name,
      input: { ...turn.settings, reply: "", out_of_scope: false } }] });
    pending = { type: "tool_result", tool_use_id: id, content: "The map was updated." };
  }
  messages.push({ role: "user", content: pending ? [pending, { type: "text", text: question }] : question });
  return messages;
}

export async function onRequest(context) {
  try {
    return await answer(context);
  } catch (err) {
    // Last line of defence: log the detail for the site owner, show the visitor a calm message.
    console.log("Unexpected error in /api/ask", err && err.stack ? err.stack : err);
    return json({ error: "AI search is unavailable right now." }, 500);
  }
}

async function answer({ request, env }) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "AI search is not configured." }, 503);

  // Only answer the map's own pages.
  if (!sameOrigin(request)) return json({ error: "Not allowed." }, 403);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ error: `Keep questions under ${MAX_QUESTION} characters.` }, 413);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!allowed(ip, Date.now())) return json({ error: "Too many questions. Please wait a minute and try again." }, 429);

  let question = "";
  let history = [];
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: `Keep questions under ${MAX_QUESTION} characters.` }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("not an object");
    question = typeof body.question === "string" ? body.question.trim() : "";
    history = cleanHistory(body.history);
  } catch {
    return json({ error: "Send a JSON body with a question." }, 400);
  }
  if (!question) return json({ error: "Ask a question first." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Keep questions under ${MAX_QUESTION} characters.` }, 400);

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || MODEL,
        max_tokens: 300,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: buildMessages(history, question),
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    console.log("Anthropic API not reached:", err && err.name);
    return json({ error: "AI search is unavailable right now." }, err && err.name === "TimeoutError" ? 504 : 502);
  }

  if (!response.ok) {
    // 400 with a credit message, 401 bad key, 429 rate limit, 529 overloaded: all mean "try later" to a visitor.
    console.log("Anthropic API error", response.status, (await response.text()).slice(0, 300));
    return json({ error: "AI search is unavailable right now." }, 502);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return json({ error: "AI search is unavailable right now." }, 502);
  }
  const call = (Array.isArray(data && data.content) ? data.content : []).find((block) => block.type === "tool_use" && block.name === TOOL.name);
  if (!call) return json({ error: "AI search could not read that question. Try rephrasing it." }, 502);
  return json(sanitize(call.input && typeof call.input === "object" ? call.input : {}));
}
