// voicebuild.js — in-app voice-pack derivation from a user's message corpus.
// Pure, portable module: no DOM, no Node-specific APIs. Mirrors voice-core.js's
// UMD wrapper so it loads as window.VoiceBuild in the browser and module.exports
// in Node (eval harness / tests).
//
// Privacy posture: the corpus fed to deriveVoicePack() (in app.js) is NEVER
// written to localStorage or IndexedDB — it lives only in the textarea and the
// single transient API request. Only the DERIVED pack (abstract voice
// instructions) gets persisted, via the existing validated install path.

'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (eval harness / tests)
  } else {
    root.VoiceBuild = api; // browser (app.js reads window.VoiceBuild)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // TRANSFORM_PROMPT — ported verbatim from
  // pocket/docs/voice-pack-from-your-messages.md lines 234-305
  // (blockquote `> ` prefixes stripped; content byte-for-byte identical).
  // This is the system prompt sent to derive a voice pack from a message corpus.
  const TRANSFORM_PROMPT =
`You are going to build a JSON "voice pack" that captures how the user writes when texting people they're dating. The pack will be used by a separate app that generates dating-app reply suggestions in the user's voice.

**The user has attached a corpus of their real sent messages.** Study it carefully. Your output is a JSON object that abstractly describes the user's voice, NOT examples copied from the corpus.

## Output schema

Return EXACTLY this shape, a single JSON object, no commentary before or after:

\`\`\`json
{
  "base_voice": "string, 500 to 1000 words",
  "modes": {
    "mode_local": "string, 80 to 200 words",
    "mode_travel": "string, 80 to 200 words",
    "mode_go": "string, 80 to 200 words",
    "tag_kink": "string, 80 to 200 words",
    "tag_chill": "string, 80 to 200 words",
    "tag_10": "string, 80 to 200 words",
    "tag_re": "string, 80 to 200 words"
  }
}
\`\`\`

## What each field is for

**\`base_voice\` (the big one, 500 to 1000 words).**
A reference document the model reads on every reply. It is NOT a list of example messages. It is a *description* of how the user writes. Cover:

- **Tone fingerprint**: dry / warm / playful / direct / curious / sardonic / etc. Use multiple words, qualify with frequency ("usually dry, sometimes warm when she's being vulnerable").
- **Sentence shape**: average length, how often they use one-word replies, how often they use fragments vs. full sentences, how they handle multi-sentence replies (one block? broken into 2 messages?).
- **Punctuation habits**: do they use periods at the end? Exclamation points? Question marks? Lowercase by default or capitalized? Apostrophes?
- **Vocabulary fingerprint**: words and phrases they actually reach for that are distinctive (note them as a list of representative phrases, NOT verbatim copies of full messages).
- **Opener moves**: how they typically start a conversation with someone new (callback to bio? observation? question? joke? compliment? something else?).
- **Escalation style**: how they move a conversation toward meeting up. Direct ask? Soft suggestion? Wait for her to bring it up?
- **How they handle silence / ghosting / slow replies**: do they double-text? Ignore and wait? Bring it up later?
- **How they handle heavy moments**: if she shares something vulnerable, how do they respond? With matched vulnerability? A specific recall? A joke? Warmth without intrusion?
- **Things they would NEVER say**: every voice has anti-patterns. List 5 to 10 things that would feel actively wrong in their voice (e.g. "never says 'lol'", "never calls anyone 'babe' on the first day", "never opens with a compliment about appearance", "never uses 'circle back'").
- **A note about emoji**: do they use them? Which ones? How often? Same answer for GIFs/reactions if you can tell.

Write \`base_voice\` in second person addressed to the model that will use it ("You write like this:", "You never:", etc.) so the downstream LLM reads it as instructions.

**\`modes.mode_local\` (80 to 200 words).**
Default mode. The user's everyday flirting voice when they're at home, no special context. Describe what shifts (if anything) in this mode versus the base voice. If the corpus shows their default register clearly, describe that. If not, describe what their default should be in spirit.

**\`modes.mode_travel\` (80 to 200 words).**
When the user is visiting somewhere. Time-bounded ("I'm in town until Sunday"), often more direct because of the deadline, often more curious about her city / what she'd recommend. Describe the shift from base voice.

**\`modes.mode_go\` (80 to 200 words).**
Direct, high-energy, "let's actually meet" mode. Cuts the banter, proposes a plan with a specific time or place. Describe what shifts. If you can find examples in the corpus where the user proposed meeting up, use those as a guide for tone (DESCRIBE, don't quote).

**\`modes.tag_kink\` (80 to 200 words).**
Flirty / suggestive, NOT explicit. Playful escalation, double meanings, tension. The kind of thing said to someone the user is already clearly clicking with. Describe what shifts. Find evidence in the corpus of how they flirt and describe THAT register (do not produce explicit content).

**\`modes.tag_chill\` (80 to 200 words).**
Long, low-pressure conversation mode. Warmer, more curious, more willing to follow her lead and ask follow-ups instead of pushing toward a meet. Describe what shifts.

**\`modes.tag_10\` (80 to 200 words).**
Tonight mode. Specifically tuned to "we are going to meet in the next few hours." Quick plan, specific time, low friction, no fluff. Describe what shifts.

**\`modes.tag_re\` (80 to 200 words).**
Re-engage mode. For ghosted threads or conversations that died weeks/months ago. Brings warmth without acting like the gap didn't happen. Acknowledges the gap lightly OR opens with something specific that makes the reach-out feel non-random. Describe what shifts.

## Hard rules

1. **No em dashes (\`—\`), en dashes (\`–\`), or double hyphens (\`--\`)** anywhere in your output. Use commas, periods, or parentheses.
2. **No AI-assistant phrasing** like "I'd be happy to" or "feel free to" or "as you mentioned". Voice packs are written in the user's voice, not the model's.
3. **No generic pickup-artist lines** anywhere ("negging", "push-pull", "DHV", "stack the routine", etc.). The point is sounding like THIS user, not like a template.
4. **Describe patterns, don't copy messages verbatim.** If the corpus has a great line, abstract the move it represents and describe that. Don't paste the line into the pack.
5. **Each mode section should describe what SHIFTS from base voice, not repeat base voice.** Brevity in each mode is good if base voice covers the rest.
6. **Match the register of the source corpus.** If the user texts in lowercase, write the descriptions with examples in lowercase. If they capitalize, capitalize.
7. **Output a single JSON object.** No prose before. No prose after. No code-block fencing. Just the JSON.`;

  // parseDerivedPack(rawText) — robust parser for LLM output that may wrap the
  // JSON in a fenced block or prose. Returns { ok: true, pack } or
  // { ok: false, error: '<human-readable reason>' }.
  //
  // Extraction precedence:
  //   1. Fenced code block (```json ... ``` or ``` ... ```)
  //   2. Prose-wrapped: extract from first { to last }
  //   3. Raw: attempt JSON.parse on the full rawText
  function parseDerivedPack(rawText) {
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      return { ok: false, error: 'The model returned an empty response. Try Build again.' };
    }

    let extracted = null;

    // 1. Fenced block: ```json ... ``` or ``` ... ```
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      extracted = fenceMatch[1].trim();
    }

    // 2. Prose-wrapped: find the first JSON structure start character ([ or {)
    //    and extract from there, so a top-level array is captured as an array
    //    (not silently trimmed to an inner object — which would bypass the
    //    Array.isArray rejection below).
    if (!extracted) {
      const firstBrace  = rawText.indexOf('{');
      const firstBracket = rawText.indexOf('[');
      // Determine whether the outermost structure is an array or object.
      const useArray = firstBracket !== -1 &&
                       (firstBrace === -1 || firstBracket < firstBrace);
      if (useArray) {
        // Array — extract first [ to last ]
        const lastBracket = rawText.lastIndexOf(']');
        if (lastBracket > firstBracket) {
          extracted = rawText.slice(firstBracket, lastBracket + 1);
        }
      } else if (firstBrace !== -1) {
        // Object — extract first { to last }
        const lastBrace = rawText.lastIndexOf('}');
        if (lastBrace > firstBrace) {
          extracted = rawText.slice(firstBrace, lastBrace + 1);
        }
      }
    }

    // 3. Fallback: try the full string as-is
    if (!extracted) {
      extracted = rawText.trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return { ok: false, error: 'The model did not return valid JSON. Try Build again.' };
    }

    // Validate shape — mirrors validateVoicePack() in app.js.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Voice pack must be a JSON object (not an array or scalar).' };
    }
    if (typeof parsed.base_voice !== 'string' || parsed.base_voice.trim() === '') {
      return { ok: false, error: 'Derived pack is missing the required "base_voice" string field.' };
    }
    if (!parsed.modes || typeof parsed.modes !== 'object' || Array.isArray(parsed.modes)) {
      return { ok: false, error: 'Derived pack is missing the required "modes" object field.' };
    }
    if (Object.keys(parsed.modes).length === 0) {
      return { ok: false, error: 'Derived pack "modes" object is empty — at least one mode is required.' };
    }

    return { ok: true, pack: parsed };
  }

  // TUNE_SYSTEM_PROMPT — system prompt for the one-line voice tune call.
  // Instructs the model to convert a user's gripe into a concise corrective
  // instruction (second-person, addressed to the reply-writing model). Must be
  // kept in sync with the brief passed to applyCorrection().
  const TUNE_SYSTEM_PROMPT =
`You refine a dating-app voice pack. The user will tell you what is off about the replies the app writes in their voice. Turn their feedback into ONE concise corrective instruction, 1 to 3 sentences, written in second person addressed to the model that writes the replies (for example: "You never call anyone buddy." or "Keep replies shorter, usually one line." or "Be more sarcastic and less earnest."). Output ONLY that instruction text. No preamble, no quotes, no JSON, no labels. Do not use em dashes, en dashes, or double hyphens.`;

  // buildTuneUserPrompt(gripe, sample) — user-turn message for the tune call.
  // gripe: the user's one-line complaint (required, non-empty).
  // sample: an optional example reply that felt wrong ('' or null to omit).
  function buildTuneUserPrompt(gripe, sample) {
    let msg = 'Here is what is off about my replies: ' + gripe;
    if (sample && typeof sample === 'string' && sample.trim() !== '') {
      msg += '\n\nHere is an example reply that felt wrong: ' + sample;
    }
    msg += '\n\nWrite the one corrective instruction.';
    return msg;
  }

  // TUNE_HEADER — the markdown header that groups all appended corrections
  // under a single, human-readable section in base_voice. Written once; subsequent
  // calls find the existing header and append another bullet below it.
  const TUNE_HEADER = '## Voice corrections (you told me to adjust these)';

  // applyCorrection(pack, instruction) — PURE function. Returns a NEW pack object
  // with the instruction appended as a bullet under TUNE_HEADER in base_voice.
  // Defensive: invalid pack or blank instruction → return pack unchanged (no throw).
  // Strips surrounding quotes and any em/en dash or double-hyphen from the instruction.
  function applyCorrection(pack, instruction) {
    // Defensive: pack must be an object with base_voice as a string.
    if (!pack || typeof pack !== 'object' || typeof pack.base_voice !== 'string') {
      return pack;
    }
    // Defensive: instruction must be a non-empty string after trim.
    if (typeof instruction !== 'string' || instruction.trim() === '') {
      return pack;
    }

    // Strip surrounding double-quotes the model occasionally adds.
    let cleaned = instruction.trim();
    cleaned = cleaned.replace(/^["']|["']$/g, '');
    // Strip em dashes (—), en dashes (–), and double hyphens (--) → comma.
    // Mirrors the no-dash rule in TUNE_SYSTEM_PROMPT and voice-core.sanitizeReply,
    // but inlined here (we must NOT import voice-core.js — it is eval-certified and
    // byte-frozen; importing it would create a circular dependency risk).
    cleaned = cleaned.replace(/—|–|--/g, ',');
    cleaned = cleaned.trim();

    // After cleaning, re-check for emptiness.
    if (cleaned === '') return pack;

    let baseVoice = pack.base_voice;

    // Find the header in base_voice (exact string match).
    const headerIdx = baseVoice.indexOf(TUNE_HEADER);
    if (headerIdx === -1) {
      // Header not present yet — append it (preceded by double newline) + bullet.
      baseVoice = baseVoice + '\n\n' + TUNE_HEADER + '\n- ' + cleaned;
    } else {
      // Header already present — append the new bullet to the END of base_voice.
      // This is correct because the corrections section is ALWAYS the last thing in
      // base_voice: it is only ever created (the if-branch) or extended (here) by
      // this function, both of which append to the end. So a new bullet lands right
      // under the existing ones, stacking cleanly. (master-audit 2026-06-13 LOW-1:
      // comment was previously imprecise; behavior was and is correct.)
      baseVoice = baseVoice + '\n- ' + cleaned;
    }

    // Return a NEW pack object with updated base_voice; all other fields intact.
    return Object.assign({}, pack, { base_voice: baseVoice });
  }

  return { TRANSFORM_PROMPT, parseDerivedPack, TUNE_SYSTEM_PROMPT, buildTuneUserPrompt, applyCorrection };
});
