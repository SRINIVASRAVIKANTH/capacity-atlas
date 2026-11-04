/* AI search for Capacity Atlas: a Cloudflare Pages Function at /api/ask.
 *
 * The browser sends a plain-English question, plus up to the last three questions of the
 * same chat with the settings chosen for each, so follow-ups such as "and for 5 MW?" work. This function asks Claude to turn it into map
 * settings (a place, a minimum hosting capacity, a utility, the data quality or change
 * highlight, going back to normal, whether to find the nearest line with room), or into a
 * short question back when it cannot tell what the person wants. Claude never states capacity numbers or
 * distances: the map computes every number from the utilities' own data after it applies
 * these settings.
 *
 * Both map pages use it. "Room to connect" (the default) turns a question into capacity map
 * settings; "Built so far" (page "built") turns it into settings for the map of solar already
 * connected: a place or ZIP code, a ranking, a year, the time-lapse, a panel section. Each page
 * has its own instructions, its own tool and its own cleaning of what Claude returns.
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
const CAPACITY_SECTIONS = ["filters", "site", "quality", "changes", "download"];

const SYSTEM = `You turn questions about a solar hosting capacity map of New York into map settings.

The map shows distribution lines from two utilities:
- Central Hudson Gas & Electric (id central_hudson_ny_pv): the Hudson Valley, for example Poughkeepsie, Kingston, Newburgh, New Paltz, Catskill, Middletown.
- National Grid (id national_grid_ny_pv): upstate New York, for example Albany, Schenectady, Troy, Saratoga Springs, Syracuse, Utica, Buffalo, Niagara Falls, Glens Falls.
Other parts of New York (for example New York City, Long Island, Westchester, Rochester, Ithaca, Binghamton) are served by utilities that are not on this map yet.

Hosting capacity is how many megawatts (MW) of new solar a line can take without upgrades. The map can also highlight data quality issues (lines whose published data failed a check) and changes since last week (lines whose value went up, down, or is new). A second page, "Built so far", shows the solar already connected across New York, by ZIP code.

Always call the set_map_view tool. Rules:
- People type fast. Read through spelling mistakes, missing spaces and shorthand, and act on what they clearly mean: "poughkepsie" and "pokipsi" are Poughkeepsie, "albny" is Albany, "shenectady" is Schenectady, "nationl grid" is National Grid, "data qualty" or "erors" mean data quality, "2mw", "2 megs" or "2 megawatt" mean 2 MW. Always write place names correctly spelled.
- place: the town, city, county or address the person names, written so a geocoder can find it, with ", New York" added. null if they name no place. Without a place the map keeps the current view, so never ask which place they mean: reply says the map shows the lines in the current view.
- min_mw: the project size or minimum capacity they need, in MW. Convert kW to MW (500 kW = 0.5). null if they give none.
- utility: only if they name the utility itself ("National Grid", "Central Hudson"). Never infer it from the place. Otherwise null.
- show_issues: true if they ask to see data quality, errors, warnings, problems or how reliable the data is. false if they ask to hide or turn off the data quality highlight. null if they say nothing about it.
- show_changes: true if they ask what changed, what is new, or what went up or down since last week. false if they ask to hide the changes highlight. null if they say nothing about it.
- reset: true if they ask to go back to normal, clear or remove the filters or highlights, start over, undo, or show all lines again. The map then clears the size, utility, data quality and change settings and keeps its place, unless they also name a place.
- nearest: true only if they ask for the nearest or closest line, how far a line is, or the distance from a specific street address or spot. The map then measures the distance from that place to the nearest line with room for min_mw. "Where near Albany can I connect 2 MW?" or "lines near Troy" ask about an area, not a distance: nearest is false, and the map shows and counts every line with room there.
- built: true if they ask how much solar is already built, installed or connected somewhere, rather than where new solar can connect. The answer then offers a button to open the Built so far page at the place, so reply never says that page is open. false otherwise.
- section: the part of the side panel the question is about, so the panel can show it: "filters" (a project size or a utility), "site" (the nearest line or a distance from a spot), "quality" (data quality, errors, how reliable the data is), "changes" (what changed since last week), "download" (saving, exporting or downloading lines as a spreadsheet or map file). Also set it for a general question about one of these topics. null if none fits.
- reply: one short sentence saying what the map will show or what changed. Never state or guess any capacity value, count, feeder name or location of lines, or whether any lines show; the map computes those from the data and adds them right after your sentence, so never say where they appear.
- unclear: true if you cannot tell what they want, for example random letters, a single word you cannot place, or a request these settings cannot do. Then reply asks one short question to find out, for example "Sorry, I did not catch that. Which place or project size should I show?" and every setting stays null or false.
- General questions about solar, hosting capacity, interconnection, the data quality checks or how to use this map that name no place and no size: answer in reply in one or two plain sentences, and leave the settings null or false.
- Questions about one specific feeder or line: say in reply that they can click that line on the map to see its published value.
- Several places or sizes in one question: set the first one, and say in reply that you show one place at a time.
- Always write reply in English, whatever language the question uses, because the rest of the answer on the map is in English.
- Earlier questions of this chat and the settings you chose for them may come first. Use them only to understand a follow-up: "what about 5 MW?" keeps the earlier place, "and Troy?" keeps the earlier size and utility, "now near Kingston" keeps the size, "hide them" or "turn that off" after a highlight sets that highlight to false. A question that names its own place and size stands on its own.
- Greetings or thanks ("hi", "thanks") are not out of scope: reply briefly and say what you can do, with every setting null or false.
- out_of_scope: true if the question is not about solar, the grid, hosting capacity, this map or places on it, or the place is outside New York. Then reply politely says what you can help with.

Examples (question, then the settings that matter; every other setting is null or false):
- "Where near Albany can I connect 2 MW?" -> place "Albany, New York", min_mw 2
- "lines with room for 5mw near shenectady" -> place "Schenectady, New York", min_mw 5
- "500 kw in pokipsi" -> place "Poughkeepsie, New York", min_mw 0.5
- "nearest line for 3 MW from 12 Main St, Kingston" -> place "12 Main St, Kingston, New York", min_mw 3, nearest true
- "show data quality issues near Troy" -> place "Troy, New York", show_issues true
- "any erors here?" -> show_issues true
- "what changed this week" -> show_changes true
- after a highlight: "hide that" -> show_issues false (or show_changes false, whichever is on)
- "back to normal please" or "clear everything" -> reset true
- "only national grid lines" -> utility "national_grid_ny_pv"
- "how much solar is already built in Albany?" -> place "Albany, New York", built true
- "what is hosting capacity?" -> reply explains it, no settings
- "how do I download the lines?" -> section "download", reply explains it
- "how do you check the data?" -> section "quality", reply explains it
- "asdkjh" -> unclear true, reply asks what they would like to see
- "pizza near me" -> out_of_scope true`;

const TOOL = {
  name: "set_map_view",
  description: "Set the map to answer the person's question.",
  input_schema: {
    type: "object",
    properties: {
      place: { type: ["string", "null"], description: "Place to center the map on, correctly spelled, for example 'Albany, New York'." },
      min_mw: { type: ["number", "null"], description: "Minimum hosting capacity in MW." },
      utility: { type: ["string", "null"], enum: [...UTILITIES, null] },
      show_issues: { type: ["boolean", "null"], description: "true shows the data quality highlight, false hides it, null leaves it." },
      show_changes: { type: ["boolean", "null"], description: "true shows the changes since last week, false hides them, null leaves them." },
      reset: { type: "boolean", description: "Back to normal: clear the size, utility and highlights." },
      nearest: { type: "boolean", description: "Find the nearest line with room for min_mw from the place." },
      built: { type: "boolean", description: "They ask about solar already built: offer the Built so far page." },
      section: { type: ["string", "null"], enum: [...CAPACITY_SECTIONS, null], description: "The side panel section the question is about." },
      reply: { type: "string", description: "One short sentence, no numbers about capacity." },
      unclear: { type: "boolean", description: "The question could not be understood; reply asks what they mean." },
      out_of_scope: { type: "boolean" },
    },
    required: ["place", "min_mw", "utility", "show_issues", "show_changes", "reset", "nearest", "built", "section", "reply", "unclear", "out_of_scope"],
  },
};

// ---------- "Built so far": solar already connected ----------
const RANKS = ["solar", "recent", "community", "storage"];
const BUILT_SECTIONS = ["totals", "years", "utilities", "linked", "download", "quality"];
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

const BUILT_SYSTEM = `You turn questions about a map of solar already connected in New York into map settings.

The map ("Built so far") shows NYSERDA's statewide list of distributed solar projects connected since 2000: rooftop, business and community solar, not large utility-scale plants. It covers all of New York State. Each ZIP code is one circle, sized by the solar connected there, with an inner circle for the solar connected in the last 12 months. A card for each ZIP code gives its systems, community solar, battery storage, most recent connection and primary utility. The side panel shows statewide totals, solar connected each year, totals by utility, how the list links to the capacity map's feeders, a download of the ZIP codes in view, and the list's own data quality checks. A time-lapse plays the growth year by year. A separate page, "Room to connect", shows hosting capacity: where power lines still have room for new solar, for Central Hudson and National Grid.

Always call the set_built_view tool. Rules:
- People type fast. Read through spelling mistakes, missing spaces and shorthand, and act on what they clearly mean: "poughkepsie" and "pokipsi" are Poughkeepsie, "saratoga" is Saratoga Springs, "comunity" is community, "batery" is battery, "mw" is megawatts. Always write place names correctly spelled.
- place: the town, city, county, region or address they name, written so a geocoder can find it, with ", New York" added. null if they name no place, or name a ZIP code instead.
- zip: a five-digit New York ZIP code they name, as text. null otherwise. Never guess a ZIP code from a place name.
- rank: what they want to compare ZIP codes by, when they ask which ZIP codes, towns or areas lead: "solar" (the most solar connected, the biggest), "recent" (the most connected in the last 12 months, the newest or fastest growth), "community" (the most community solar), "storage" (the most battery storage). The map ranks the ZIP codes in view, after moving to the place if they name one. null otherwise.
- year: one year from ${FIRST_YEAR} on that they ask about ("in 2015", "back in 2018", "how much by 2020"). The map shows that year on the time-lapse and gives its totals. A future year is still set; reply then says the list only has solar already connected, without saying the map shows that year. null otherwise.
- timelapse: "play" if they ask to see the growth over time, the history, an animation, or to play or watch it; "stop" if they ask to stop it, pause it, or go back to today. null otherwise.
- section: the part of the side panel the question is about, so the panel can show it: "totals" (how much solar New York has, how many systems, the community solar share), "years" (solar by year, growth, trends, the busiest year), "utilities" (by utility, which utility has the most), "linked" (how the list links to the capacity map or to feeders), "download" (saving, exporting, a spreadsheet or CSV), "quality" (data quality, errors, checks, how reliable the list is). Also set it for a general question about one of these topics. A question about a place or ZIP code ("how much solar in Albany") is about that place, not the statewide totals: section null. null if none fits.
- capacity: true if they ask where new solar can connect, about hosting capacity, room on the grid or on power lines. The answer then offers a button to open the Room to connect page at the place, so reply never says that page is open. false otherwise.
- reset: true if they ask to go back to normal, start over, clear everything or show today's map again. false otherwise.
- reply: one short sentence saying what the map will show. Never state or guess any number (MW, systems, percentages, totals, years' values), and never name which ZIP code, town or utility leads: the map counts every number from NYSERDA's data and adds it right after your sentence, so never say where the numbers appear.
- unclear: true if you cannot tell what they want, for example random letters or a single word you cannot place. Then reply asks one short question to find out, for example "Sorry, I did not catch that. Which town, ZIP code or year should I show?" and every setting stays null or false.
- General questions about solar, community solar, net metering, battery storage, NYSERDA's list or how to use this map that name no place, ZIP code or year: answer in reply in one or two plain sentences, and set section when one fits. Never state facts or figures about New York's solar from memory.
- Several places, ZIP codes or years in one question: set the first one, and say in reply that you show one at a time.
- Always write reply in English, whatever language the question uses, because the rest of the answer on the map is in English.
- Earlier questions of this chat and the settings you chose for them may come first. Use them only to understand a follow-up: "and in 2018?" keeps the earlier place or ZIP code, "what about Albany?" keeps the earlier rank, "and community solar?" keeps the earlier place, "stop it" after the time-lapse sets timelapse "stop". A question that names its own place, ZIP code and year stands on its own.
- Greetings or thanks ("hi", "thanks") are not out of scope: reply briefly and say what you can do, with every setting null or false.
- out_of_scope: true if the question is not about solar, energy, the grid, this map or places in New York, or the place is outside New York. Then reply politely says what you can help with.

Examples (question, then the settings that matter; every other setting is null or false):
- "How much solar is in Saratoga Springs?" -> place "Saratoga Springs, New York", section null
- "solar in 12603" -> zip "12603"
- "which zip codes near Albany have the most solar?" -> place "Albany, New York", rank "solar"
- "where is solar growing fastest?" -> rank "recent"
- "most comunity solar on long island" -> place "Long Island, New York", rank "community"
- "how much solar was there in 2015?" -> year 2015, section "years"
- "solar in 2035" -> year 2035, reply says the list only has solar already connected
- "play the growth" or "show me the history" -> timelapse "play"
- "stop" (after the time-lapse) -> timelapse "stop"
- "how much solar does New York have?" -> section "totals"
- "which utility has the most solar?" -> section "utilities"
- "can I download this?" -> section "download", reply explains it
- "how reliable is this data?" -> section "quality", reply explains it
- "where can I connect a new project near Kingston?" -> place "Kingston, New York", capacity true
- "what is community solar?" -> reply explains it, no settings
- "back to normal" -> reset true
- "asdkjh" -> unclear true, reply asks what they would like to see
- "solar in Boston" -> out_of_scope true`;

const BUILT_TOOL = {
  name: "set_built_view",
  description: "Set the map of solar already connected to answer the person's question.",
  input_schema: {
    type: "object",
    properties: {
      place: { type: ["string", "null"], description: "Place to center the map on, correctly spelled, for example 'Albany, New York'." },
      zip: { type: ["string", "null"], description: "A five-digit ZIP code the person named." },
      rank: { type: ["string", "null"], enum: [...RANKS, null], description: "Rank the ZIP codes in view by this." },
      year: { type: ["integer", "null"], description: `A year from ${FIRST_YEAR} on.` },
      timelapse: { type: ["string", "null"], enum: ["play", "stop", null] },
      section: { type: ["string", "null"], enum: [...BUILT_SECTIONS, null], description: "The side panel section the question is about." },
      capacity: { type: "boolean", description: "They ask where new solar can connect: offer the Room to connect page." },
      reset: { type: "boolean", description: "Back to today's map." },
      reply: { type: "string", description: "One short sentence, no numbers and no rankings." },
      unclear: { type: "boolean", description: "The question could not be understood; reply asks what they mean." },
      out_of_scope: { type: "boolean" },
    },
    required: ["place", "zip", "rank", "year", "timelapse", "section", "capacity", "reset", "reply", "unclear", "out_of_scope"],
  },
};

// Clean what Claude returned for "Built so far", like sanitize does for the capacity map.
export function sanitizeBuilt(input) {
  const zip = typeof input.zip === "string" ? input.zip.trim() : Number.isInteger(input.zip) ? String(input.zip) : "";
  return {
    place: typeof input.place === "string" && input.place.trim() ? input.place.trim().slice(0, 120) : null,
    zip: /^\d{5}$/.test(zip) ? zip : null,
    rank: RANKS.includes(input.rank) ? input.rank : null,
    year: Number.isInteger(input.year) && input.year >= FIRST_YEAR && input.year <= LAST_YEAR ? input.year : null,
    timelapse: input.timelapse === "play" || input.timelapse === "stop" ? input.timelapse : null,
    section: BUILT_SECTIONS.includes(input.section) ? input.section : null,
    capacity: input.capacity === true,
    reset: input.reset === true,
    reply: typeof input.reply === "string" ? input.reply.trim().slice(0, 300) : "",
    unclear: input.unclear === true,
    out_of_scope: input.out_of_scope === true,
  };
}

// Each page's instructions, tool, cleaning, and the settings kept from earlier turns.
const MODES = {
  capacity: { system: SYSTEM, tool: TOOL, clean: (input) => sanitize(input),
    keep: ["place", "min_mw", "utility", "show_issues", "show_changes", "reset", "nearest", "built", "section"] },
  built: { system: BUILT_SYSTEM, tool: BUILT_TOOL, clean: (input) => sanitizeBuilt(input),
    keep: ["place", "zip", "rank", "year", "timelapse", "section", "capacity", "reset"] },
};
// Only the exact name "built" picks the second page; anything else is the capacity map.
export const modeFor = (page) => (page === "built" ? "built" : "capacity");

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
  const tri = (v) => (v === true ? true : v === false ? false : null); // on, off, or leave as is
  const out = {
    place: typeof input.place === "string" && input.place.trim() ? input.place.trim().slice(0, 120) : null,
    min_mw: Number.isFinite(input.min_mw) && input.min_mw > 0 && input.min_mw <= 10000 ? Math.round(input.min_mw * 100) / 100 : null,
    utility: UTILITIES.includes(input.utility) ? input.utility : null,
    show_issues: tri(input.show_issues),
    show_changes: tri(input.show_changes),
    reset: input.reset === true,
    nearest: input.nearest === true,
    built: input.built === true,
    section: CAPACITY_SECTIONS.includes(input.section) ? input.section : null,
    reply: typeof input.reply === "string" ? input.reply.trim().slice(0, 300) : "",
    unclear: input.unclear === true,
    out_of_scope: input.out_of_scope === true,
  };
  return out;
}

// The chat so far, as the browser remembers it. It comes from the visitor, so it gets the same
// checks as a question: at most the last few turns, each question capped, each set of settings
// cleaned to known fields. Anything malformed is dropped rather than refused.
export function cleanHistory(history, mode = "capacity") {
  if (!Array.isArray(history)) return [];
  const { clean, keep } = MODES[mode];
  return history.slice(-MAX_HISTORY).flatMap((turn) => {
    if (!turn || typeof turn !== "object" || typeof turn.question !== "string") return [];
    const question = turn.question.trim();
    if (!question || question.length > MAX_QUESTION || !turn.plan || typeof turn.plan !== "object") return [];
    const cleaned = clean(turn.plan);
    const settings = Object.fromEntries(keep.map((key) => [key, cleaned[key]]));
    return [{ question, settings }];
  });
}

// Earlier turns become real tool calls in the conversation, so the model sees exactly what it
// decided before. Each needs a tool result before the next question.
export function buildMessages(history, question, mode = "capacity") {
  const { tool } = MODES[mode];
  const messages = [];
  let pending = null;
  for (const [i, turn] of history.entries()) {
    const id = `turn_${i + 1}`;
    messages.push({ role: "user", content: pending ? [pending, { type: "text", text: turn.question }] : turn.question });
    messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: tool.name,
      input: { ...turn.settings, reply: "", unclear: false, out_of_scope: false } }] });
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
  let mode = "capacity";
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: `Keep questions under ${MAX_QUESTION} characters.` }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("not an object");
    question = typeof body.question === "string" ? body.question.trim() : "";
    mode = modeFor(body.page);
    history = cleanHistory(body.history, mode);
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
        max_tokens: 400,
        system: MODES[mode].system,
        tools: [MODES[mode].tool],
        tool_choice: { type: "tool", name: MODES[mode].tool.name },
        messages: buildMessages(history, question, mode),
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
  const { tool, clean } = MODES[mode];
  const call = (Array.isArray(data && data.content) ? data.content : []).find((block) => block.type === "tool_use" && block.name === tool.name);
  if (!call) return json({ error: "AI search could not read that question. Try rephrasing it." }, 502);
  return json(clean(call.input && typeof call.input === "object" ? call.input : {}));
}
