// history.js — device-local persistence for recent Pocket "generations".
// A thin, dependency-free IndexedDB wrapper that lets the PWA show a short
// scrollback of past results (mode + tags + thumbnails + the 3 reply options)
// WITHOUT any server. Everything lives in the browser's IndexedDB; NOTHING is
// ever transmitted. This stores REAL conversation-screenshot thumbnails, so the
// device-local-only guarantee is load-bearing — there are no network calls in
// this file by design.
//
// Same split as voice-core.js: the PURE helpers (trimEntries, buildEntry) carry
// the testable logic and run anywhere (browser OR the Node eval harness, which
// has no IndexedDB), while the IDB layer is guarded so the module still LOADS in
// Node — the IDB methods exist but resolve to safe empties/no-ops there. That
// keeps eval/history.test.js a pure-logic test with zero deps and no fake-IDB.
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (eval harness)
  } else {
    root.History = api; // browser (app.js reads window.History)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Keep at most this many generations on-device. Old entries beyond the cap are
  // pruned (oldest-by-ts first) on every add, so the store can't grow unbounded
  // with screenshot-thumbnail dataURLs.
  const MAX_ENTRIES = 50;

  // IDB schema constants. Bump DB_VERSION + handle the migration in
  // onupgradeneeded if the store shape ever changes.
  const DB_NAME = 'unicorn-pocket';
  const DB_VERSION = 1;
  const STORE = 'generations';
  const TS_INDEX = 'by_ts';

  /* ===================== pure helpers (no IDB, no DOM) ===================== */

  // Return a NEW array sorted by ts DESCENDING (most-recent first), sliced to
  // `max`. Does NOT mutate the input — copies first via slice(), because the
  // caller may pass live state and Array.prototype.sort mutates in place.
  function trimEntries(entries, max = MAX_ENTRIES) {
    return (entries || [])
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, max);
  }

  // Build the canonical persisted shape from the app's loose inputs. ts and rand
  // are parameters (not read off the clock/RNG inside) so the pure shape is
  // deterministically testable; the IDB add() path lets them default. id is
  // `${ts}-${rand}` — ts-prefixed so ids sort roughly chronologically and rand
  // disambiguates two generations within the same millisecond.
  function buildEntry(
    { mode, tags, thumbs, options, notes, model, chosenIndex, appVersion, outcome },
    ts = Date.now(),
    rand = Math.random().toString(36).slice(2)
  ) {
    return {
      id: `${ts}-${rand}`,
      ts,
      mode: mode ?? null,
      tags: tags ?? [],
      thumbs: thumbs ?? [],
      options: options ?? [],
      // v15 additions — capture more signal for later analysis.
      //   notes        = the user's free-text steering for this generation.
      //   model        = which model produced these options (claude-* vs gpt-*).
      //   chosenIndex  = which of the 3 options the user tapped Copy on, set
      //                  later via updateChosen() — implicit positive signal.
      // Use typeof check (not `??`) for chosenIndex so 0 is preserved as a
      // legit pick (the first option) rather than coerced to null.
      notes: notes ?? '',
      model: model ?? '',
      chosenIndex: typeof chosenIndex === 'number' ? chosenIndex : null,
      // v21: app shell version that produced this entry. Lets a later miner
      // attribute data to a shell version — the v19 chosenIndex bug was version-
      // specific, so version is load-bearing for trustworthy mining. Defaults to
      // '' for entries persisted before v21 (the field simply won't be present).
      appVersion: appVersion ?? '',
      // v37: did the sent reply actually land? Set later via updateOutcome() once
      // the user knows if she replied. 'replied' | 'no_reply' | 'ghosted' | null
      // (null = unset). Device-local only; rides the Export payload automatically.
      outcome: outcome ?? null,
    };
  }

  // summarizeOutcomes(entries) -> { totalTagged, byMode, best }
  // PURE — no IDB, no DOM. Groups entries by voice mode and counts replied/total
  // to surface which mode lands replies most often. Used by the History screen to
  // render an insight line ("Landing best: ✈️ Tourist — 3/4 replied").
  //
  // "tagged" = entry.outcome is one of 'replied' | 'no_reply' | 'ghosted'.
  // null/undefined outcome entries are ignored (not yet rated).
  // null/empty mode is bucketed as 'LOCAL' — matches the UI label for no-mode generations.
  //
  // Returns:
  //   { totalTagged, byMode: { MODE: { replied, total } }, best: { mode, replied, total, rate } | null }
  //   best = mode with highest rate (replied/total) among modes with total >= 2;
  //          tiebreak: higher replied count, then alphabetical mode; null if none qualify.
  // Defensive: non-array input → { totalTagged:0, byMode:{}, best:null }. Never throws.
  function summarizeOutcomes(entries) {
    const VALID_OUTCOMES = new Set(['replied', 'no_reply', 'ghosted']);
    if (!Array.isArray(entries)) return { totalTagged: 0, byMode: {}, best: null };

    let totalTagged = 0;
    const byMode = {};

    for (const entry of entries) {
      if (!entry || !VALID_OUTCOMES.has(entry.outcome)) continue; // skip untagged
      totalTagged++;
      // Normalize mode: null/empty string → 'LOCAL'
      const mode = (entry.mode && typeof entry.mode === 'string' && entry.mode.trim())
        ? entry.mode.trim()
        : 'LOCAL';
      if (!byMode[mode]) byMode[mode] = { replied: 0, total: 0 };
      byMode[mode].total++;
      if (entry.outcome === 'replied') byMode[mode].replied++;
    }

    // Pick best: modes with total >= 2, highest rate; tiebreak higher replied, then alpha.
    let best = null;
    for (const [mode, counts] of Object.entries(byMode)) {
      if (counts.total < 2) continue;
      const rate = counts.replied / counts.total;
      if (
        best === null ||
        rate > best.rate ||
        (rate === best.rate && counts.replied > best.replied) ||
        (rate === best.rate && counts.replied === best.replied && mode < best.mode)
      ) {
        best = { mode, replied: counts.replied, total: counts.total, rate };
      }
    }

    return { totalTagged, byMode, best };
  }

  /* ===================== IndexedDB layer (browser only) ===================== */

  // Whether we have a real IndexedDB. In Node (eval harness) this is false, so
  // every method below short-circuits to a safe empty/no-op and the module still
  // loads — letting the pure helpers be imported and tested with zero deps.
  const HAS_IDB = typeof indexedDB !== 'undefined';

  // Cached open-DB promise. We open lazily on first use and reuse the same
  // connection for the life of the page (open is async + can prompt an upgrade,
  // so doing it once is both correct and cheaper).
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          // Index on ts so listRecent / oldest-pruning can walk in ts order
          // without loading + sorting the whole store.
          store.createIndex(TS_INDEX, 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // If a concurrent tab holds an older-version connection open, the upgrade
      // is blocked. Surface it rather than hanging the open promise forever.
      req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab.'));
    });
    return dbPromise;
  }

  // Run `fn(store)` inside a transaction of `mode` and resolve with whatever the
  // caller's inner request resolves to (set via the returned wrapper). Centralizes
  // the oncomplete/onerror/onabort wiring so each method stays small.
  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      // fn may set `result` (directly or via a request's onsuccess). We resolve
      // on tx.oncomplete — not on the request — so a write is only "done" once
      // the transaction has actually committed to disk.
      Promise.resolve(fn(store, (v) => { result = v; })).catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  // Promisify a single IDBRequest.
  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Delete the oldest entries so the store holds at most MAX_ENTRIES. Walks the
  // by_ts index ascending (oldest first) and deletes the overflow; cheap because
  // we only count keys, not load the records.
  async function enforceCap() {
    await withStore('readwrite', (store) => new Promise((resolve, reject) => {
      const index = store.index(TS_INDEX);
      const countReq = index.count();
      countReq.onsuccess = () => {
        const overflow = countReq.result - MAX_ENTRIES;
        if (overflow <= 0) { resolve(); return; }
        let pruned = 0;
        // Ascending cursor = oldest ts first; delete until we've removed the overflow.
        const cursorReq = index.openCursor(null, 'next');
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || pruned >= overflow) { resolve(); return; }
          cursor.delete();
          pruned++;
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    }));
  }

  // add({ mode, tags, thumbs, options }) -> Promise<entry>
  // Builds the canonical entry, writes it, prunes to MAX_ENTRIES, resolves the
  // stored entry. In Node (no IDB) resolves the built entry without persisting,
  // so callers get a consistent shape back regardless of environment.
  async function add(input) {
    const entry = buildEntry(input || {});
    if (!HAS_IDB) return entry;
    await withStore('readwrite', (store) => { store.put(entry); });
    await enforceCap();
    return entry;
  }

  // listRecent(limit = 20) -> Promise<entry[]> — most-recent first.
  // Walks the by_ts index in DESCENDING order and stops at `limit`. Returns [] in
  // Node (no IDB).
  async function listRecent(limit = 20) {
    if (!HAS_IDB) return [];
    return withStore('readonly', (store, done) => new Promise((resolve, reject) => {
      const out = [];
      const cursorReq = store.index(TS_INDEX).openCursor(null, 'prev'); // newest first
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || out.length >= limit) { done(out); resolve(); return; }
        out.push(cursor.value);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    }));
  }

  // get(id) -> Promise<entry|null>. Resolves null (not undefined) on a miss so
  // callers can branch on a stable value. Returns null in Node (no IDB).
  async function get(id) {
    if (!HAS_IDB) return null;
    return withStore('readonly', async (store, done) => {
      const value = await reqAsPromise(store.get(id));
      done(value ?? null);
    });
  }

  // remove(id) -> Promise<void>. Resolves once the delete transaction commits.
  // No-op resolve in Node (no IDB).
  async function remove(id) {
    if (!HAS_IDB) return;
    await withStore('readwrite', (store) => { store.delete(id); });
  }

  // clear() -> Promise<void>. Wipes the whole store. No-op resolve in Node.
  async function clear() {
    if (!HAS_IDB) return;
    await withStore('readwrite', (store) => { store.clear(); });
  }

  // updateChosen(id, index) -> Promise<void>. Records which of the 3 options the
  // user tapped Copy on (implicit positive signal — they Copy'd it, so they
  // intended to send it). Tolerates a missing entry (the row may have been
  // pruned beyond MAX_ENTRIES between generate + copy, or cleared by the user).
  // No-op resolve in Node.
  //
  // TELEMETRY LOSSINESS NOTE: when the target row was pruned past MAX_ENTRIES
  // the update silently no-ops (correct — there's nothing to update), but the
  // chosenIndex signal is LOST for that generation. Any future session that
  // mines chosenIndex to promote winners into eval fixtures MUST:
  //   1. Deduplicate entries (export → import flow can produce duplicate ids).
  //   2. Sanity-check that chosenIndex is non-null before treating it as signal.
  //   3. Not trust the field blindly — the dataset is lossy past MAX_ENTRIES.
  // The console.debug below makes the loss observable without user-facing noise.
  async function updateChosen(id, index) {
    if (!HAS_IDB) return;
    await withStore('readwrite', (store, done) => new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) {
          // Row was pruned past MAX_ENTRIES or cleared — chosenIndex signal lost.
          // Observable via debug log; no user-facing effect. See lossiness note above.
          // eslint-disable-next-line no-console
          console.debug('[history] updateChosen: entry', id, 'not found (pruned/cleared) — chosenIndex pick lost');
          done(); resolve(); return;
        }
        existing.chosenIndex = index;
        const putReq = store.put(existing);
        putReq.onsuccess = () => { done(); resolve(); };
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    }));
  }

  // updateOutcome(id, outcome) -> Promise<void>. Records whether the sent reply
  // landed — 'replied' | 'no_reply' | 'ghosted' | null (null clears the signal).
  // Mirrors updateChosen exactly: get → no-op on a missing row → put. Same
  // lossiness note applies: rows pruned past MAX_ENTRIES silently no-op; outcome
  // mining must sanity-check non-null before treating the field as signal.
  // No-op resolve in Node.
  async function updateOutcome(id, outcome) {
    if (!HAS_IDB) return;
    await withStore('readwrite', (store, done) => new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) {
          // Row was pruned past MAX_ENTRIES or cleared — outcome signal lost.
          // eslint-disable-next-line no-console
          console.debug('[history] updateOutcome: entry', id, 'not found (pruned/cleared) — outcome signal lost');
          done(); resolve(); return;
        }
        existing.outcome = outcome;
        const putReq = store.put(existing);
        putReq.onsuccess = () => { done(); resolve(); };
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    }));
  }

  // exportAll() -> Promise<entry[]>. Returns ALL entries (not capped to a limit
  // like listRecent), most-recent first, for the History -> Export button. The
  // returned payload is what leaves the device, so the caller can wrap it with a
  // schema marker + timestamp before download/share. Returns [] in Node.
  async function exportAll() {
    if (!HAS_IDB) return [];
    return withStore('readonly', (store, done) => new Promise((resolve, reject) => {
      const out = [];
      const cursorReq = store.index(TS_INDEX).openCursor(null, 'prev'); // newest first
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { done(out); resolve(); return; }
        out.push(cursor.value);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    }));
  }

  return {
    MAX_ENTRIES,
    // pure helpers
    trimEntries,
    buildEntry,
    summarizeOutcomes,
    // IDB-backed (browser) / safe no-op (Node)
    add,
    listRecent,
    get,
    remove,
    clear,
    updateChosen,
    updateOutcome,
    exportAll,
  };
});
