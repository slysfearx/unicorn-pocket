// voice-core.js — pure voice-composition logic shared by the browser PWA
// (app.js) and the Node eval harness (eval/). SINGLE SOURCE OF TRUTH so the
// eval grades the EXACT system prompt + parse the app produces. No DOM, no
// Node-specific APIs in here — keep it portable.
//
// Mirrors the legacy server the legacy service._build_system_prompt + _parse_options
// (verified against the-legacy-repo:server/app/services/the legacy service.py).
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (eval harness)
  } else {
    root.VoiceCore = api; // browser (app.js reads window.VoiceCore)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // iOS / tag mode names -> voice-pack keys. Mirrors legacy MODE_FILES exactly:
  //   LOCAL->mode_local, TRAVEL/TOURIST->mode_travel, GO->mode_go,
  //   KINK->tag_kink, LONG->tag_chill, #10->tag_10, #kink->tag_kink,
  //   #chill->tag_chill, #re->tag_re
  const MODE_KEYS = {
    LOCAL: 'mode_local',
    TRAVEL: 'mode_travel',
    TOURIST: 'mode_travel',
    GO: 'mode_go',
    KINK: 'tag_kink',
    LONG: 'tag_chill',
    '#10': 'tag_10',
    '#kink': 'tag_kink',
    '#chill': 'tag_chill',
    '#re': 'tag_re',
  };

  // Non-negotiable output rules appended to EVERY system prompt. Derived from
  // the eval (mode-structure adherence + emotional-register matching the judge
  // flagged) + the user's documented no-em-dash rule. Placed LAST for recency
  // salience so it overrides the noisy 18KB base_voice (which itself contains
  // many "--").
  const HARD_RULES = `

---

# NON-NEGOTIABLE OUTPUT RULES (these override everything above)
1. Output EXACTLY 3 options, numbered "1." "2." "3." — each a complete, copy-paste-ready message. No labels, no placeholders, no commentary, no preamble.
2. Obey the ACTIVE MODE's option structure exactly. If the mode assigns distinct roles across the 3 options (e.g. observation / question / personal-share), follow that structure.
3. Match the conversation's emotional register. If she is being vulnerable or serious, meet it with warmth and specific recall of what she shared, never deflect with jokes or generic banter.
4. Never use em dashes, en dashes, or double hyphens ("—", "–", "--"). Use commas, periods, or parentheses instead.
5. Sound like a specific real person texting, never like an AI assistant.`;

  // The user-turn instruction sent alongside the screenshot(s). SINGLE SOURCE OF
  // TRUTH for both the app (app.js callAnthropic) and the eval (run-eval.js), so
  // the eval grades the EXACT user prompt the app sends — not a drifted copy.
  // (This closes the same divergence class as HARD_RULES: see the app.js/eval
  // unification fix.)
  const USER_PROMPT =
    'Read the screenshot, then decide what it is:\n' +
    '- A PROFILE (bio / prompts / photos, no chat yet) -> write 3 OPENERS. Each opener MUST be short (one or two sentences) and END with a simple, specific, easy-to-answer question.\n' +
    '- A CONVERSATION (existing messages) -> write 3 REPLIES to her MOST RECENT message, continuing the thread naturally.\n' +
    'Reference at least one SPECIFIC thing you actually see (a word she used, a prompt answer, a photo detail). Never generic, never interchangeable with another match.\n' +
    'Use the active voice/mode for tone and intent. Output EXACTLY 3 options, numbered "1." "2." "3.", each copy-paste ready.';

  // _build_system_prompt(modes) — verbatim port of the legacy logic, plus the
  // HARD_RULES footer (eval-driven enhancement).
  function buildSystemPrompt(pack, modes) {
    const base = (pack && pack.base_voice) || '';

    // Default to LOCAL mode if none specified.
    if (!modes || modes.length === 0) {
      modes = ['LOCAL'];
    }

    const modeSections = [];
    for (const mode of modes) {
      const key = MODE_KEYS[mode];
      if (key) {
        const content = (pack && pack.modes && pack.modes[key]) || '';
        if (content) modeSections.push(content);
      }
    }

    // No mode sections (e.g. unknown mode names) -> base voice + hard rules.
    if (modeSections.length === 0) return base + HARD_RULES;

    // PUT MODE INSTRUCTIONS FIRST — they take priority over base voice.
    const modeText = modeSections.join('\n\n---\n\n');
    const priorityHeader =
`# PRIORITY: ACTIVE MODE REQUIREMENTS

The following mode(s) are ACTIVE: ${modes.join(', ')}

**YOU MUST follow the mode requirements below. They override default behavior.**

${modeText}

---

# REFERENCE MATERIAL (use for voice/style, but mode requirements take priority)

`;
    return priorityHeader + base + HARD_RULES;
  }

  // _parse_options(response_text) — verbatim port.
  // Bold numbering "**1.**" and paren "1)" are handled (P17). Multi-line option
  // bodies are now handled too: a numbered option's text is captured up to the
  // NEXT marker (or end), so a reply that wraps across lines keeps its full
  // body instead of being silently truncated to its first physical line — the
  // earlier /(.+)$/gm bug. See eval/parseoptions.test.js. app.js guards <2.
  function parseOptions(responseText) {
    // Numbered format: "1. text" / "2) text" / "**1.** text" (bold + paren tolerated).
    // Un-bold a bolded number prefix first ("**1.**" -> "1.") so it parses; the
    // bare /^\d+\./ used to miss bold/paren lists and collapse to one option.
    const norm = responseText.replace(/^\s*\*\*\s*(\d+\s*[.)])\s*\*\*/gm, '$1');

    // Locate each line-start numbered marker, then slice each option's body from
    // just after its marker to the start of the next marker (or end-of-text).
    // This captures wrapped continuation lines instead of the first line only.
    const markerRe = /^\s*\d+[.)]\s*/gm;
    const marks = [];
    let mm;
    while ((mm = markerRe.exec(norm)) !== null) {
      marks.push({ start: mm.index, bodyStart: mm.index + mm[0].length });
      if (markerRe.lastIndex === mm.index) markerRe.lastIndex++; // zero-width guard
    }

    if (marks.length >= 2) {
      const options = [];
      for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].start : norm.length;
        const body = norm.slice(marks[i].bodyStart, end);
        // Collapse internal line breaks (wrapped lines) into single spaces so a
        // multi-line option becomes one copy-paste-ready message; trim; strip
        // a single pair of wrapping quotes.
        const cleaned = body.replace(/\s*\n\s*/g, ' ').trim().replace(/^["']|["']$/g, '');
        options.push(cleaned);
      }
      return options.slice(0, 3);
    }

    // Fallback: split by double newline.
    const parts = responseText.split('\n\n').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 3);

    // Last resort: whole response as one option.
    return [responseText.trim()];
  }

  // Deterministic safety net for the user's hard no-dash rule. The model is told
  // not to use em/en dashes, but instruction isn't reliable (the eval caught an
  // en-dash slipping through), so we also strip them post-generation.
  // Em/en dash or double-hyphen used as a pause -> comma.
  function sanitizeReply(text) {
    if (!text) return text;
    return String(text)
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/\s*--\s*/g, ', ')
      .replace(/\s+,/g, ',')
      .replace(/,\s*,/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return { MODE_KEYS, HARD_RULES, USER_PROMPT, buildSystemPrompt, parseOptions, sanitizeReply };
});
