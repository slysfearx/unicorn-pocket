# Unicorn Pocket — setup + how to use it (~3 min)

A tiny iPhone web app that turns a dating-app screenshot into three reply options matched to your voice. You copy the one you like back into the dating app. No server, no signup, your stuff stays on your phone.

**Live:** https://slysfearx.github.io/unicorn-pocket/

---

## 1. Install on your iPhone (Safari, 30 sec)

Open Safari (not Chrome — iOS "Add to Home Screen" only works right in Safari). Go to the URL above. Tap **Share** → **Add to Home Screen** → Add. Open the new icon. It looks like a real app.

## 2. First-run setup (~2 min)

The first time you open it, you land on a small **Welcome to Pocket** card with three buttons:

- **Use starter voice (anonymous, 2 sec)** — fastest path. Loads a generic warm/curious texter voice you can swap out later, then opens Settings if you still need to paste your API key.
- **Build my own (opens guide)** — opens the in-app guide for *extracting* your real messages, then takes you to Settings. (The actual build is one tap right in Settings — **Build my voice**, see §9.)
- **Skip — open Settings to paste a pack** — for the rare case where you already have a voice pack JSON ready to paste.

Whichever you pick, you'll end up in Settings. Three fields to deal with there:

**Anthropic API key (required for Claude).** Paste your key here (it starts with `sk-ant-…`). Get one at https://console.anthropic.com → API Keys → Create Key. Anthropic gives most new accounts a few dollars of free credit, which is enough for hundreds of generations. The key is stored only on your phone.

**Model.** A dropdown menu — leave it on **Claude Sonnet 4.6** (recommended). You can switch anytime: other Claude models, a GPT model (see §5), or **"Other"** to type any model id.

**Voice pack (required).** The voice that the replies sound like. If you tapped **"Use starter voice"** above, it's already loaded — you can skip this and tap **Save & done**. To build your own later, scroll down in Settings to **Build my voice** — paste your real messages, tap once, done (see §9). Your replies start sounding like you wrote them.

Tap **Save & done**.

## 3. Use it

On the main screen:

1. **Add a screenshot.** Tap **Tap to add screenshots from your camera roll** and pick one. Or screenshot something, then tap **📋 Paste screenshot** to paste from the clipboard directly. Add up to 6 screenshots if a thread spans multiple shots — they're sent in upload order, so add them oldest → newest.
2. **(Optional) Pick a voice mode.** Tourist (you're visiting / new in town), Kink (flirty), Long (warmer, more curious), Go (direct, propose meeting). No mode = your default casual voice. Tags `#10` (full-send tonight) and `#re` (re-engage a cold thread) stack on top.
3. **(Optional) Type a Note** in the Notes box to steer the reply. Examples: "respond to her opening line", "keep it short", "ask her out for drinks Friday".
4. Tap **Generate replies**. You get 3 options.
5. Tap **Copy** on the one you like. It's in your clipboard. Switch to the dating app and paste.

That's the whole flow. A few things that make it noticeably better:

6. **Refine without starting over.** Under your 3 options, one-tap chips (**Shorter / Bolder / Funnier / More curious / Make a move**) regenerate nudged that way; **🔄 New options** gives a fresh take. Tap **Edit** on any option to tweak it before you copy — the copy takes your edit.
7. **🔍 Read the room.** Tap it (under Generate) for an honest coach's read of the screenshot — her interest level, what's working or stalling, one next move — instead of replies. Good when you're unsure how to play it.
8. **🎚 Tune your voice.** If replies feel a little off, Settings → **Tune my voice** → say what to fix in a line. It updates your installed voice and sticks.

## 4. History (clock icon, top right)

Every generation is saved on your phone (never sent anywhere). Tap the clock icon to see your past calls. A small line at the top shows your own usage so far (e.g. "12 generated · 1 error · 3 voices used"). Tap any entry to reopen its screenshots + replies — you can add another screenshot to the same thread and regenerate. A "✓" marks the option you Copy'd last time.

**Mark what landed.** On each past reply, tap 💚 (she replied) / 🚫 (no reply) / 👻 (ghosted). Once you've marked a few, a line at the top tells you **which voice gets the most replies** — Unicorn's read on what's actually working for you. Filter the list by outcome with the chips at the top. (All device-local; it only leaves your phone if you Export.)

Tap **Export history (JSON)** at the bottom to share the file with the maintainer (helps tune the voice quality over time). Or **Clear all history** to wipe it.

## 5. (Optional) Use GPT instead of Claude

Pocket can use OpenAI's `gpt-4o` too. Because OpenAI (unlike Anthropic) blocks direct browser calls, GPT goes through a tiny shared proxy. Three quick things:

1. **Get the proxy URL** from whoever sent you Pocket — they run one shared proxy for everyone, so you don't deploy anything.
2. **Get an OpenAI key + add a little credit.** platform.openai.com → API keys → create one (`sk-...`); then Settings → Billing → add a few dollars. (Heads up: OpenAI doesn't give free starting credit the way Anthropic does, so with a $0 balance you'll just see an "out of credit" message.)
3. **In Pocket Settings:** open the **Model** menu and pick **GPT-4o**, paste your **OpenAI API key**, paste the **Proxy URL**, then Save & done.

GPT routing turns on automatically when a GPT model is picked. Claude (`claude-*`) keeps working with no proxy and stays the default — switch between them anytime from the Model menu.

## 6. Updates

I push improvements regularly. To pull the latest:
- **Force-close** the Unicorn app (swipe up from the bottom, hold, swipe up on the Unicorn card).
- **Reopen it twice** (the new version swaps in on the second open — quirk of how PWAs update).

Or just open the live URL in Safari and pull-to-refresh, then re-add to home screen.

## 7. Privacy + cost

- **Your API key + voice pack + history live only on your phone.** No central server, no third-party analytics. By default **nothing is sent to the maintainer** (see the opt-in below).
- **What's stored on-device:** each generation (your screenshot thumbnails, the 3 reply options, your note, the model used, and which option you Copy'd) plus small **usage counters** (how many generations, how many errors, which voices/models — counts only, no message content).
- **Optional: anonymous usage stats (OFF by default).** Settings has a **"share anonymous usage stats"** toggle. If you turn it ON, each time you generate, Pocket sends a tiny anonymous record to the maintainer — which voice + model you used, how many options came back, the latency, the error type (if any), and the app version. **It never sends your screenshots, the conversation, the reply text, your note, or your API key** — counts and timings only. Off unless you switch it on; switch it off any time to stop.
- **What leaves your phone, and when:** (a) the single model API call per Generate, sent straight to Anthropic (or OpenAI via the proxy); (b) the History file **if you tap Export and choose to share it** (your screenshots + replies + usage counts); and (c) **only if you opt in above**, the anonymous per-generation usage record. Nothing else, ever.
- **Each generation is one API call** billed to your account. Typical cost is **$0.02 - $0.05 per generation** with `claude-sonnet-4-6` — a heavy user spends a few dollars a month, most users a lot less.
- **No subscription, no markup.** You pay the model provider directly.

## 8. Trouble + feedback

- **"Add your API key" or 401 errors:** re-paste the key in Settings, double-check no trailing whitespace.
- **"Out of credit":** top up at console.anthropic.com (or your OpenAI billing for GPT).
- **GPT model errors:** confirm the Proxy URL is set and the proxy is actually deployed, and that your OpenAI key has credit.
- **Replies feel off:** try a different voice mode, type a Note to steer, or use a clearer screenshot.
- **Anything else:** text the maintainer with a screenshot of what broke. This is a small private build, made to iterate fast.

**Feedback loop that actually helps:** tap History → Export history (JSON) → AirDrop / iMessage the file to the maintainer. It includes the screenshots, which reply you Copy'd, and your usage counts — exactly what's needed to tune voice quality over time.

---

## 9. (Optional) Build your own voice — the best upgrade

The starter voice is generic. A voice built from YOUR real messages makes the replies actually sound like you. **The app builds it for you in one tap** — you just need to gather some of your sent messages first.

**Build it in-app (easiest):** open **Settings → Build my voice**. Paste a few hundred of your own sent messages into the box and tap **Build my voice**. The app makes one API call on your own key (~$0.10) to derive a voice description, then installs it — replacing the starter voice. **Your messages are never stored**; only the resulting voice description is saved.

**Getting your messages** (the one manual part) — there's an in-app guide: tap the first-run **"Build my own"** button, or **Settings → "How to extract messages"**, or open it directly at https://slysfearx.github.io/unicorn-pocket/docs/guide.html?doc=voice-pack-from-your-messages . Three sources:
- **iMessage** (Mac): extract your last few hundred sent messages from `~/Library/Messages/chat.db` — the guide walks you through Full Disk Access + prompting Claude Code or Codex to do it safely.
- **WhatsApp:** the built-in Export Chat feature on a few of your most active threads.
- **Tinder** (or any GDPR-compliant dating app): request your data download — it arrives as JSON.

**Power-user / no-key alternative:** prefer not to spend the ~$0.10 in-app? Paste your messages + the transformation prompt (in the guide) into any LLM yourself, get a voice-pack JSON, and load it via **Settings → Voice pack → paste**, AirDrop the `.json`, or fetch from a URL. Same result, fully manual.

---

*Live: https://slysfearx.github.io/unicorn-pocket/* · *Current version shown in-app (Settings → version label) · 2026-06-03*
