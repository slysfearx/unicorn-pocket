// Unicorn Pocket — no-server PWA.
// The browser calls the Anthropic API directly. Voice pack + key are device-local.

'use strict';

/* ===================== constants ===================== */

const LS_KEY = 'unicorn.apiKey';
const LS_OPENAI_KEY = 'unicorn.openaiKey';
const LS_MODEL = 'unicorn.model';
const LS_PROXY = 'unicorn.proxyUrl';
const LS_PACK = 'unicorn.voicePack';
const LS_USAGE = 'unicorn.usage'; // device-local app-use counters (see recordUsage)
const LS_EVENTS_CONSENT = 'unicorn.eventsConsent'; // "on"|"off"; absent = off (fail-closed)
// v38: persist voice mode + tags across sessions so a daily user never has to re-pick.
const LS_LAST_MODE = 'unicorn.lastMode'; // string (mode key) or absent
const LS_LAST_TAGS = 'unicorn.lastTags'; // JSON array of tag strings or absent
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Opt-in only (P2). The circle's shared Cloudflare Worker proxy. It forwards to
// OpenAI using the USER'S OWN key (x-openai-key header) and stores nothing — so
// using it spends the user's OpenAI quota, not the maintainer's. NEVER pre-filled
// as a default; only set when the user explicitly taps "Use the shared circle proxy".
const SHARED_PROXY_URL = 'https://unicorn-pocket-proxy.unicornwrangler.workers.dev';

// P4: Anonymous usage-events endpoint (§2 of outputs/p4-events-schema-consent.md).
// Events POST here when the user has EXPLICITLY opted in (LS_EVENTS_CONSENT = "on").
// This is independent of the GPT shared-proxy toggle — Claude users send events too.
// NEVER send to this URL when consent is off. NEVER include content/text/key fields.
const EVENTS_ENDPOINT = 'https://unicorn-pocket-proxy.unicornwrangler.workers.dev/events';

// App shell version — KEEP IN SYNC with the CACHE version in sw.js (same pairing
// discipline as voice-core.js). Stamped onto every History entry + the export so
// mined data is attributable to a shell version (the v19 chosenIndex bug was
// version-specific — attribution matters when promoting winners into fixtures).
const APP_VERSION = 'v44';

// v41: History outcome filter — module-scope so renderHistory() and chip click
// handlers stay in sync without threading the value through every call. Chips
// in the History screen mutate this and re-render the list. 'all' = no filter.
let historyFilter = 'all';

// v44: C10 — Read → Generate funnel. The most recent successful read text is
// stashed here so the .read-cta button handler can call extractNextMove() on it
// without closing over a mutable local variable. Cleared by resetForNextProfile().
let lastReadText = '';

// Curated model presets for the Settings dropdown (v22). High-confidence current
// ids only; the "Other" option keeps ANY other model id usable via the custom
// text input, so the picker never reduces flexibility.
const MODEL_PRESETS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'gpt-4o', 'gpt-4o-mini'];
const MAX_EDGE = 1568; // Anthropic Vision sweet spot
const JPEG_QUALITY = 0.9;
const MAX_IMAGES = 6; // legacy the legacy service caps photos at 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — matches server cap (CLAUDE.md)

// Voice composition (MODE_KEYS, buildSystemPrompt + HARD_RULES, parseOptions,
// sanitizeReply) lives in voice-core.js as window.VoiceCore — the SINGLE source
// of truth the eval harness also imports, so the app sends the EXACT prompt the
// eval certifies. If the <script> tag is missing or out of order, fail loud
// rather than silently sending a HARD_RULES-less prompt (the bug this replaced).
if (typeof VoiceCore === 'undefined' || typeof VoiceCore.buildSystemPrompt !== 'function') {
  throw new Error('voice-core.js did not load before app.js — fix the <script> order in index.html');
}

// voicebuild.js MUST load before app.js: app.js uses window.VoiceBuild for the
// in-app voice-pack derivation feature (P3). If the <script> tag is missing or
// out of order, fail loud so the regression is obvious.
if (typeof VoiceBuild === 'undefined' || typeof VoiceBuild.parseDerivedPack !== 'function') {
  throw new Error('voicebuild.js did not load before app.js — fix the <script> order in index.html');
}

/* ===================== state ===================== */

const state = {
  files: [],          // { id, file, dataUrl } for thumbnails
  activeMode: null,   // one of TOURIST/KINK/LONG/GO or null
  activeTags: new Set(), // subset of #10, #re
  lastHistoryEntryId: null, // id of the most recent History.add — used by
                            // copyText to mark which option (chosenIndex) was picked.
  lastRefine: null,         // v36: which refine nudge produced the on-screen results
                            // (null = fresh/reopened). Drives the refine-bar indicator.
};

// v27: P3 in-app voice derivation — holds the parsed pack between "Build my
// voice" completing and the user tapping "Use this voice". Never written to
// localStorage until installBuiltPack() fires. Set to null when discarded or
// installed so there's no stale reference.
let pendingBuiltPack = null;

// v40: Voice tune — holds the corrective instruction returned by the tune API
// call, between "Tune my voice" completing and the user tapping "Apply". Set to
// null on Apply, Cancel, or a new tune call so there is never a stale ref.
let pendingCorrection = null;

/* ===================== dom helpers ===================== */

const $ = (id) => document.getElementById(id);

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function getKey() { return (localStorage.getItem(LS_KEY) || '').trim(); }
function getOpenAIKey() { return (localStorage.getItem(LS_OPENAI_KEY) || '').trim(); }
function getModel() { return (localStorage.getItem(LS_MODEL) || DEFAULT_MODEL).trim() || DEFAULT_MODEL; }
function getProxyUrl() { return (localStorage.getItem(LS_PROXY) || '').trim(); }
// Fail-closed: absent key or any value other than "on" is treated as consent OFF.
function getEventsConsent() { return localStorage.getItem(LS_EVENTS_CONSENT) === 'on'; }

// Route by model id: gpt-*, chatgpt-*, and the o-series (o1/o3/o4...) are OpenAI;
// everything else (claude-*) calls Anthropic browser-direct. OpenAI is reachable
// only via the user's proxy because the browser can't call api.openai.com (CORS).
function isOpenAIModel(model) { return /^(gpt-|chatgpt-|o\d)/i.test(String(model || '')); }

function getPack() {
  const raw = localStorage.getItem(LS_PACK);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function packIsValid(p) {
  return p && typeof p.base_voice === 'string' && p.modes && typeof p.modes === 'object';
}

// P1b — voice-pack install integrity validator.
// Returns { ok: true } or { ok: false, error: '<human-readable reason>' }.
// Called BEFORE persisting an incoming pack (savePastedPack, loadPackFromFile,
// loadPackFromUrl, useStarterVoice). packIsValid() is kept for runtime reads
// (packs already in storage) where we trust our own write path.
function validateVoicePack(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'Voice pack is empty.' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, error: 'Voice pack is not valid JSON: ' + e.message }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Voice pack must be a JSON object (not an array or scalar).' };
  }
  if (typeof parsed.base_voice !== 'string' || parsed.base_voice.trim() === '') {
    return { ok: false, error: 'Voice pack is missing the required "base_voice" string field.' };
  }
  if (!parsed.modes || typeof parsed.modes !== 'object' || Array.isArray(parsed.modes)) {
    return { ok: false, error: 'Voice pack is missing the required "modes" object field.' };
  }
  if (Object.keys(parsed.modes).length === 0) {
    return { ok: false, error: 'Voice pack "modes" object is empty — at least one mode is required.' };
  }
  return { ok: true, pack: parsed };
}

/* ===================== app-use telemetry (device-local) ===================== */
// Privacy posture: PURE COUNTS, no message/screenshot content, never transmitted.
// They ride along ONLY in the History → Export payload the user explicitly shares
// (same "nothing leaves the device unless you export it" contract as History).
// This is the "data on app use" signal the per-generation History store misses:
// History saves SUCCESSES only, so attempts, failures, and error kinds would be
// invisible without this. Counts are what a maintainer needs to see how the app
// is actually used (which models/voices, how often, what fails) across testers.

function readUsage() {
  try { return JSON.parse(localStorage.getItem(LS_USAGE)) || {}; } catch { return {}; }
}

// Coarse, content-free error bucket derived from the friendlyError() message.
function classifyError(msg) {
  const m = String(msg || '').toLowerCase();
  if (/key rejected|api key|auth|401/.test(m)) return 'auth';
  if (/rate limit/.test(m)) return 'rate_limit';
  if (/credit|billing|balance|quota|insufficient/.test(m)) return 'out_of_credit';
  if (/network|connection|timed out|timeout|reach/.test(m)) return 'network';
  if (/screenshot|image|format|size|dimension/.test(m)) return 'image';
  if (/overloaded|server error/.test(m)) return 'provider';
  return 'other';
}

// One call per Generate OUTCOME. outcome ∈ {success, refusal, error}. Bumps the
// total-attempts counter + the outcome counter + per-model / per-mode tallies
// (+ a coarse error-kind tally on errors), and tracks first/last use timestamps.
// Best-effort: a telemetry write must NEVER break or block a generation.
function recordUsage(outcome, model, mode, errorKind) {
  try {
    const u = readUsage();
    const now = new Date().toISOString();
    u.firstUse = u.firstUse || now;
    u.lastUse = now;
    u.attempts = (u.attempts || 0) + 1;
    u[outcome] = (u[outcome] || 0) + 1;
    u.byModel = u.byModel || {};
    if (model) u.byModel[model] = (u.byModel[model] || 0) + 1;
    u.byMode = u.byMode || {};
    const mm = mode || 'LOCAL';
    u.byMode[mm] = (u.byMode[mm] || 0) + 1;
    if (errorKind) {
      u.byError = u.byError || {};
      u.byError[errorKind] = (u.byError[errorKind] || 0) + 1;
    }
    localStorage.setItem(LS_USAGE, JSON.stringify(u));
  } catch { /* telemetry is best-effort */ }
}

/* ===================== events telemetry (P4, v29) ===================== */
// Privacy contract (outputs/p4-events-schema-consent.md):
//   - Consent-gated: ZERO network calls to /events when eventsConsent != "on".
//   - Events-only: exactly the fields below (counts/categories/timings).
//   - NEVER includes: screenshot bytes, conversation text, reply-option text,
//     the prompt, the API key, or any free-text content.
//   - Fire-and-forget: must NEVER await-block or delay the reply render.

// Send one anonymous usage event when the user has explicitly opted in.
// Called from onGenerate() on both success and error paths.
// eventData must be a plain object using only the allowed schema fields.
function sendEvent(eventData) {
  if (!getEventsConsent()) return; // fail-closed: no send without explicit opt-in
  // Build the schema object (§1). Only allowed fields; no content/key/text fields.
  const payload = {
    voice:       eventData.voice       !== undefined ? eventData.voice       : null,
    model:       eventData.model       !== undefined ? eventData.model       : null,
    optionCount: eventData.optionCount !== undefined ? eventData.optionCount : null,
    chosenIndex: eventData.chosenIndex !== undefined ? eventData.chosenIndex : null,
    latencyMs:   eventData.latencyMs   !== undefined ? eventData.latencyMs   : null,
    errorClass:  eventData.errorClass  !== undefined ? eventData.errorClass  : '',
    appVersion:  APP_VERSION,
    ts:          Date.now(),
  };
  // Fire-and-forget: never awaited, never allowed to throw. A failed/slow event
  // POST must never delay or break showing the user their reply options.
  fetch(EVENTS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {}); // swallow all errors silently
}

/* ===================== prompt composition ===================== */
// buildSystemPrompt / parseOptions / sanitizeReply are provided by VoiceCore
// (voice-core.js), the single source of truth shared with the eval harness.
// Call sites use VoiceCore.* directly — see onGenerate().

// v32: refine loop. Each chip maps to a one-line tone nudge appended to the
// USER-TURN instruction (NOT the system prompt). This is the same steering
// channel the Notes field already uses, so voice-core.js (the eval-certified
// prompt engine) is unchanged and the certified system prompt does not drift.
// Keys mirror the data-refine attributes on the .refine-chip buttons.
const REFINE_HINTS = {
  shorter: 'Make each option noticeably shorter and punchier, one or two lines at most.',
  bolder:  'Be bolder and more confident, raise the stakes and show clearer intent.',
  funnier: 'Lean funnier, more playful and witty, while still sounding natural.',
  curious: 'Lead with genuine curiosity about her, and end with a specific, easy-to-answer question.',
  move:    'Move things toward meeting up, suggest a concrete, low-pressure plan.',
};

// v36: short display names for the refine-applied indicator (refine-bar label +
// active chip). Keys mirror REFINE_HINTS / the data-refine attributes.
const REFINE_LABELS = {
  shorter: 'shorter',
  bolder:  'bolder',
  funnier: 'funnier',
  curious: 'more curious',
  move:    'make a move',
};

// v39: "Read the room" — a separate strategic-read call that does NOT use or
// touch the voice pack or voice-core.js. The prompts live here as consts (not
// in voice-core.js, which is eval-certified and byte-frozen).
const READ_SYSTEM_PROMPT =
  'You are a sharp, honest dating coach reading a screenshot of a dating-app profile or conversation for someone who wants to reply well. You are NOT writing the reply. You give a brief, specific, strategic read so they know where they stand and what to do next. Reference what you actually see in the screenshot. Be honest, if she seems disengaged or the thread is dying, say so plainly. No flattery, no hedging, no generic dating tips, no preamble. Keep it tight.';

const READ_USER_PROMPT =
  'Read the screenshot and give a quick strategic read in EXACTLY this structure, each part 1 to 2 short sentences, keep the labels:\n\n' +
  'READ: What is actually going on, her apparent interest and energy level, and the specific thing she is responding to. If it is a profile with no chat yet, read her vibe and what is most worth leading with. Reference something specific you see.\n\n' +
  'WORKING / STALLING: The single most important thing helping or hurting your position right now.\n\n' +
  'NEXT MOVE: One concrete, specific thing to do in your next message, an angle, a question, a plan to suggest, or a tone shift. Not a full message, just the move.\n\n' +
  'Be specific to THIS screenshot.';

// Build the user-turn text: the shared USER_PROMPT, plus the optional Notes
// steering, plus an optional refine nudge. All three are user-turn instructions
// — the system prompt (VoiceCore.buildSystemPrompt) is composed separately and
// stays byte-identical to what the eval certifies.
function composeUserText(notes, refineKey) {
  const parts = [VoiceCore.USER_PROMPT];
  if (notes) parts.push(`USER NOTE (follow this instruction): ${notes}`);
  const hint = refineKey ? REFINE_HINTS[refineKey] : null;
  if (hint) parts.push(`REFINE (the user wants another take on the same screenshot, apply this): ${hint}`);
  return parts.join('\n\n');
}

/* ===================== image processing ===================== */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Couldn't read that file. Try another screenshot."));
    fr.readAsDataURL(file);
  });
}

// Resize via canvas to longest-edge <= MAX_EDGE, encode JPEG, return bare base64.
function resizeToJpegBase64(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const longest = Math.max(width, height);
      if (longest > MAX_EDGE) {
        const scale = MAX_EDGE / longest;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      const comma = out.indexOf(',');
      resolve(out.slice(comma + 1)); // strip "data:image/jpeg;base64," prefix
    };
    img.onerror = () => reject(new Error("Couldn't read that image. It may be an unsupported format (use a PNG or JPEG screenshot) or corrupted."));
    img.src = dataUrl;
  });
}

/* ===================== Anthropic call ===================== */

// P1d — Map a model-API failure to a short, actionable, PROVIDER-CORRECT message.
// Provider-aware: the OpenAI path routes the same errors through here, so a
// quota/auth message must name the RIGHT provider + console — otherwise a GPT 429
// told the user to "add billing at console.anthropic.com" (the bug the user hit).
//
// Precedence order (topmost rule wins; later ones are less specific):
//   1. Out-of-credit / quota-exhausted — distinct from rate-limit: "wait a few
//      seconds" is WRONG advice when the fix is adding billing. Check message text
//      first (OpenAI returns 429 for BOTH rate-limit AND out-of-balance).
//   2. Auth / invalid key (401 / authentication_error)
//   3. Content refusal / content policy violation — model refused to generate;
//      not a key or billing problem.
//   4. Rate-limit (429 / rate_limit_error) — genuinely ephemeral, just wait.
//   5. Overloaded / service unavailable (529 / 503 / overloaded_error)
//   6. Image / media format rejection (400 + image keywords)
//   7. Permission denied (403) — key valid but model or feature restricted
//   8. Model name rejected (400 + model keyword)
//   9. Server-side 5xx errors
//  10. Default: echo status + message (truncated; avoids "something went wrong" black-box)
function friendlyError(status, type, msg, provider) {
  const m = String(msg || '');
  const isOpenAI = provider === 'openai';
  const name = isOpenAI ? 'OpenAI' : 'Anthropic';
  const billingUrl = isOpenAI ? 'platform.openai.com' : 'console.anthropic.com';
  const keyUrl = isOpenAI ? 'platform.openai.com/api-keys' : 'console.anthropic.com/settings/keys';
  // 1. Out-of-credit / quota exhausted — check BEFORE generic 429 rule.
  if (/credit|billing|balance|quota|insufficient/i.test(m) ||
      type === 'insufficient_quota' || type === 'quota_exceeded') {
    return `Your ${name} account is out of credit. Add billing at ${billingUrl}.`;
  }
  // 2. Auth / invalid key.
  if (status === 401 || type === 'authentication_error' || type === 'invalid_api_key') {
    return `API key rejected. Check or re-paste your ${name} key in Settings (${keyUrl}).`;
  }
  // 3. Content refusal / safety filter.
  if (type === 'content_policy_violation' || type === 'content_filter' ||
      /content.{0,20}polic|violat|harm|unsafe|refus/i.test(m)) {
    return `${name} declined to generate a reply for this content. Try a different screenshot or a less explicit context.`;
  }
  // 4. Rate-limit — ephemeral, just wait.
  if (status === 429 || type === 'rate_limit_error') {
    return `Rate limited by ${name}. Wait a few seconds and try again.`;
  }
  // 5. Overloaded / service unavailable.
  if (status === 529 || status === 503 || type === 'overloaded_error') {
    return `${name} is overloaded right now. Try again in a moment.`;
  }
  // 6. Image / media format rejection.
  if (status === 400 && /image|media|size|dimension|pixel/i.test(m)) {
    return 'That screenshot was rejected (format or size). Try another, or crop it smaller.';
  }
  // 7. Permission denied (feature/model access restricted on this key/org).
  if (status === 403 || type === 'permission_error' || type === 'forbidden') {
    return `${name} denied access (403). Your API key may not have access to this model — check ${keyUrl}.`;
  }
  // 8. Model name rejected.
  if (status === 400 && /model/i.test(m)) {
    return `That model name was rejected. Pick another from the Model menu in Settings (default: ${DEFAULT_MODEL}).`;
  }
  // 9. Server-side 5xx errors.
  if (status >= 500) return `${name} had a server error. Try again in a moment.`;
  // 10. Default — echo status + message so we never show a black-box error.
  return `Could not generate (${status}). ${m}`.slice(0, 200);
}

async function callAnthropic({ key, model, system, userText, imagesB64 }) {
  const content = [];
  for (const b64 of imagesB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
    });
  }
  content.push({ type: 'text', text: userText });

  // Abort a stalled request after 60s so a flaky cellular connection can't spin
  // the spinner forever (the only recovery would be a full reload). clearTimeout
  // runs in finally so a fast success doesn't leave a dangling timer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        // Prompt-cache the voice-pack system prompt (~5K tokens, constant across a
        // user's session). Repeated generates within ~5 min bill the prefix at 0.1x
        // instead of full price every call. Real-use cost cut; no behavior change.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Translate only the timeout abort; re-throw everything else unchanged so
    // onGenerate's existing network-error mapping still fires (don't double-wrap).
    if (err && err.name === 'AbortError') {
      throw new Error('Timed out reaching Anthropic (60s). Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} — could not parse response.`);
  }

  if (!res.ok) {
    const type = (json && json.error && json.error.type) || '';
    const msg = (json && json.error && json.error.message) || JSON.stringify(json);
    throw new Error(friendlyError(res.status, type, msg, 'anthropic'));
  }

  const block = json.content && json.content.find((c) => c.type === 'text');
  if (!block) throw new Error('No text content in response.');
  return block.text;
}

// OpenAI path: the browser CANNOT call api.openai.com directly (no CORS), so we
// POST to the user's own Cloudflare Worker proxy (Settings -> Proxy URL), which
// forwards to OpenAI and returns { text }. Same 60s abort + friendlyError mapping
// as the Anthropic path; the proxy passes OpenAI's status+message through so the
// existing error taxonomy fires unchanged. See worker/README.md.
async function callOpenAIViaProxy({ proxyUrl, key, model, system, userText, imagesB64 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openai-key': key },
      body: JSON.stringify({ model, system, userText, imagesB64 }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Timed out reaching the OpenAI proxy (60s). Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} — could not parse proxy response.`);
  }

  if (!res.ok) {
    const status = (json && json.error && json.error.status) || res.status;
    const msg = (json && json.error && json.error.message) || JSON.stringify(json);
    throw new Error(friendlyError(status, '', msg, 'openai'));
  }
  if (typeof json.text !== 'string' || !json.text) throw new Error('No text content in response.');
  return json.text;
}

/* ===================== generate flow ===================== */

function activeModesList() {
  // Primary mode (single-select) + stacked tags. Empty => composition defaults to LOCAL.
  const modes = [];
  if (state.activeMode) modes.push(state.activeMode);
  for (const t of state.activeTags) modes.push(t);
  return modes;
}

async function onGenerate(refineKey) {
  // refineKey is a string ('shorter', 'bolder', …) when invoked from a refine
  // chip; the Generate / "New options" buttons call onGenerate() and a click
  // handler may pass an Event — coerce any non-string to null so a stray Event
  // object can never be treated as a refine key.
  if (typeof refineKey !== 'string') refineKey = null;
  const statusEl = $('status');
  const resultsEl = $('results');
  resultsEl.innerHTML = '';
  hide($('refineBar')); // hide stale refine controls until fresh results land

  const pack = getPack();
  if (!packIsValid(pack)) {
    routeToSettings('Load your voice pack to generate.');
    return;
  }
  if (state.files.length === 0) {
    setStatusText('error', 'Add at least one screenshot first.');
    return;
  }

  // Pick the provider from the model id: gpt-*/chatgpt-*/o-series route through
  // the proxy (OpenAI blocks browser-direct calls); claude-* stays browser-direct.
  const model = getModel();
  const useOpenAI = isOpenAIModel(model);
  if (useOpenAI) {
    if (!getOpenAIKey()) { routeToSettings('Add your OpenAI API key to use a GPT model.'); return; }
    if (!getProxyUrl()) { routeToSettings('Add your Proxy URL to use a GPT model (deploy the proxy — see worker/README.md).'); return; }
  } else if (!getKey()) {
    routeToSettings('Add your Anthropic API key to generate.');
    return;
  }

  $('generateBtn').disabled = true;
  setRefineDisabled(true);
  setStatus('loading', '<span class="spinner"></span>Reading the screenshot and writing replies…');
  const _genStartMs = Date.now(); // latency timer for the events event
  // v38: telegraph the result shape while the API is in flight. renderSkeleton()
  // injects 3 ghost cards into #results so the user sees the layout immediately.
  // renderResults() clears them on success; the refusal + error returns below do
  // the same via explicit resultsEl.innerHTML = '' to guarantee no skeleton lingers.
  renderSkeleton();

  try {
    const imagesB64 = [];
    for (const f of state.files.slice(0, MAX_IMAGES)) {
      imagesB64.push(await resizeToJpegBase64(f.dataUrl));
    }

    const system = VoiceCore.buildSystemPrompt(pack, activeModesList());
    // User-turn instruction = shared USER_PROMPT + optional Notes steering +
    // optional refine nudge (v32, refineKey). The system prompt above is
    // composed separately and stays byte-identical to the eval-certified
    // VoiceCore output — refine never touches it.
    const notes = $('notes').value.trim();
    const userText = composeUserText(notes, refineKey);
    const text = useOpenAI
      ? await callOpenAIViaProxy({ proxyUrl: getProxyUrl(), key: getOpenAIKey(), model, system, userText, imagesB64 })
      : await callAnthropic({ key: getKey(), model, system, userText, imagesB64 });
    const options = VoiceCore.parseOptions(text).map(VoiceCore.sanitizeReply);

    // Guard the non-usable cases: blank/whitespace, OR fewer than 2 options. The
    // latter catches a model refusal or odd prose response — parseOptions returns
    // those as a single whole-text "option" (its last-resort fallback), which
    // would otherwise render as a lone copy-able card (e.g. a refusal shown as a
    // reply). Show a clear retry instead. Happy path returns 3 (a legit 2 is fine).
    if (options.length < 2 || options.every((o) => !o.trim())) {
      recordUsage('refusal', model, state.activeMode);
      // v38: clear skeletons so a refusal never leaves ghost cards under the error.
      resultsEl.innerHTML = '';
      setStatusText('error', 'No usable reply options came back. Try again, or try a clearer screenshot or a different voice.');
      return;
    }

    hide(statusEl);
    state.lastRefine = refineKey; // v36: record which nudge (or null) produced these results
    renderResults(options);
    recordUsage('success', model, state.activeMode);
    // P4: fire anonymous usage event (best-effort, consent-gated, events-only).
    sendEvent({ voice: state.activeMode || 'LOCAL', model, optionCount: options.length, latencyMs: Date.now() - _genStartMs });
    state.lastGen = { voice: state.activeMode || 'LOCAL', model }; // context for the chosenIndex-on-Copy event
    // Persist device-local (fire-and-forget; history must never block or break a
    // result). thumbs = the resized JPEGs we just sent, as data URLs, so reopening
    // can re-stage and re-send them. notes/model are saved as well so a later
    // export carries the full context. Never transmitted anywhere — IndexedDB only.
    state.lastHistoryEntryId = null; // reset until the add() promise resolves
    History.add({
      mode: state.activeMode,
      tags: Array.from(state.activeTags),
      thumbs: imagesB64.map((b) => 'data:image/jpeg;base64,' + b),
      options,
      notes,
      model,
      appVersion: APP_VERSION,
    })
      .then((e) => { state.lastHistoryEntryId = e.id; })
      .catch(() => {});
  } catch (err) {
    const raw = err.message || String(err);
    const m = /failed to fetch|load failed|networkerror|network request/i.test(raw)
      ? 'Network error. Check your connection and try again.'
      : raw;
    const errClass = classifyError(m);
    recordUsage('error', model, state.activeMode, errClass);
    // P4: fire anonymous usage event on error path too (consent-gated, events-only).
    sendEvent({ voice: state.activeMode || 'LOCAL', model, optionCount: 0, latencyMs: Date.now() - _genStartMs, errorClass: errClass });
    // v38: clear skeletons so a network/API error never leaves ghost cards under the message.
    resultsEl.innerHTML = '';
    setStatusText('error', m);
  } finally {
    $('generateBtn').disabled = false;
    setRefineDisabled(false);
  }
}

// v32: enable/disable the refine controls (chips + "New options") as a group,
// mirroring the #generateBtn disabled-during-generation pattern so a user can't
// fire a second generation on top of one already in flight.
function setRefineDisabled(disabled) {
  document.querySelectorAll('.refine-chip').forEach((b) => { b.disabled = disabled; });
  const rb = $('regenBtn');
  if (rb) rb.disabled = disabled;
}

// v36: reflect the active refine nudge into the refine bar — highlight the chip
// that produced the current results + update the label, with a clear path back to
// a neutral set ("New options"). state.lastRefine is null for fresh/reopened results.
function syncRefineBar() {
  document.querySelectorAll('.refine-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.refine === state.lastRefine);
  });
  const label = $('refineLabel');
  if (label) {
    label.textContent = state.lastRefine
      ? `Refined: ${REFINE_LABELS[state.lastRefine] || state.lastRefine}. Tap another, or "New options" for a fresh set.`
      : 'Not quite? Tap to refine:';
  }
}

// Shared show/className/scroll logic for both status setters. Returns the el so
// the caller sets its content (innerHTML vs textContent — see below).
function showStatus(kind) {
  const el = $('status');
  el.className = `status ${kind}`;
  show(el);
  // Pull the spinner/error into view on a phone, where #status renders below the
  // Generate button (often below the fold). block:'nearest' is a no-op when the
  // element is already visible, so top-of-page errors don't jump the viewport.
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}

// HTML setter — used ONLY by the loading call site, which needs markup for the
// <span class="spinner">. Do not pass untrusted text here.
function setStatus(kind, html) {
  showStatus(kind).innerHTML = html;
}

// Text setter — used by every ERROR call site. friendlyError() can echo the raw
// Anthropic error message/JSON, so render it as textContent (not innerHTML) to
// avoid injecting untrusted-ish content into the DOM.
function setStatusText(kind, text) {
  showStatus(kind).textContent = text;
}

// Show the "Start over" button once there's anything to clear — files staged
// OR results rendered. Hidden again when both are empty. Voice mode/tags are
// NOT part of this (intentionally — see resetForNextProfile).
function updateStartOverVisibility() {
  const hasWork = state.files.length > 0 || $('results').children.length > 0;
  const btn = $('startOverBtn');
  if (hasWork) show(btn); else hide(btn);
}

// One-tap reset for the next profile/conversation. Clears staged screenshots,
// thumbnails, results, and status — but deliberately KEEPS the chosen voice
// mode + tags, so the user can run several profiles in the same voice without
// re-picking it each time.
function resetForNextProfile() {
  state.files = [];
  $('notes').value = ''; // clear per-conversation steering for the next profile
  $('results').innerHTML = '';
  hide($('status'));
  hide($('refineBar')); // no results => nothing to refine
  state.lastRefine = null; // v36: reset the refine indicator
  // v39: clear and hide the read card so a new profile starts clean.
  const readCard = $('readCard');
  if (readCard) { readCard.innerHTML = ''; hide(readCard); }
  lastReadText = ''; // v44: C10 — clear the stashed read text for the next profile
  renderThumbs(); // re-renders empty + refreshes Start-over visibility
}

// v44: C10 — Extract the NEXT MOVE line from a read text. Case-insensitive.
// Returns the text that follows "NEXT MOVE:" up to the next double-newline or
// end-of-string, with internal newlines collapsed to spaces and outer whitespace
// trimmed. Returns '' if the label is absent or the captured text is empty.
// Defensive: never throws, always returns a string. Top-level so browser-smoke
// can verify it directly via window.extractNextMove.
function extractNextMove(readText) {
  try {
    if (!readText || typeof readText !== 'string') return '';
    const match = readText.match(/NEXT MOVE:\s*([\s\S]*?)(?:\n\n|$)/i);
    if (!match) return '';
    return match[1].replace(/\n+/g, ' ').trim();
  } catch { return ''; }
}

// v39: "Read the room" — strategic coach read of the staged screenshot(s).
// Separate API call with its own prompts; does NOT use the voice pack or
// voice-core.js (READ_SYSTEM_PROMPT / READ_USER_PROMPT defined above).
// No recordUsage, no History save, no sendEvent — ephemeral analysis only.
async function readTheRoom() {
  if (state.files.length === 0) {
    setStatusText('error', 'Add a screenshot first.');
    return;
  }

  const model = getModel();
  const useOpenAI = isOpenAIModel(model);
  if (useOpenAI) {
    if (!getOpenAIKey()) { routeToSettings('Add your OpenAI API key to use a GPT model.'); return; }
    if (!getProxyUrl()) { routeToSettings('Add your Proxy URL to use a GPT model (deploy the proxy — see worker/README.md).'); return; }
  } else if (!getKey()) {
    routeToSettings('Add your Anthropic API key to generate.');
    return;
  }

  const readRoomBtn = $('readRoomBtn');
  const readCard = $('readCard');
  readRoomBtn.disabled = true;
  readCard.innerHTML = '';
  show(readCard);
  // Loading state: spinner text inside the card.
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'read-loading';
  loadingDiv.innerHTML = '<span class="spinner"></span>Reading the room…';
  readCard.appendChild(loadingDiv);
  readCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const imagesB64 = [];
    for (const f of state.files.slice(0, MAX_IMAGES)) {
      imagesB64.push(await resizeToJpegBase64(f.dataUrl));
    }

    const text = useOpenAI
      ? await callOpenAIViaProxy({ proxyUrl: getProxyUrl(), key: getOpenAIKey(), model, system: READ_SYSTEM_PROMPT, userText: READ_USER_PROMPT, imagesB64 })
      : await callAnthropic({ key: getKey(), model, system: READ_SYSTEM_PROMPT, userText: READ_USER_PROMPT, imagesB64 });

    // Render the read into the card. XSS discipline: build nodes with
    // textContent, never innerHTML of model output. Split into lines; wrap
    // known section labels in a <span class="read-label">.
    readCard.innerHTML = '';
    const SECTION_LABELS = ['READ:', 'WORKING / STALLING:', 'NEXT MOVE:'];
    const lines = text.split('\n');
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'read-line';
      // Defensive label detection: does this line (trimmed) start with a known label?
      let matched = false;
      for (const label of SECTION_LABELS) {
        if (line.trimStart().startsWith(label)) {
          const labelSpan = document.createElement('span');
          labelSpan.className = 'read-label';
          labelSpan.textContent = label;
          div.appendChild(labelSpan);
          // Everything after the label is the body text.
          const rest = line.trimStart().slice(label.length);
          if (rest) div.appendChild(document.createTextNode(rest));
          matched = true;
          break;
        }
      }
      if (!matched) {
        div.textContent = line;
      }
      readCard.appendChild(div);
    }
    // v44: C10 — stash the raw text and append the "write replies with this in mind" CTA.
    lastReadText = text;
    const ctaBtn = document.createElement('button');
    ctaBtn.type = 'button';
    ctaBtn.className = 'read-cta';
    ctaBtn.textContent = '✍️ Write replies with this in mind';
    ctaBtn.addEventListener('click', () => {
      const move = extractNextMove(lastReadText);
      if (move) $('notes').value = move;
      onGenerate();
    });
    readCard.appendChild(ctaBtn);
    readCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    const raw = err.message || String(err);
    const m = /failed to fetch|load failed|networkerror|network request/i.test(raw)
      ? 'Network error. Check your connection and try again.'
      : raw;
    readCard.innerHTML = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'read-error';
    errDiv.textContent = m;
    readCard.appendChild(errDiv);
  } finally {
    readRoomBtn.disabled = false;
  }
}

// v38: inject 3 skeleton ghost cards into #results during generation so the user
// sees the shape of what's coming rather than an empty div. Called immediately
// after entering the loading state in onGenerate(); cleared automatically when
// renderResults() / error paths run (they both reset wrap.innerHTML or resultsEl.innerHTML).
function renderSkeleton() {
  const wrap = $('results');
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const card = document.createElement('div');
    card.className = 'result-card skeleton';
    // Two lines of varying width to suggest the variable-length text of a reply.
    const line1 = document.createElement('div');
    line1.className = 'skeleton-line';
    const line2 = document.createElement('div');
    line2.className = 'skeleton-line short';
    card.appendChild(line1);
    card.appendChild(line2);
    wrap.appendChild(card);
  }
}

function renderResults(options) {
  // Clear the "from history" badge — fresh generations never show it; only
  // reopenEntry (below) sets it. Clearing here covers both the fresh-generate
  // path and any caller that may render results programmatically in future.
  const badge = $('historyBadge');
  badge.textContent = '';
  hide(badge);

  const wrap = $('results');
  wrap.innerHTML = '';
  options.forEach((opt, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';

    const text = document.createElement('div');
    text.className = 'result-text';
    text.textContent = opt;

    // v32: per-option actions row — Edit (tweak the reply inline before sending)
    // + Copy (copies the LIVE text, so an edit is what lands on the clipboard).
    const actions = document.createElement('div');
    actions.className = 'result-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit this reply');
    editBtn.addEventListener('click', () => toggleEdit(text, editBtn));

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    // Read the CURRENT text at click time (text.textContent), NOT the original
    // `opt` closure — so an inline edit is what actually gets copied (v32).
    btn.addEventListener('click', () => copyText(text.textContent, btn, idx));

    actions.appendChild(editBtn);
    actions.appendChild(btn);
    card.appendChild(text);
    card.appendChild(actions);
    wrap.appendChild(card);
  });
  updateStartOverVisibility();
  show($('refineBar')); // v32: results are on screen — offer one-tap refinement
  syncRefineBar();      // v36: reflect which nudge (if any) produced these results
  // When replies land, scroll them into view so the user sees the result (the
  // cards render below the Generate button, otherwise off-screen on a phone).
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// v32: toggle inline editing on a result card's text. Options are single-line
// (VoiceCore.sanitizeReply collapses any newlines), so contentEditable +
// reading textContent round-trips cleanly. The Copy button always reads the
// live textContent, so whatever the user edits here is exactly what gets copied.
function toggleEdit(textEl, editBtn) {
  const editing = textEl.getAttribute('contenteditable') === 'true';
  if (editing) {
    textEl.removeAttribute('contenteditable');
    textEl.classList.remove('editing');
    editBtn.textContent = 'Edit';
  } else {
    textEl.setAttribute('contenteditable', 'true');
    textEl.classList.add('editing');
    editBtn.textContent = 'Done';
    textEl.focus();
    // Place the caret at the end of the text for a natural edit start.
    try {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* caret placement is best-effort */ }
  }
}

async function copyText(text, btn, index) {
  // Record which option the user picked (implicit positive signal — they tapped
  // Copy on it, so they intend to send it). Fire-and-forget; history must never
  // block or break the copy itself. updateChosen tolerates a missing entry.
  if (state.lastHistoryEntryId != null && Number.isInteger(index)) {
    History.updateChosen(state.lastHistoryEntryId, index).catch(() => {});
  }
  // P4: which-option-won signal — the highest-value telemetry. sendEvent is itself
  // consent-gated + events-only + fire-and-forget; carries the generation's
  // voice+model so picks correlate per voice. Never blocks the copy.
  if (state.lastGen && Number.isInteger(index)) {
    sendEvent({ voice: state.lastGen.voice, model: state.lastGen.model, chosenIndex: index });
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older WebKit
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  // v38: 10ms haptic tick on successful copy — guards browsers without vibrate
  // (desktop Safari, iOS Safari) so it never throws on unsupported platforms.
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('copied');
  }, 1400);
}

/* ===================== file picking / thumbnails ===================== */

async function onFilesPicked(fileList) {
  const incoming = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  if (incoming.length === 0) {
    // Picked something, but nothing was a supported image (e.g. a HEIC with an
    // empty MIME type on some pickers, or a non-image file) — say so instead of
    // silently doing nothing.
    if (fileList && fileList.length > 0) {
      setStatusText('error', "That file wasn't a supported image. Use a PNG or JPEG screenshot.");
    }
    return;
  }
  await addImages(incoming);
}

// APPEND a batch of image File/Blob objects into state.files (shared by the
// camera-roll picker AND the paste paths). Respects MAX_IMAGES, skips oversized
// inputs, and re-renders thumbnails. Never replaces existing files.
async function addImages(images) {
  let added = 0;
  try {
    for (const file of images) {
      if (state.files.length >= MAX_IMAGES) {
        setStatusText('error', `Holding the first ${MAX_IMAGES} screenshots. Remove one to add another.`);
        break;
      }
      // Per-image 10 MB cap — matches the server cap (CLAUDE.md). Enforced here
      // in the shared helper so the camera-roll picker AND the paste paths both
      // reject oversized inputs. Pasted blobs may have no .name, so fall back.
      if (file.size > MAX_IMAGE_BYTES) {
        const label = file.name || 'That screenshot';
        setStatusText('error', `${label} is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Screenshots must be under 10 MB.`);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      state.files.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, dataUrl });
      added++;
    }
  } catch (err) {
    setStatusText('error', err.message || "Couldn't add that screenshot.");
  }
  renderThumbs();
  return added;
}

// Pull image(s) from the system clipboard via the async Clipboard API. Called
// DIRECTLY inside a click handler — do NOT await anything before clipboard.read()
// or Safari drops the user-gesture grant and the read rejects.
async function onPasteClick() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    setStatusText('error', 'Paste from clipboard is not supported here. Add a screenshot from your camera roll instead.');
    return;
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    setStatusText('error', 'Nothing to paste — copy a screenshot first, or add from your camera roll.');
    return;
  }
  const blobs = [];
  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'));
    if (!imgType) continue;
    try {
      blobs.push(await item.getType(imgType));
    } catch { /* skip an unreadable item */ }
  }
  if (blobs.length === 0) {
    setStatusText('error', 'Nothing to paste — copy a screenshot first, or add from your camera roll.');
    return;
  }
  await addImages(blobs);
}

// Document-level paste (long-press → Paste, or ⌘V on desktop). Covers the path
// where the OS hands us a paste event instead of a clipboard.read() grant.
function onDocumentPaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const blobs = [];
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) blobs.push(blob);
    }
  }
  if (blobs.length === 0) return; // not an image paste — let it through
  e.preventDefault();
  addImages(blobs);
}

function renderThumbs() {
  const wrap = $('thumbs');
  wrap.innerHTML = '';
  state.files.forEach((f) => {
    const t = document.createElement('div');
    t.className = 'thumb';

    const img = document.createElement('img');
    img.src = f.dataUrl;
    img.alt = 'screenshot';

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove');
    rm.addEventListener('click', () => {
      state.files = state.files.filter((x) => x.id !== f.id);
      renderThumbs();
    });

    t.appendChild(img);
    t.appendChild(rm);
    wrap.appendChild(t);
  });
  updateStartOverVisibility();
}

/* ===================== mode / tag selection ===================== */

// Reflect state.activeMode / state.activeTags into the picker button styling.
// wireModePicker handles click-driven changes; this is for programmatic changes
// (e.g. reopening a history entry restores its mode/tags).
function syncModeButtons() {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.activeMode);
  });
  document.querySelectorAll('.tag-btn').forEach((b) => {
    b.classList.toggle('active', state.activeTags.has(b.dataset.tag));
  });
}

// v38: restore the last-used voice mode + tags from localStorage so a daily user
// keeps their voice across sessions. Must be called from init() BEFORE wireModePicker()
// so state is set before the picker attaches its listeners.
// Unknown/empty values leave state at its default (null / empty Set).
function restoreLastVoice() {
  try {
    const savedMode = localStorage.getItem(LS_LAST_MODE);
    // Any non-empty string is treated as a mode key; the picker will just show no
    // active button if the saved key doesn't match a current mode (harmless).
    if (savedMode) state.activeMode = savedMode;
  } catch { /* localStorage unavailable — fine, use defaults */ }
  try {
    const savedTags = localStorage.getItem(LS_LAST_TAGS);
    if (savedTags) {
      const parsed = JSON.parse(savedTags);
      if (Array.isArray(parsed)) state.activeTags = new Set(parsed);
    }
  } catch { /* bad JSON or unavailable — use defaults */ }
}

function wireModePicker() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (state.activeMode === mode) {
        state.activeMode = null; // toggle off
      } else {
        state.activeMode = mode; // single-select
      }
      document.querySelectorAll('.mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === state.activeMode);
      });
      // v38: persist so the next session restores this choice.
      try {
        if (state.activeMode) localStorage.setItem(LS_LAST_MODE, state.activeMode);
        else localStorage.removeItem(LS_LAST_MODE);
        localStorage.setItem(LS_LAST_TAGS, JSON.stringify(Array.from(state.activeTags)));
      } catch { /* best-effort */ }
    });
  });

  document.querySelectorAll('.tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      btn.classList.toggle('active', state.activeTags.has(tag));
      // v38: persist so the next session restores this choice.
      try {
        if (state.activeMode) localStorage.setItem(LS_LAST_MODE, state.activeMode);
        else localStorage.removeItem(LS_LAST_MODE);
        localStorage.setItem(LS_LAST_TAGS, JSON.stringify(Array.from(state.activeTags)));
      } catch { /* best-effort */ }
    });
  });
}

/* ===================== settings ===================== */

function routeToSettings(message) {
  if (message) setStatusText('error', message);
  openSettings();
}

// Single-screen switch: hide all screens, show one, scroll to top. Added when a
// third screen (History) joined Main + Settings — inline per-pair hide/show was
// getting error-prone (a stale screen could stay visible behind another).
function showScreen(which) {
  hide($('screenMain'));
  hide($('screenSettings'));
  hide($('screenHistory'));
  show($(which));
  window.scrollTo(0, 0);
}

// Model picker (v22): the <select> carries the presets; "Other" reveals the
// free-text #model input. These three helpers keep the two controls in sync.
function syncModelInputVisibility() {
  if ($('modelSelect').value === '__custom__') show($('model')); else hide($('model'));
}
// Reflect the saved model into the controls: a preset selects its option; any
// other id selects "Other" and shows it in the text input for editing.
function populateModelControls() {
  const saved = getModel();
  const sel = $('modelSelect');
  if (MODEL_PRESETS.includes(saved)) {
    sel.value = saved;
    $('model').value = '';
  } else {
    sel.value = '__custom__';
    $('model').value = saved;
  }
  syncModelInputVisibility();
}
// Resolve the chosen model: the custom input wins when "Other" is selected.
function readModelFromControls() {
  const sel = $('modelSelect');
  const model = sel.value === '__custom__' ? $('model').value.trim() : sel.value;
  return model || DEFAULT_MODEL;
}

// Shows #guidedSetup when setup is incomplete (no key OR no valid pack); hides it
// when both are present. Called each time Settings opens so new testers see the
// guide on their first visit and it disappears once they finish setup.
function refreshGuidedSetup() {
  const el = $('guidedSetup');
  if (!getKey() || !packIsValid(getPack())) show(el); else hide(el);
}

function openSettings() {
  $('apiKey').value = getKey();
  populateModelControls();
  $('openaiKey').value = getOpenAIKey();
  $('proxyUrl').value = getProxyUrl();
  $('packText').value = '';
  refreshPackStatus();
  // P4: reflect persisted events-consent state into the toggle (default OFF).
  const evToggle = $('eventsConsentToggle');
  if (evToggle) evToggle.checked = getEventsConsent();
  showScreen('screenSettings');
  refreshGuidedSetup();
}

function closeSettings() {
  refreshSetupBanner();
  showScreen('screenMain');
}

function refreshPackStatus() {
  const el = $('packStatus');
  const pack = getPack();
  if (packIsValid(pack)) {
    const modeCount = Object.keys(pack.modes || {}).length;
    el.textContent = `Voice pack loaded — ${modeCount} mode sections, base voice ${pack.base_voice.length} chars.`;
    el.classList.add('ok');
  } else {
    el.textContent = 'No voice pack loaded.';
    el.classList.remove('ok');
  }
}

function refreshSetupBanner() {
  const ready = getKey() && packIsValid(getPack());
  const banner = $('setupBanner');
  if (ready) hide(banner); else show(banner);
}

function saveSettings() {
  localStorage.setItem(LS_KEY, $('apiKey').value.trim());
  localStorage.setItem(LS_OPENAI_KEY, $('openaiKey').value.trim());
  localStorage.setItem(LS_PROXY, $('proxyUrl').value.trim());
  localStorage.setItem(LS_MODEL, readModelFromControls());
  closeSettings();
}

function savePastedPack() {
  const raw = $('packText').value.trim();
  if (!raw) { alert('Paste the voice-pack JSON first.'); return; }
  const result = validateVoicePack(raw);
  if (!result.ok) { alert('Cannot install voice pack: ' + result.error); return; }
  localStorage.setItem(LS_PACK, JSON.stringify(result.pack));
  $('packText').value = '';
  refreshPackStatus();
}

// Load voice pack from a picked .json file (AirDropped onto the phone). Avoids
// pasting a large JSON blob. Stays device-local.
async function loadPackFromFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const raw = await file.text();
    const result = validateVoicePack(raw);
    if (!result.ok) throw new Error(result.error);
    localStorage.setItem(LS_PACK, JSON.stringify(result.pack));
    refreshPackStatus();
  } catch (err) {
    alert('Could not load that file: ' + (err.message || err));
  } finally {
    e.target.value = '';
  }
}

async function loadPackFromUrl() {
  const url = $('packUrl').value.trim();
  if (!url) { alert('Enter a URL first.'); return; }
  const btn = $('loadUrlBtn');
  const orig = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const result = validateVoicePack(raw);
    if (!result.ok) throw new Error(result.error);
    localStorage.setItem(LS_PACK, JSON.stringify(result.pack));
    refreshPackStatus();
  } catch (e) {
    alert('Could not load pack: ' + (e.message || e));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

// One-tap install of the SHIPPED anonymous starter voice — the path a new tester
// uses when they haven't built their own pack yet. The starter JSON ships in
// the deployed bundle (voicepack.starter.json + SHELL precache), so this works
// offline after first load. Unknown fields like _starter_note are kept in
// localStorage (the composer ignores them) so the human reader can see them later.
async function useStarterVoice() {
  const btn = $('useStarterBtn');
  const orig = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const res = await fetch('voicepack.starter.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const result = validateVoicePack(raw);
    if (!result.ok) throw new Error('Starter pack failed validation: ' + result.error);
    localStorage.setItem(LS_PACK, JSON.stringify(result.pack));
    refreshPackStatus();
  } catch (e) {
    alert('Could not load the starter voice: ' + (e.message || e));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

/* ===================== connection test + shared proxy (P2, v25) ===================== */

// Sets #testConnStatus text + color. ok=true → green (.ok), ok=false → red (.bad).
function setTestStatus(ok, text) {
  const el = $('testConnStatus');
  el.textContent = text;
  if (ok) { el.classList.add('ok'); el.classList.remove('bad'); }
  else     { el.classList.remove('ok'); el.classList.add('bad'); }
}

// Minimal live probe of the CURRENT (possibly-unsaved) credentials in the Settings
// controls. Tests the key + model before the user taps Save, so a friend can confirm
// "my key works" without a terminal. Reads LIVE control values — NOT localStorage.
async function testConnection() {
  const btn = $('testConnBtn');
  const key      = $('apiKey').value.trim();
  const openaiKey = $('openaiKey').value.trim();
  const proxyUrl  = $('proxyUrl').value.trim();
  const model     = readModelFromControls();
  const useOpenAI = isOpenAIModel(model);

  btn.disabled = true;
  setTestStatus(false, 'Testing…');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    if (useOpenAI) {
      // GPT path — must go through the proxy.
      if (!openaiKey) { setTestStatus(false, 'Add your OpenAI API key first.'); return; }
      if (!proxyUrl)  { setTestStatus(false, "Add your Proxy URL first (or tap 'Use the shared circle proxy' below)."); return; }
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openai-key': openaiKey },
        body: JSON.stringify({ model, system: '', userText: 'hi', imagesB64: [] }),
        signal: controller.signal,
      });
      let json = {};
      try { json = await res.json(); } catch { /* ignore parse error — use status */ }
      if (res.ok) {
        setTestStatus(true, '✓ GPT proxy + key work — you\'re ready to generate.');
      } else {
        const msg = (json.error && json.error.message) || '';
        setTestStatus(false, friendlyError(res.status, '', msg, 'openai'));
      }
    } else {
      // Claude path — browser-direct to Anthropic.
      if (!key) { setTestStatus(false, 'Add your Anthropic API key first.'); return; }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      });
      let json = {};
      try { json = await res.json(); } catch { /* ignore parse error — use status */ }
      if (res.ok) {
        setTestStatus(true, '✓ Claude key works — you\'re ready to generate.');
      } else {
        const type = (json.error && json.error.type) || '';
        const msg  = (json.error && json.error.message) || '';
        setTestStatus(false, friendlyError(res.status, type, msg, 'anthropic'));
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      setTestStatus(false, 'Test timed out (20s). Check your connection and try again.');
    } else {
      setTestStatus(false, 'Connection error: ' + (err.message || err));
    }
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
}

// Fill the Proxy URL field with the circle's shared proxy URL. Opt-in only —
// the user still taps "Save & done" to persist, consistent with the rest of Settings.
function useSharedProxy() {
  $('proxyUrl').value = SHARED_PROXY_URL;
}

/* ===================== invite a friend (v33) ===================== */

// Sets #inviteStatus text + .ok/.bad class (mirror of setTestStatus/setBuildStatus).
function setInviteStatus(ok, text) {
  const el = $('inviteStatus');
  if (!el) return;
  el.textContent = text;
  if (ok) { el.classList.add('ok'); el.classList.remove('bad'); }
  else     { el.classList.remove('ok'); el.classList.add('bad'); }
}

// Share the app with a friend. Uses the Web Share Sheet (navigator.share) so iOS
// hands off to Messages/Signal/etc.; falls back to copying the link. Shares the
// app's OWN origin URL (location.origin + pathname) rather than a hardcoded URL,
// so it works from any deploy origin and never embeds a literal account name.
// Carries NO personal data — just the public link + a neutral one-liner. The bare
// root URL drops the new friend into the first-run modal → setup guide.
async function inviteFriend() {
  const url = location.origin + location.pathname;
  const text = 'Try Unicorn Pocket: screenshot a chat, pick a tone, get 3 copy-paste replies. Opens a 3-minute setup guide.';
  const shareData = { title: 'Unicorn Pocket', text, url };
  // Prefer the native share sheet when it can share this payload.
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    try {
      await navigator.share(shareData);
      setInviteStatus(true, 'Invite shared.');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user canceled — not an error
      // any other share failure falls through to the clipboard path
    }
  }
  // Fallback: copy the link so the user can paste it into any chat app.
  try {
    await navigator.clipboard.writeText(url);
    setInviteStatus(true, 'Link copied — paste it to a friend: ' + url);
  } catch {
    setInviteStatus(false, 'Copy this link to invite a friend: ' + url);
  }
}

/* ===================== in-app voice derivation (P3, v27) ===================== */
// Privacy contract: the corpus text lives ONLY in #buildCorpus (textarea) and
// the single transient API request. It is NEVER written to localStorage or
// IndexedDB. Only the DERIVED pack (abstract voice instructions) is persisted,
// via the existing validated path in localStorage.

// Mirror of setTestStatus — sets #buildStatus text + .ok/.bad class.
function setBuildStatus(ok, text) {
  const el = $('buildStatus');
  el.textContent = text;
  if (ok) { el.classList.add('ok'); el.classList.remove('bad'); }
  else     { el.classList.remove('ok'); el.classList.add('bad'); }
}

// Toggle the collapsible build panel open/closed.
function toggleBuildPanel() {
  const panel = $('buildPanel');
  if (panel.classList.contains('hidden')) { show(panel); } else { hide(panel); }
}

// Make one text-only API call (Claude or GPT) with the corpus + TRANSFORM_PROMPT,
// parse the returned JSON, and show a preview. Never writes the corpus anywhere.
// Hardening: cap the corpus sent to the model. A voice description needs at most a
// few thousand representative messages; pasting a whole export just burns the user's
// own API budget on input tokens for no quality gain. Over the cap, confirm before
// truncating so the cost decision is the user's, not a silent surprise.
const MAX_CORPUS_CHARS = 80000; // ~20K tokens — ample for a voice description

async function deriveVoicePack() {
  const corpus = $('buildCorpus').value.trim();
  if (!corpus) { setBuildStatus(false, 'Paste your sent messages first.'); return; }

  let corpusToSend = corpus;
  if (corpus.length > MAX_CORPUS_CHARS) {
    const proceed = window.confirm(
      `Your corpus is large (${corpus.length.toLocaleString()} characters). Building will use the ` +
      `first ${MAX_CORPUS_CHARS.toLocaleString()} to keep your API cost down — that's plenty for a ` +
      `voice description. Continue?`
    );
    if (!proceed) { setBuildStatus(false, 'Build canceled. Trim your corpus, then tap Build again.'); return; }
    corpusToSend = corpus.slice(0, MAX_CORPUS_CHARS);
  }

  // Read LIVE credentials (same pattern as testConnection).
  const key        = $('apiKey').value.trim();
  const openaiKey  = $('openaiKey').value.trim();
  const proxyUrl   = $('proxyUrl').value.trim();
  const model      = readModelFromControls();
  const useOpenAI  = isOpenAIModel(model);

  if (useOpenAI) {
    if (!openaiKey) { setBuildStatus(false, 'Add your OpenAI API key in Settings first.'); return; }
    if (!proxyUrl)  { setBuildStatus(false, 'Add your Proxy URL in Settings first.'); return; }
  } else {
    if (!key) { setBuildStatus(false, 'Add your Anthropic API key in Settings first.'); return; }
  }

  const btn = $('buildVoiceBtn');
  btn.disabled = true;
  setBuildStatus(false, 'Building your voice… (one moment)');

  // 90s abort — derivation is a large generation (several thousand output tokens).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    let rawText;

    if (useOpenAI) {
      // GPT path: POST to the user's proxy with the corpus as userText.
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openai-key': openaiKey },
        body: JSON.stringify({
          model,
          system: VoiceBuild.TRANSFORM_PROMPT,
          userText: 'Here is my corpus of sent messages:\n\n' + corpusToSend,
          imagesB64: [],
        }),
        signal: controller.signal,
      });
      let json;
      try { json = await res.json(); } catch { throw new Error(`HTTP ${res.status} — could not parse proxy response.`); }
      if (!res.ok) {
        const msg = (json && json.error && json.error.message) || JSON.stringify(json);
        throw new Error(friendlyError(res.status, '', msg, 'openai'));
      }
      if (typeof json.text !== 'string' || !json.text) throw new Error('No text content in proxy response.');
      rawText = json.text;
    } else {
      // Claude path: browser-direct to Anthropic, text-only (no images).
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          // 8192 (a ceiling, not a charge) so a verbose pack — base_voice up to
          // 1000 words + 7 mode sections up to 200 words each — never truncates
          // mid-JSON, which would fail parseDerivedPack and force a needless retry.
          max_tokens: 8192,
          system: [{ type: 'text', text: VoiceBuild.TRANSFORM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'Here is my corpus of sent messages:\n\n' + corpusToSend }],
        }),
        signal: controller.signal,
      });
      let json;
      try { json = await res.json(); } catch { throw new Error(`HTTP ${res.status} — could not parse response.`); }
      if (!res.ok) {
        const type = (json && json.error && json.error.type) || '';
        const msg  = (json && json.error && json.error.message) || JSON.stringify(json);
        throw new Error(friendlyError(res.status, type, msg, 'anthropic'));
      }
      const block = json.content && json.content.find((c) => c.type === 'text');
      if (!block) throw new Error('No text content in response.');
      rawText = block.text;
    }

    // Parse and validate the returned JSON.
    const result = VoiceBuild.parseDerivedPack(rawText);
    if (!result.ok) {
      setBuildStatus(false, result.error);
      return;
    }

    // Stash for install; show preview.
    pendingBuiltPack = result.pack;
    const modeKeys = Object.keys(result.pack.modes);
    $('buildPreviewSummary').textContent =
      'Built a voice: base voice ' + result.pack.base_voice.length + ' chars, ' +
      modeKeys.length + ' mode section' + (modeKeys.length === 1 ? '' : 's') +
      ' (' + modeKeys.join(', ') + '). Read it over, then install.';
    show($('buildPreview'));
    setBuildStatus(true, '✓ Voice built — preview below.');

  } catch (err) {
    if (err && err.name === 'AbortError') {
      setBuildStatus(false, 'Building timed out (90s). Try again, or use a shorter corpus.');
    } else {
      const raw = err.message || String(err);
      const m = /failed to fetch|load failed|networkerror|network request/i.test(raw)
        ? 'Network error. Check your connection and try again.'
        : raw;
      setBuildStatus(false, m);
    }
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
}

// Install the previewed pack into localStorage via the existing validated path,
// then clean up — clear the corpus textarea (privacy: don't leave it around)
// and reset all build UI state.
function installBuiltPack() {
  if (!pendingBuiltPack) { setBuildStatus(false, 'Nothing to install — tap Build first.'); return; }
  localStorage.setItem(LS_PACK, JSON.stringify(pendingBuiltPack));
  refreshPackStatus();
  // Privacy: clear the corpus now that the pack is installed.
  $('buildCorpus').value = '';
  pendingBuiltPack = null;
  hide($('buildPreview'));
  hide($('buildPanel'));
  setBuildStatus(true, '✓ Your voice is installed.');
}

// Discard a built-but-not-installed pack. Clears the corpus (privacy) and
// resets all build UI state without writing anything to localStorage.
function discardBuiltPack() {
  pendingBuiltPack = null;
  $('buildCorpus').value = '';
  hide($('buildPreview'));
  $('buildPreviewSummary').textContent = '';
  setBuildStatus(false, '');
}

/* ===================== voice tune loop (v40, C3) ===================== */
// One-API-call tune: user types what feels off → model returns a corrective
// instruction → instruction is previewed → user taps Apply → appended to their
// installed pack's base_voice via VoiceBuild.applyCorrection (PURE, cumulative).
// Privacy: no corpus, no screenshots — the gripe text is ephemeral in the
// textarea and the single transient API call. Only the derived correction
// (plain English instruction) reaches localStorage via the existing validated path.

// Mirror of setBuildStatus — sets #tuneStatus text + .ok/.bad class.
function setTuneStatus(ok, text) {
  const el = $('tuneStatus');
  if (!el) return;
  el.textContent = text;
  if (ok) { el.classList.add('ok'); el.classList.remove('bad'); }
  else     { el.classList.remove('ok'); el.classList.add('bad'); }
}

// tuneVoice() — main entry point wired to #tuneVoiceBtn.
// Reads the gripe from #tuneGripe, validates credentials + installed pack, makes
// ONE text-only API call (Claude browser-direct or OpenAI via proxy), then shows
// a preview and reveals Apply/Cancel buttons. Does NOT auto-install.
async function tuneVoice() {
  const gripe = ($('tuneGripe').value || '').trim();
  if (!gripe) { setTuneStatus(false, 'Tell me what\'s off first.'); return; }

  const pack = getPack();
  if (!packIsValid(pack)) { setTuneStatus(false, 'Install or build a voice first.'); return; }

  // Credential guards — same routing logic as onGenerate/deriveVoicePack.
  const key       = getKey();
  const openaiKey = getOpenAIKey();
  const proxyUrl  = getProxyUrl();
  const model     = getModel();
  const useOpenAI = isOpenAIModel(model);

  if (useOpenAI) {
    if (!openaiKey) { setTuneStatus(false, 'Add your OpenAI API key in Settings first.'); return; }
    if (!proxyUrl)  { setTuneStatus(false, 'Add your Proxy URL in Settings first.'); return; }
  } else {
    if (!key) { setTuneStatus(false, 'Add your Anthropic API key in Settings first.'); return; }
  }

  const btn = $('tuneVoiceBtn');
  btn.disabled = true;
  hide($('tunePreview'));
  pendingCorrection = null;
  setTuneStatus(false, 'Tuning… (one moment)');

  // 60s abort — same pattern as deriveVoicePack / onGenerate.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  const userText = VoiceBuild.buildTuneUserPrompt(gripe, '');

  try {
    let instruction;

    if (useOpenAI) {
      // OpenAI path — POST to the user's proxy; same shape as deriveVoicePack.
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openai-key': openaiKey },
        body: JSON.stringify({
          model,
          system: VoiceBuild.TUNE_SYSTEM_PROMPT,
          userText,
          imagesB64: [],
        }),
        signal: controller.signal,
      });
      let json;
      try { json = await res.json(); } catch { throw new Error(`HTTP ${res.status} — could not parse proxy response.`); }
      if (!res.ok) {
        const msg = (json && json.error && json.error.message) || JSON.stringify(json);
        throw new Error(friendlyError(res.status, '', msg, 'openai'));
      }
      if (typeof json.text !== 'string' || !json.text) throw new Error('No text content in proxy response.');
      instruction = json.text.trim();
    } else {
      // Claude path — browser-direct to Anthropic, text-only (no images).
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 256, // 1-3 sentences is well under 256 tokens
          system: [{ type: 'text', text: VoiceBuild.TUNE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userText }],
        }),
        signal: controller.signal,
      });
      let json;
      try { json = await res.json(); } catch { throw new Error(`HTTP ${res.status} — could not parse response.`); }
      if (!res.ok) {
        const type = (json && json.error && json.error.type) || '';
        const msg  = (json && json.error && json.error.message) || JSON.stringify(json);
        throw new Error(friendlyError(res.status, type, msg, 'anthropic'));
      }
      const block = json.content && json.content.find((c) => c.type === 'text');
      if (!block) throw new Error('No text content in response.');
      instruction = block.text.trim();
    }

    if (!instruction) { setTuneStatus(false, 'Model returned an empty instruction. Try again.'); return; }

    // Stash the instruction and show the preview. The user must tap Apply to install.
    pendingCorrection = instruction;
    $('tunePreviewText').textContent = 'Add this to your voice: "' + instruction + '"';
    show($('tunePreview'));
    setTuneStatus(false, ''); // clear spinner text; preview is the signal

  } catch (err) {
    if (err && err.name === 'AbortError') {
      setTuneStatus(false, 'Tuning timed out (60s). Check your connection and try again.');
    } else {
      const raw = err.message || String(err);
      const m = /failed to fetch|load failed|networkerror|network request/i.test(raw)
        ? 'Network error. Check your connection and try again.'
        : raw;
      setTuneStatus(false, m);
    }
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
}

// applyTune() — wired to #tuneApplyBtn. Applies pendingCorrection to the
// installed pack via VoiceBuild.applyCorrection (PURE), validates the result,
// and installs it. On any validation failure: shows error, does NOT install.
function applyTune() {
  if (!pendingCorrection) { setTuneStatus(false, 'Nothing to apply — tap "Tune my voice" first.'); return; }
  const pack = getPack();
  if (!packIsValid(pack)) { setTuneStatus(false, 'No valid voice pack to update.'); return; }

  const updated = VoiceBuild.applyCorrection(pack, pendingCorrection);
  const result = validateVoicePack(JSON.stringify(updated));
  if (!result.ok) {
    setTuneStatus(false, 'Could not apply correction: ' + result.error);
    return;
  }
  localStorage.setItem(LS_PACK, JSON.stringify(result.pack));
  refreshPackStatus();

  // Clear state and UI.
  $('tuneGripe').value = '';
  hide($('tunePreview'));
  pendingCorrection = null;
  setTuneStatus(true, '✓ Voice updated.');
}

// cancelTune() — wired to #tuneCancelBtn. Discards the pending correction.
function cancelTune() {
  pendingCorrection = null;
  hide($('tunePreview'));
  setTuneStatus(false, '');
}

/* ===================== voice preview (v43, C9) ===================== */
// Lets the user hear their installed voice against a fixed demo profile
// (text-only, no screenshot) before going live. Uses the SAME certified
// VoiceCore.buildSystemPrompt + parseOptions/sanitizeReply pipeline and
// the SAME transport as onGenerate. Does NOT call recordUsage, sendEvent,
// or History.add — preview is not a real generation.

// Demo profile text. Self-contained: tells the model it's a profile → openers.
const PREVIEW_DEMO =
  'DEMO (no screenshot — this is a sample so I can hear my own voice). Treat the following as a dating-app PROFILE and write 3 OPENERS in my voice, following all the output rules.\n\n' +
  'HER PROFILE:\n' +
  '- Bio: "sunday farmers markets, aggressively bad at chess, will absolutely steal your fries"\n' +
  '- Prompt: "the way to win me over is... a really specific playlist"\n' +
  '- Photo: her holding a giant orange cat that looks deeply unimpressed.';

// Mirror of setBuildStatus — sets #previewStatus text + .ok/.bad class.
function setPreviewStatus(ok, text) {
  const el = $('previewStatus');
  if (!el) return;
  el.textContent = text;
  if (ok) { el.classList.add('ok'); el.classList.remove('bad'); }
  else     { el.classList.remove('ok'); el.classList.add('bad'); }
}

// previewVoice() — wired to #previewVoiceBtn.
// Requires an installed pack + valid credentials. Calls the model with the
// fixed PREVIEW_DEMO user-turn (text-only, imagesB64: []) using the user's
// currently-selected voice mode. Renders results in #previewCard — NOT #results.
async function previewVoice() {
  const pack = getPack();
  if (!packIsValid(pack)) {
    setPreviewStatus(false, 'Install or build a voice first.');
    return;
  }

  // Credential guards — same routing logic as onGenerate / tuneVoice.
  const key       = getKey();
  const openaiKey = getOpenAIKey();
  const proxyUrl  = getProxyUrl();
  const model     = getModel();
  const useOpenAI = isOpenAIModel(model);

  if (useOpenAI) {
    if (!openaiKey) { setPreviewStatus(false, 'Add your OpenAI API key in Settings first.'); return; }
    if (!proxyUrl)  { setPreviewStatus(false, 'Add your Proxy URL in Settings first.'); return; }
  } else {
    if (!key) { setPreviewStatus(false, 'Add your Anthropic API key in Settings first.'); return; }
  }

  const btn = $('previewVoiceBtn');
  const card = $('previewCard');
  btn.disabled = true;
  card.innerHTML = '';
  hide(card);
  setPreviewStatus(false, 'Generating sample openers… (one moment)');

  // Build the system prompt against the user's currently-selected voice mode.
  const system = VoiceCore.buildSystemPrompt(pack, activeModesList());

  try {
    const text = useOpenAI
      ? await callOpenAIViaProxy({ proxyUrl, key: openaiKey, model, system, userText: PREVIEW_DEMO, imagesB64: [] })
      : await callAnthropic({ key, model, system, userText: PREVIEW_DEMO, imagesB64: [] });

    const options = VoiceCore.parseOptions(text).map(VoiceCore.sanitizeReply);

    // Guard: fewer than 2 options = refusal / odd output.
    if (options.length < 2 || options.every((o) => !o.trim())) {
      setPreviewStatus(false, 'No usable sample openers came back. Try again or try a different voice mode.');
      return;
    }

    // Render into #previewCard (NOT #results — clearly a preview surface).
    const modeLabel = state.activeMode || 'LOCAL';
    const head = document.createElement('div');
    head.className = 'preview-head';
    head.textContent = `Sample openers in your voice (${modeLabel}). Not for sending — just so you can hear it.`;
    card.appendChild(head);
    options.forEach((opt) => {
      const line = document.createElement('div');
      line.className = 'preview-sample';
      line.textContent = opt; // XSS discipline: textContent only
      card.appendChild(line);
    });
    show(card);
    setPreviewStatus(true, '✓ Here\'s how your voice sounds. Tune it in Settings if something feels off.');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (err) {
    const raw = err.message || String(err);
    const m = /failed to fetch|load failed|networkerror|network request/i.test(raw)
      ? 'Network error. Check your connection and try again.'
      : raw;
    setPreviewStatus(false, m);
  } finally {
    btn.disabled = false;
  }
}

/* ===================== first-run modal (v17) ===================== */

// Shown when no valid pack is loaded. Lets the user pick the starter pack
// inline, open the build-your-own guide in a new tab, or fall through to
// Settings — instead of dropping them into Settings cold with no orientation.
function showFirstRunModal() { show($('firstRunModal')); }
function hideFirstRunModal() { hide($('firstRunModal')); }

// "Use starter voice" from the modal. Delegates to the existing
// useStarterVoice() (which fetches voicepack.starter.json + writes to
// localStorage + refreshes pack status), then decides where to send the user.
// If the user still has no API key after loading the pack we open Settings;
// otherwise we leave them on Main so they can generate immediately. We mirror
// useStarterVoice's loading-state pattern on the modal button so the tap has
// visible feedback even though the Settings version of the button is hidden.
async function onModalPickStarter() {
  const btn = $('modalUseStarterBtn');
  const orig = btn.textContent;
  btn.textContent = 'Loading…';
  btn.disabled = true;
  try {
    await useStarterVoice();
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
  if (packIsValid(getPack())) {
    hideFirstRunModal();
    if (!getKey()) openSettings();
  }
  // else: useStarterVoice already alerted; leave the modal open so the user
  // can retry or pick a different path.
}

// "Build my own" — opens the bundled guide in a new tab (target=_blank is
// triggered from a direct user gesture so iOS Safari allows it), then falls
// through to Settings so the user can paste / URL-fetch / file-pick their
// pack when they have one.
function onModalPickBuildOwn() {
  hideFirstRunModal();
  window.open('docs/guide.html?doc=voice-pack-from-your-messages', '_blank', 'noopener');
  openSettings();
}

// "Skip" — for the rare user who already has a pack JSON in clipboard or as
// a URL and just wants to get to Settings. No pack is loaded; openSettings
// gives them the existing URL/file/paste fields.
function onModalSkip() {
  hideFirstRunModal();
  openSettings();
}

/* ===================== history ===================== */

function openHistory() {
  // v41: reset filter to "all" on every open so History doesn't re-open on a
  // stale filter from a previous session visit.
  historyFilter = 'all';
  showScreen('screenHistory');
  renderHistory();
}

function closeHistory() {
  showScreen('screenMain');
}

// A muted one-line app-use summary at the top of History — surfaces the device-
// local counters recordUsage() accumulates (transparency: the user sees exactly
// what's being tallied) and nudges Export. Returns null when nothing's happened
// yet so a first-run History screen stays clean.
function renderUsageSummary() {
  const u = readUsage();
  if (!u.attempts) return null;
  const div = document.createElement('div');
  div.className = 'history-usage';
  const parts = [`${u.success || 0} generated`];
  // recordUsage stores the outcome under its own name, so failures live in u.error
  // (singular — the outcome value), not u.errors. The label below pluralizes.
  if (u.error) parts.push(`${u.error} error${u.error === 1 ? '' : 's'}`);
  if (u.refusal) parts.push(`${u.refusal} no-result`);
  const modeCount = u.byMode ? Object.keys(u.byMode).length : 0;
  if (modeCount) parts.push(`${modeCount} voice${modeCount === 1 ? '' : 's'} used`);
  div.textContent = parts.join(' · ') + ' — exporting below helps tune the voice.';
  return div;
}

// T3: dismissible tip card. Show unless the user has already dismissed it.
// Consent note: this tip only points at the existing Export action — it does
// NOT change what gets exported or trigger any data leaving the device.
const LS_HISTORY_TIP = 'unicorn_history_tip_dismissed';

function renderHistoryTip() {
  const tip = $('historyTip');
  const closeBtn = $('historyTipClose');
  if (!tip) return;
  if (localStorage.getItem(LS_HISTORY_TIP)) {
    hide(tip);
    return;
  }
  show(tip);
  if (closeBtn) {
    // Replace listener to avoid accumulating duplicates across re-renders.
    const fresh = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(fresh, closeBtn);
    fresh.addEventListener('click', () => {
      localStorage.setItem(LS_HISTORY_TIP, '1');
      hide(tip);
    });
  }
}

// v41: mode label/emoji map for the insight line.
const MODE_LABELS = {
  TOURIST: '✈️ Tourist',
  KINK:    '🔥 Kink',
  LONG:    '❤️ Long',
  GO:      '⚡️ Go',
  LOCAL:   'your everyday voice',
};

async function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  let entries = [];
  try { entries = await History.listRecent(History.MAX_ENTRIES); } catch { /* IDB unavailable — show empty */ }
  const exportBtn = $('historyExportBtn');
  // Always evaluate tip state regardless of entry count.
  renderHistoryTip();

  // v41: sync filter chip active states with current historyFilter.
  document.querySelectorAll('.history-filter-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === historyFilter);
  });

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No history yet. Your past generations will appear here.';
    list.appendChild(empty);
    hide(exportBtn); // nothing to export
    return;
  }

  // v41: usage summary + insight reflect ALL entries (not the filtered subset).
  const summary = renderUsageSummary();
  if (summary) list.appendChild(summary);

  // v41: insight line — which voice mode lands replies best.
  const insight = renderOutcomeInsight(entries);
  if (insight) list.appendChild(insight);

  // v41: apply the active filter to the rendered entry list only.
  const visible = historyFilter === 'all'
    ? entries
    : entries.filter((e) => e.outcome === historyFilter);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No entries match this filter.';
    list.appendChild(empty);
  } else {
    visible.forEach((entry) => list.appendChild(renderHistoryItem(entry)));
  }
  show(exportBtn);
}

// v41: build the insight element if totalTagged >= 3 and a best mode exists.
// Returns an Element or null. Uses textContent only (no innerHTML of dynamic data).
function renderOutcomeInsight(entries) {
  const { totalTagged, best } = History.summarizeOutcomes(entries);
  if (totalTagged < 3 || !best) return null;
  const label = MODE_LABELS[best.mode] || best.mode;
  const el = document.createElement('div');
  el.className = 'history-insight';
  el.textContent = `Landing best: ${label} — ${best.replied}/${best.total} replied. Lean on what works.`;
  return el;
}

function renderHistoryItem(entry) {
  const item = document.createElement('div');
  item.className = 'history-item';
  item.setAttribute('role', 'button');
  item.tabIndex = 0;

  const thumbs = document.createElement('div');
  thumbs.className = 'history-thumbs';
  (entry.thumbs || []).slice(0, 3).forEach((src) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'screenshot';
    thumbs.appendChild(img);
  });

  const body = document.createElement('div');
  body.className = 'history-body';

  // v16: snippet shows the option the user actually Copy'd (chosenIndex) when
  // we have it. Falls back to options[0] for entries persisted before v15
  // (chosenIndex was added then; older entries just get options[0]). The "✓"
  // marker telegraphs which one stuck — useful when reopening to compare
  // against the others.
  const hasChosen = typeof entry.chosenIndex === 'number';
  const snippetIdx = hasChosen ? entry.chosenIndex : 0;
  const snippet = document.createElement('div');
  snippet.className = 'history-snippet';
  if (hasChosen) {
    const mark = document.createElement('span');
    mark.className = 'history-chosen-mark';
    mark.textContent = '✓ ';
    mark.setAttribute('aria-label', 'Copied');
    snippet.appendChild(mark);
  }
  snippet.appendChild(document.createTextNode(
    (entry.options && entry.options[snippetIdx]) || '(no reply text)'
  ));

  // v16: meta line gets the model id (when known) so it is easy to see which
  // provider generated this entry once GPT routing is live alongside Claude.
  // v37: prepend the outcome status dot when an outcome has been set (💚/🚫/👻)
  // so the result is visible at a glance without opening the card.
  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const tagPart = entry.tags && entry.tags.length ? ' · ' + entry.tags.join(' ') : '';
  const modelPart = entry.model ? ' · ' + entry.model : '';
  const OUTCOME_DOT = { replied: '💚', no_reply: '🚫', ghosted: '👻' };
  const outcomeDot = entry.outcome && OUTCOME_DOT[entry.outcome] ? OUTCOME_DOT[entry.outcome] + ' ' : '';
  meta.textContent = `${outcomeDot}${entry.mode || 'LOCAL'}${tagPart}${modelPart} · ${new Date(entry.ts).toLocaleString()}`;

  body.appendChild(snippet);
  body.appendChild(meta);

  // v16: if the user typed a steering Note for this generation, show a
  // truncated preview under the meta. Recognizing entries by their context
  // is faster than re-reading the reply.
  if (entry.notes) {
    const notes = document.createElement('div');
    notes.className = 'history-notes';
    const trimmed = entry.notes.length > 80
      ? entry.notes.slice(0, 80) + '…'
      : entry.notes;
    notes.textContent = 'note: ' + trimmed;
    body.appendChild(notes);
  }

  // v37: outcome control row — three pill buttons the user taps AFTER they know
  // how the reply landed. Tapping the already-active outcome clears it (toggle).
  // e.stopPropagation() is load-bearing: without it every tap also triggers the
  // card's reopen handler and pushes the user to the Main screen mid-tap.
  // History.updateOutcome() is fire-and-forget (.catch(()=>{}) so IDB errors
  // never surface as unhandled rejections).
  const outcomeRow = document.createElement('div');
  outcomeRow.className = 'history-outcome';
  const OUTCOME_BTNS = [
    { value: 'replied',  emoji: '💚', label: 'She replied' },
    { value: 'no_reply', emoji: '🚫', label: 'No reply'    },
    { value: 'ghosted',  emoji: '👻', label: 'Ghosted'     },
  ];
  // Keep a live ref to the current outcome so toggles update consistently within
  // this item's lifetime without requiring a DB re-read each time.
  let currentOutcome = entry.outcome ?? null;
  const btns = OUTCOME_BTNS.map(({ value, emoji, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'outcome-btn' + (currentOutcome === value ? ' active' : '');
    btn.dataset.outcome = value;
    btn.setAttribute('aria-label', label);
    btn.textContent = emoji;
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // do NOT reopen the card
      // Toggle: tapping the active outcome clears it back to null.
      const next = currentOutcome === value ? null : value;
      currentOutcome = next;
      // Sync active class on all sibling buttons.
      btns.forEach((b) => b.classList.toggle('active', b.dataset.outcome === next));
      // Persist device-locally — fire-and-forget.
      History.updateOutcome(entry.id, next).catch(() => {});
      // Sync the meta dot in this same card without a full re-render.
      const dot = next && OUTCOME_DOT[next] ? OUTCOME_DOT[next] + ' ' : '';
      meta.textContent = `${dot}${entry.mode || 'LOCAL'}${tagPart}${modelPart} · ${new Date(entry.ts).toLocaleString()}`;
    });
    return btn;
  });
  btns.forEach((btn) => outcomeRow.appendChild(btn));
  body.appendChild(outcomeRow);

  const del = document.createElement('button');
  del.className = 'history-del';
  del.type = 'button';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Delete');
  del.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't also trigger reopen
    try { await History.remove(entry.id); } catch {}
    item.remove();
    if (!$('historyList').children.length) renderHistory(); // restore empty state
  });

  const reopen = () => reopenEntry(entry);
  item.addEventListener('click', reopen);
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reopen(); }
  });

  item.appendChild(thumbs);
  item.appendChild(body);
  item.appendChild(del);
  return item;
}

// Reopen a past generation onto the Main screen: re-stage its screenshots (so the
// user can add another and regenerate — the "use it as memory" path) and show its
// past replies. file is null because we only kept the resized dataURL, which is
// all that both the thumbnail render and the resize-before-send path read.
function reopenEntry(entry) {
  state.files = (entry.thumbs || []).map((dataUrl) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file: null,
    dataUrl,
  }));
  state.activeMode = entry.mode || null;
  state.activeTags = new Set(entry.tags || []);
  state.lastRefine = null; // v36: a reopened entry is not a refine — neutral indicator
  // Track the reopened entry as the chosenIndex target: a subsequent Copy on one
  // of its replies must mark THIS entry, not whatever was last generated. Without
  // this, copyText's History.updateChosen(state.lastHistoryEntryId, …) wrote the
  // pick to the last-generated row — or nowhere, if nothing was generated this
  // session (id stays null) — silently corrupting the per-voice chosenIndex
  // signal a later session mines. (v19 fix)
  state.lastHistoryEntryId = entry.id;
  syncModeButtons();
  closeHistory();
  renderThumbs();
  if (entry.options && entry.options.length) {
    renderResults(entry.options);
    // Show the "from history" affordance so fresh generation isn't mistaken for
    // a stale reopen. renderResults() clears this badge; it's set here AFTER the
    // call so the user always sees it when results come from history.
    // textContent only — never innerHTML of entry-derived strings (XSS discipline).
    const badge = $('historyBadge');
    const dateStr = entry.ts ? new Date(entry.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    badge.textContent = dateStr ? 'from history · ' + dateStr : 'from history';
    show(badge);
  }
}

// Export the whole history store as JSON. iOS: prefers the Web Share Sheet
// (Safari 15+ supports file sharing via navigator.share), so the user can send
// it to themselves / save to Files / AirDrop without leaving the PWA. Fallback:
// synthesize a download <a> click for older browsers. The payload INCLUDES the
// resized JPEG dataURLs and the reply text — sensitive enough that a confirm
// prompt sets expectations before the share sheet appears.
async function exportHistory() {
  const btn = $('historyExportBtn');
  let entries = [];
  try { entries = await History.exportAll(); } catch {}
  if (!entries.length) {
    alert('No history yet to export.');
    return;
  }
  if (!window.confirm(`Export ${entries.length} generation${entries.length === 1 ? '' : 's'}? The file includes your screenshot thumbnails, the reply options, and anonymous usage counts — share only where you trust the destination.`)) {
    return;
  }
  const orig = btn.textContent;
  btn.textContent = 'Preparing…';
  btn.disabled = true;
  try {
    const payload = {
      // v2: entries now carry appVersion, and a device-local app-use `usage`
      // summary (attempts/success/errors/by model+mode) rides along. Additive —
      // a v1 reader can ignore the extra fields.
      schema: 'unicorn-pocket-history-v2',
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      count: entries.length,
      usage: readUsage(),
      entries,
    };
    const json = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `unicorn-pocket-history-${stamp}.json`;
    const blob = new Blob([json], { type: 'application/json' });
    // Web Share Level 2 (files): iOS Safari 15+, modern Chrome. canShare guards
    // browsers that don't support file sharing — fall through to download then.
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: 'Unicorn Pocket history' });
        return;
      } catch (err) {
        // User canceled — don't double-download. Other share failures fall through.
        if (err && err.name === 'AbortError') return;
      }
    }
    // Fallback: synthesize an <a download> click + revoke the URL shortly after.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('Could not export: ' + (e.message || e));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

/* ===================== Add-to-Home-Screen hint (P5, v24) ===================== */
// Shows ONCE when the app is running in browser (not installed standalone). On iOS
// Safari, navigator.standalone is true once installed; on other browsers
// (display-mode: standalone) catches the installed PWA state. Both gates must be
// false for the hint to be eligible. Dismissal is remembered in localStorage so
// it never nags after the user taps ✕.

const LS_A2HS_DISMISSED = 'unicorn.a2hsDismissed';

function isRunningStandalone() {
  // iOS Safari: navigator.standalone is true when launched from Home Screen.
  if (typeof navigator.standalone === 'boolean') return navigator.standalone;
  // All other browsers: use display-mode media query (spec-compliant).
  return window.matchMedia('(display-mode: standalone)').matches;
}

function maybeShowA2hsBanner() {
  // Don't show if: (a) already installed/standalone, (b) previously dismissed.
  if (isRunningStandalone()) return;
  if (localStorage.getItem(LS_A2HS_DISMISSED)) return;
  show($('a2hsBanner'));
}

function dismissA2hsBanner() {
  hide($('a2hsBanner'));
  try { localStorage.setItem(LS_A2HS_DISMISSED, '1'); } catch { /* best-effort */ }
}

/* ===================== wiring ===================== */

function init() {
  // v38: restore last-used voice mode + tags BEFORE wireModePicker so state is
  // set before click listeners attach; then syncModeButtons so the picker reflects
  // the restored selection immediately on load.
  restoreLastVoice();
  wireModePicker();
  syncModeButtons(); // reflect any restored mode/tags into the button styling

  // Surface the app version in Settings — testers can report it ("I'm on v28")
  // and the setup-guide footer ("current version shown in-app") points here.
  const verEl = $('appVersionLabel');
  if (verEl) verEl.textContent = 'Unicorn Pocket ' + APP_VERSION;

  $('fileInput').addEventListener('change', (e) => {
    onFilesPicked(e.target.files);
    e.target.value = ''; // allow re-picking the same file
  });
  $('pasteBtn').addEventListener('click', onPasteClick);
  document.addEventListener('paste', onDocumentPaste);
  $('generateBtn').addEventListener('click', () => onGenerate());
  $('readRoomBtn').addEventListener('click', readTheRoom); // v39: strategic read
  $('startOverBtn').addEventListener('click', resetForNextProfile);

  // v32: refine loop — "New options" regenerates with the same screenshot +
  // mode + notes (fresh sampling, no nudge); each refine chip regenerates with
  // its tone nudge (data-refine) appended to the user-turn instruction.
  $('regenBtn').addEventListener('click', () => onGenerate());
  document.querySelectorAll('.refine-chip').forEach((chip) => {
    chip.addEventListener('click', () => onGenerate(chip.dataset.refine));
  });

  $('navSettings').addEventListener('click', openSettings);
  $('backBtn').addEventListener('click', closeSettings);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('modelSelect').addEventListener('change', syncModelInputVisibility);
  $('savePackBtn').addEventListener('click', savePastedPack);
  $('loadUrlBtn').addEventListener('click', loadPackFromUrl);
  $('packFile').addEventListener('change', loadPackFromFile);
  $('setupBanner').addEventListener('click', openSettings);

  $('navHistory').addEventListener('click', openHistory);
  $('historyBackBtn').addEventListener('click', closeHistory);
  $('historyExportBtn').addEventListener('click', exportHistory);

  // v41: outcome filter chips. Click sets historyFilter and re-renders the list.
  document.querySelectorAll('.history-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      historyFilter = chip.dataset.filter || 'all';
      renderHistory();
    });
  });

  $('historyClearBtn').addEventListener('click', async () => {
    if (!window.confirm('Clear all saved history on this device?')) return;
    try { await History.clear(); } catch {}
    renderHistory();
  });
  $('useStarterBtn').addEventListener('click', useStarterVoice);

  // v25: test connection + shared proxy opt-in.
  $('testConnBtn').addEventListener('click', testConnection);
  $('useSharedProxyBtn').addEventListener('click', useSharedProxy);

  // v33: invite a friend (Web Share + clipboard fallback).
  $('inviteFriendBtn').addEventListener('click', inviteFriend);

  // v29: P4 events-consent toggle. Default OFF (fail-closed). Persists immediately
  // on change so the user doesn't have to tap "Save & done" for consent decisions.
  const evToggle = $('eventsConsentToggle');
  if (evToggle) {
    evToggle.addEventListener('change', () => {
      localStorage.setItem(LS_EVENTS_CONSENT, evToggle.checked ? 'on' : 'off');
    });
  }

  // v27: in-app voice derivation (P3).
  $('buildToggleBtn').addEventListener('click', toggleBuildPanel);
  $('buildVoiceBtn').addEventListener('click', deriveVoicePack);
  $('buildInstallBtn').addEventListener('click', installBuiltPack);
  $('buildDiscardBtn').addEventListener('click', discardBuiltPack);

  // v40: voice tune loop (C3).
  $('tuneVoiceBtn').addEventListener('click', tuneVoice);
  $('tuneApplyBtn').addEventListener('click', applyTune);
  $('tuneCancelBtn').addEventListener('click', cancelTune);

  // v43: voice preview (C9).
  $('previewVoiceBtn').addEventListener('click', previewVoice);

  // v17: first-run modal — orient before dumping the user into Settings.
  $('modalUseStarterBtn').addEventListener('click', onModalPickStarter);
  $('modalBuildBtn').addEventListener('click', onModalPickBuildOwn);
  $('modalSkipBtn').addEventListener('click', onModalSkip);
  // v18: a11y — tap-outside-the-card (on the dimmed overlay) AND Escape both
  // dismiss the modal to Settings (same behaviour as the explicit Skip button).
  // iPhone testers tap outside popups expecting them to close; without this
  // the modal felt frozen on accidental over-taps.
  $('firstRunModal').addEventListener('click', (e) => {
    if (e.target === $('firstRunModal')) onModalSkip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('firstRunModal').classList.contains('hidden')) {
      onModalSkip();
    }
  });

  refreshSetupBanner();

  // v17: First-run flow — if there is no valid pack, show the starter/build
  // modal (regardless of API-key state; the modal's branches handle the
  // pack-loaded-but-key-missing follow-up). If pack is present but key is
  // missing, fall back to the pre-v17 behaviour of opening Settings directly.
  if (!packIsValid(getPack())) {
    showFirstRunModal();
  } else if (!getKey()) {
    openSettings();
  }

  // v24: A2HS hint — show after the first-run gate so the hint doesn't stack
  // on top of the first-run modal. It's a soft affordance and can wait.
  $('a2hsClose').addEventListener('click', dismissA2hsBanner);
  maybeShowA2hsBanner();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
