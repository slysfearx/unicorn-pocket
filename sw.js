// Unicorn Pocket service worker — caches the app shell for instant launch + offline UI.
// API calls to api.anthropic.com are never cached (network-only).

'use strict';

// Bump on every shell change so returning users get the new files (cache-first
// would otherwise serve the stale shell forever). v2: added voice-core.js.
// v3: voice-core.js gained USER_PROMPT; app.js now reads it (must update as a pair).
// v4: app.js guards blank results; voice-core.js documents known parse gaps.
// v5: app.js prompt-caches the system prompt (cost cut; output-neutral).
// v6: app.js friendly errors on bad image / file-read / non-image pick (§6.8 robustness).
// v7: app.js treats <2 reply options as non-usable (refusal/odd output) (§6.8).
// v8: voice-core parseOptions handles bold/paren numbering (**1.**, 1)).
// v9: voice-core parseOptions captures multi-line option bodies (was truncating
//     wrapped replies to the first line). Bug fix only; no behavior added.
// v10: app.js pre-read 10 MB size guard on incoming images (matches server cap).
// v11: paste-from-clipboard input + share_target manifest + one-tap "Start over"
//      (UX build 2026-05-27). index.html/app.js/styles.css/manifest all changed.
// v12: app.js trial-hardening — scroll status/results into view after Generate,
//      60s fetch timeout (AbortController), error text via textContent (2026-05-27).
// v13: removed the share_target manifest entry — it was an unhandled multipart
//      POST to a static host (405/blank if ever invoked), inert on iOS Safari
//      (no Web Share Target support). The real share-in is the native Share
//      Extension on the future native track, not a broken PWA entry point.
// v14: notes field (free-text steering) + short-opener prompt rule + device-local
//      history (history.js, IndexedDB) + optional OpenAI-via-proxy provider.
//      index.html/app.js/styles.css/voice-core.js all changed; history.js added.
// v15: capture-more-on-save (notes/model/chosenIndex on every History.add) +
//      Export history button (Web Share Sheet / download fallback) + Use Starter
//      Voice (one-tap anonymous pack for friend-as-tester onboarding). Adds
//      voicepack.starter.json to SHELL so first-run works offline. app.js /
//      history.js / index.html / sw.js / eval/history.test.js all changed;
//      voicepack.starter.json + docs/voice-pack-from-your-messages.md added.
// v16: surface what v15 captured. History row now shows a "✓" on the option
//      the user Copy'd (chosenIndex), prints the model id in the meta line,
//      and shows a truncated Note preview under it. The build-your-own
//      onboarding guide is bundled into pocket/docs/ so the deployed app
//      can serve it (Settings hint is now a real link). app.js / index.html /
//      styles.css all changed; pocket/docs/voice-pack-from-your-messages.md added.
// v17: first-run modal — instead of dropping the user into Settings cold when
//      no voice pack is loaded, show a small starter/build/skip choice so the
//      "Use starter voice" tap is one click from app open. The Build button
//      opens the bundled onboarding guide in a new tab. index.html (new
//      #firstRunModal element + 3 buttons), app.js (5 modal helpers + first-
//      run branch rewrite), styles.css (.modal-overlay / .modal-card / titles)
//      all changed. No new SHELL files.
// v18: modal a11y — tap-outside-the-card on the dimmed overlay AND the Escape
//      key both dismiss the v17 modal to Settings (same as the explicit Skip
//      button). iPhone testers expect tap-outside-to-close; without this the
//      modal felt frozen on accidental over-taps. app.js init() only — one
//      backdrop-click listener (gated on event.target === overlay so a tap
//      on the card itself doesn't close) + one document keydown listener
//      (gated on modal-not-hidden so Escape only fires while modal is up).
// v19: fix(history) — reopening a past History entry then tapping Copy now marks
//      THAT entry's chosenIndex. reopenEntry never set state.lastHistoryEntryId,
//      so copyText wrote the pick to the last-generated row (or nowhere on a
//      fresh load), silently corrupting the per-voice "what works" signal a later
//      session mines. app.js reopenEntry only; eval/browser-smoke.js gains a
//      reopen→copy→assert-correct-entry regression step. voice-core untouched.
// v20: UX honesty — reopening a History entry now shows a muted "from history ·
//      <date>" badge above the results so a tester can't mistake stale replies for
//      a fresh generation; the badge clears automatically on next Generate.
//      Worker OpenAI max_completion_tokens branch for o-series model ids (dormant
//      until deploy; validated-on-deploy). updateChosen lossy-on-prune guard in
//      history.js: console.debug + inline comment flags that chosenIndex mining
//      must account for rows pruned past MAX_ENTRIES. app.js / styles.css /
//      index.html / worker/src/index.js / history.js all changed.
// v21: app-use telemetry + GPT test hardening. (a) Every History entry + the
//      Export payload now carry the app shell version (APP_VERSION in app.js,
//      kept in sync with this CACHE string) so mined data is version-attributable.
//      (b) New device-local usage counters — attempts/success/errors/refusals +
//      per model / mode / error-kind — folded into Export and surfaced as a muted
//      summary atop History; captures the failure + attempt signal the History
//      store (successes only) misses. PURE COUNTS, no content, never auto-sent.
//      (c) Export schema bumped to -v2. app.js / history.js / styles.css changed.
//      (The GPT proxy o-series fix is now regression-tested in
//      eval/worker-body.test.mjs — worker code lives outside this shell.)
//      Also bundles docs/setup.md (the tester onboarding guide) so it's served
//      at the live URL; pocket/README.md reframed to the tester-ready scope.
// v22: Model is now a SELECTABLE dropdown (Claude Sonnet 4.6 / Opus 4.8, GPT-4o /
//      GPT-4o-mini) + an "Other" option that reveals the free-text input for any
//      custom id — no more typing the model id from memory. APP_VERSION→v22 (kept
//      in sync with this CACHE). Setup guide GPT section simplified for testers
//      (pick a model + paste the maintainer's proxy URL; they don't deploy);
//      worker/README.md gained the first-time-Cloudflare gotchas. app.js /
//      index.html / styles.css changed.
// v23: P1 core-hardening — voice-pack install integrity validator (P1b),
//      error-path completeness with provider-correct messages (P1d),
//      version-sync enforcement test (P1a). app.js changed.
// v24: P5 PWA install polish — Add-to-Home-Screen guided hint (shows once,
//      dismissed to localStorage, hidden when already installed standalone),
//      iOS-specific instructions (Share → Add to Home Screen). index.html /
//      app.js / styles.css changed. Manifest + SW shell already complete.
// v25: P2 onboarding — meta-CSP (script-src 'self' BYO-key hardening, blocks
//      injected-script exfil of localStorage key), in-app Test-connection button
//      (live probe of current Settings credentials, no terminal needed), shared-
//      proxy opt-in toggle (circle's shared Worker URL, explicit tap only, never
//      a silent default). index.html / app.js / styles.css changed.
// v26: guided first-run setup card in Settings (ordered key→model→test steps +
//      console.anthropic.com link, shown only while setup incomplete) +
//      quickstart.md bundled into the offline SHELL. index.html / app.js /
//      styles.css / sw.js changed.
// v27: in-app build-your-own-voice (paste corpus → derive pack via BYO key,
//      device-local, corpus never persisted → preview → install). New
//      voicebuild.js module. index.html / app.js / sw.js changed.
// v28: Run 2.5 pilot-polish — mobile-rendered docs viewer (docs/guide.html +
//      guide.js renderer + guide-boot.js bootstrap; the bootstrap MUST be
//      external because guide.html's CSP `script-src 'self'` blocks inline
//      scripts). All in-app .md links route through it. History Export promoted
//      to primary + dismissible export tip; Settings version label; drift-proof
//      doc version stamp. New docs/guide* added to SHELL. index.html / app.js /
//      styles.css / docs/* changed.
// v29: P4 anonymous usage-events consent — settings toggle (default OFF,
//      unicorn.eventsConsent localStorage key, fail-closed) + fire-and-forget
//      POST to /events on each generation (success + error) when consented.
//      Events-only: voice/model/optionCount/chosenIndex/latencyMs/errorClass/appVersion/ts.
//      NEVER sends screenshots/text/key. v30: chosenIndex-on-Copy (which option won).
// v31: first-run welcome modal surfaces the setup guide (docs/guide.html?doc=setup)
//      so the bare root URL leads a new tester straight to the full walkthrough.
// v32: refine loop + edit-before-copy. Under the 3 results: a refine bar
//      (Shorter / Bolder / Funnier / More curious / Make a move + "New options")
//      that re-generates with a one-line tone nudge appended to the USER-TURN
//      instruction (same steering channel as Notes), and a per-option Edit that
//      makes the reply inline-editable so Copy grabs the tweaked text. The
//      iterate-in-one-tap core loop — turns a one-shot generator into a coach.
//      index.html / app.js / styles.css changed; voice-core.js byte-identical
//      (the certified system prompt is untouched — refine is user-turn only).
// v33: invite-a-friend — Settings card that shares the app's own origin URL via
//      the Web Share Sheet (clipboard-copy fallback). Turns the invite-only
//      circle's manual "send the link" step into one tap; the bare root link
//      lands a new friend in the first-run setup guide. No personal data, nothing
//      stored. index.html / app.js changed. voice-core.js byte-identical.
// v34: mode clarity — Tourist/Kink/Long/Go each carry a one-line descriptor
//      (visiting town / flirty / slow burn / let's meet up) so a new tester
//      picks the right tone on their first try instead of guessing. data-mode
//      keys unchanged → composition identical; pure label clarification.
//      index.html / styles.css changed. voice-core.js byte-identical.
// v35: hardening pass — (worker) public OpenAI proxy gains a 12MB body-size cap +
//      image-array validation (string-filter + count cap), closing the one public
//      route with no size guard; (app) build-your-own-voice corpus is capped at
//      80K chars with a confirm-before-truncate so a giant paste can't silently
//      burn the user's API budget. app.js / worker changed. voice-core.js byte-
//      identical (no composition change).
// v36: refine-applied indicator — after a refine, the refine bar highlights the
//      active nudge chip and the label reads "Refined: <nudge>. Tap another, or
//      'New options' for a fresh set," so the user knows which take they're seeing
//      and how to return to neutral. Pure UI on the flagship refine loop; data-
//      mode/composition untouched. index.html / app.js / styles.css changed.
// v37: outcome loop — History entries gain a device-local outcome (replied/no-reply/ghosted) signal + badge + control; rides Export. history.js/app.js/styles.css changed. No new SHELL files.
// v38: ease polish — (1) 10ms haptic on successful copy (navigator.vibrate, guarded); (2) 3 skeleton ghost cards in #results during generation; (3) voice mode + tags persisted to localStorage across sessions. app.js/styles.css changed.
// v39: "Read the room" — secondary coach-read action (strategic read of the screenshot, separate API call, own prompt in app.js, NOT voice-core). index.html/app.js/styles.css changed. voice-core.js byte-identical.
// v40: voice tune loop — one-API-call voice correction (C3). User types what's off → model returns a corrective instruction → appended to installed pack's base_voice (cumulative). TUNE_SYSTEM_PROMPT/buildTuneUserPrompt/applyCorrection in voicebuild.js; tuneVoice/applyTune/cancelTune in app.js; #tuneGripe/#tuneVoiceBtn/#tuneStatus/#tunePreview in index.html. voice-core.js byte-identical.
// v41: History as learning surface (C5). summarizeOutcomes() pure helper in history.js; outcome filter chips (All/Replied/No reply/Ghosted) + insight line (best mode by reply rate) in History screen. history.js/app.js/index.html/styles.css changed. voice-core.js byte-identical.
// v42: onboarding refresh — quickstart + setup docs now surface the post-basic-loop
//      features (refine/edit, read-the-room, tune-voice, outcome tracking + the
//      "what's landing" insight) so testers discover them. docs only; bumped to
//      re-precache the SHELL docs. No app-logic change.
// v43: voice preview (C9) — "Preview my voice" action in Settings. Generates
//      sample openers against a fixed demo profile (text-only, no screenshot)
//      using the installed voice + currently-selected mode, rendered into
//      a dedicated #previewCard. No History save, no telemetry. Uses the
//      SAME certified VoiceCore.buildSystemPrompt pipeline. index.html /
//      app.js / styles.css changed. voice-core.js byte-identical.
// v44: Read → Generate funnel (C10). After "Read the room" succeeds, a
//      "✍️ Write replies with this in mind" CTA button seeds the NEXT MOVE
//      text into the Notes steering field and calls onGenerate(). app.js /
//      styles.css changed. voice-core.js byte-identical.
const CACHE = 'unicorn-pocket-v44';
const SHELL = [
  './',
  './index.html',
  './voice-core.js',
  './voicebuild.js',
  './history.js',
  './app.js',
  './styles.css',
  './voicepack.starter.json',
  './docs/voice-pack-from-your-messages.md',
  './docs/setup.md',
  './docs/quickstart.md',
  './docs/guide.html',
  './docs/guide.js',
  './docs/guide-boot.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GETs. Never touch the Anthropic API or other cross-origin.
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache-first for the app shell, falling back to network and caching new GETs.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
