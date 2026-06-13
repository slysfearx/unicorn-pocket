# Build your own voice pack

The shipped starter pack works fine, and you can tap "Use starter voice" in Settings if you want replies in 30 seconds. But a pack built from your *own* messages produces noticeably better suggestions: it picks up your real opener style, your real escalation rhythm, the way you actually flirt, and the small words you actually use. This guide walks you through pulling messages out of iMessage, WhatsApp, or Tinder, then turning them into the small JSON file the app loads.

You'll spend about 30-60 minutes the first time. After that, your pack lives on your phone and you never touch it again.

## What you're producing

The app expects a single JSON file with this shape:

```json
{
  "base_voice": "...long-form description of how you write...",
  "modes": {
    "mode_local": "...",
    "mode_travel": "...",
    "mode_go": "...",
    "tag_kink": "...",
    "tag_chill": "...",
    "tag_10": "...",
    "tag_re": "..."
  }
}
```

Field by field:

| Key | What it is | Roughly |
|---|---|---|
| `base_voice` | The big one. A reference document describing how you write across all contexts: tone, sentence length, vocabulary you reach for, things you would never say, how you handle silence, how you handle heavy moments. The model reads this *every* request. | 500 to 1200 words |
| `modes.mode_local` | Default mode when you're at home, in your normal city. Your everyday flirting voice. | 80 to 200 words |
| `modes.mode_travel` | When you're visiting somewhere, on a trip, passing through. Different energy: time-bounded, often more direct, often more curious about the other person's city. | 80 to 200 words |
| `modes.mode_go` | Direct, high-energy, time-to-meet mode. Cuts banter, proposes a plan. | 80 to 200 words |
| `modes.tag_kink` | Flirty / suggestive, but NOT explicit. Playful escalation, tension, double meanings. The kind of thing you'd say to someone you're already vibing with. | 80 to 200 words |
| `modes.tag_chill` | Long-conversation mode. Warmer, more curious, more willing to follow her lead and ask follow-ups. Lower-pressure. | 80 to 200 words |
| `modes.tag_10` | Tonight mode. Specifically tuned to "we're going to meet up in the next few hours": quick plan, specific time, low friction. | 80 to 200 words |
| `modes.tag_re` | Re-engage mode. For ghosted threads, conversations that died, or matches you forgot about. Brings warmth without acting like the gap didn't happen. | 80 to 200 words |

A couple of style rules the app enforces, which your pack should respect:

- **No em dashes (`—`), en dashes (`–`), or double hyphens (`--`)** anywhere in the pack. The app strips these from the generated reply as a safety net, but the voice pack itself should be clean. Use commas, periods, or parentheses.
- **No AI-assistant tells.** "I'd be happy to help" energy is the opposite of what you want. Write your `base_voice` the way you'd describe yourself to a friend: "I'm dry, I use a lot of one-word replies, I rarely use exclamation points, I never compliment looks first."
- **No generic pickup-artist lines** in any of the mode sections. The whole point is sounding like *you*, not like a template.

## Step 1: Get your messages out

Pick whichever platform you actually use most. You only need one. Mixing two is better if you have the patience; the model gets a richer picture of how you write across contexts.

### Option A: iMessage (Mac, recommended)

Best signal-to-noise. iMessage holds years of your real, contextual texting, including everything from friends to dates to family. You'll filter to just the dating-relevant threads.

**Step 1: Give your terminal Full Disk Access.**

iMessage's database lives at `~/Library/Messages/chat.db`, and macOS protects that path with a permission called Full Disk Access. Without it, the file looks empty.

1. Open System Settings.
2. Privacy & Security → Full Disk Access.
3. Find your terminal app in the list (Terminal, iTerm, Warp, whichever you use) and toggle it on. If it's not listed, click the `+` and add it from `/Applications/Utilities/`.
4. Quit and reopen the terminal so the permission takes effect.

Quick sanity check from the terminal:

```bash
sqlite3 ~/Library/Messages/chat.db "SELECT COUNT(*) FROM message;"
```

If you see a number (probably in the tens of thousands), you're good. If you see an "unable to open database" error, the FDA grant didn't apply to *that* terminal, so recheck step 3.

**Step 2: Ask an LLM to extract your sent messages.**

The cleanest path is to hand the job to Claude Code, Codex, or any local coding agent. Paste this prompt into it:

> Read the SQLite database at `~/Library/Messages/chat.db`. From it, extract the last 1,500 messages I sent (`is_from_me = 1`), deduped, with timestamps. Group them by `chat` so I can see which conversation each message came from, but anonymize the other party's identifier (replace their handle with `PERSON_1`, `PERSON_2`, etc., consistently per chat). Skip group chats (more than two participants). Skip threads with fewer than 20 messages total. Skip messages that are just URLs, just emoji, or shorter than 3 characters. Output a plain text file at `~/Desktop/my_sent_messages.txt`, formatted like this:
>
> ```
> === Conversation with PERSON_1 (47 messages) ===
> [2025-03-14 19:22] <ME> hey, your bio says you read a lot. what's the last thing that wrecked you
> [2025-03-14 21:08] <THEM> oh that's a real question
> [2025-03-14 21:09] <ME> i meant it
> ```
>
> Use `<ME>` and `<THEM>` tags so the context of who said what is preserved. Include the message I was replying to (one message of context) for each of my sends, so the model can see how I respond.

Tweak the number (1,500 is a good starting point; go to 3,000 if you're a heavy texter). The agent will hand you back a text file.

**Step 3: Skim it.**

Open the file. Make sure it looks like *you*, your real voice, your real range. If a chunk of it is conversations you don't want shaping your voice (your mom, your boss, an ex you've moved on from), open the file in a text editor and delete those sections. The LLM in the next step takes whatever you give it as ground truth, so 30 seconds of pruning here pays off.

Recommend: extract 500 to 2,000 of YOUR sent messages from at least 5 to 10 different conversations. Fewer than that and the voice pack will overfit to one person.

### Option B: WhatsApp (any phone)

Lower signal than iMessage because WhatsApp's export is per-conversation and includes both sides without timestamps you can easily filter on. But it's the only option if you're on Android or don't have a Mac.

**iPhone:**

1. Open the chat.
2. Tap the contact's name at the top.
3. Scroll down → Export Chat.
4. Choose **Without Media** (you only need text).
5. Save to Files, or AirDrop to your Mac.

**Android:**

1. Open the chat.
2. Tap the three-dot menu → More → Export chat.
3. Choose **Without media**.
4. Share to wherever (email it to yourself, save to Drive, etc.).

You'll get a `.txt` file shaped like:

```
[3/14/25, 7:22:14 PM] Me: hey, your bio says you read a lot
[3/14/25, 9:08:02 PM] Person Name: oh that's a real question
[3/14/25, 9:09:41 PM] Me: i meant it
```

**Strip out the other party's messages.** From the terminal, on the exported file:

```bash
grep -E "] Me:" "WhatsApp Chat with Person.txt" \
  | sed 's/^\[[^]]*\] Me: //' \
  > my_whatsapp_sent.txt
```

(Replace `Me` if WhatsApp localized it to your language.) That leaves you with one line per message you sent.

Do this for 5 to 10 of your most active conversations. Concatenate them:

```bash
cat my_whatsapp_sent_*.txt > my_sent_messages.txt
```

Recommend: export 5 to 10 of your most active conversations. You're aiming for 500+ of your own sent lines.

If you want to preserve context (recommended), do this instead of the grep filter:

```bash
# Keep both sides but tag yours
sed 's/] Me:/] <ME>:/; s/] [^:]*:/] <THEM>:/' \
  "WhatsApp Chat with Person.txt" \
  > my_whatsapp_tagged.txt
```

That keeps the back-and-forth so the LLM in step 2 can see how you respond to specific things.

### Option C: Tinder (or any dating app with a data download)

The slowest path because you have to wait for the platform to email you a ZIP. Start this on day one if you're going to do it.

**Tinder:**

1. Go to [tinder.com](https://tinder.com) on a browser.
2. Log in.
3. Account → Download My Data → Request a copy.
4. Wait 24 to 72 hours. You'll get an email with a download link. The link expires after a few days, so grab it.

The ZIP contains a folder of JSON files. The relevant one is `messages.json`. Schema:

```json
[
  {
    "match_id": "abc123",
    "messages": [
      {
        "to": "xyz789",
        "from": "your_tinder_user_id",
        "message": "hey, your bio said you read a lot",
        "sent_date": "2025-03-14T19:22:14.000Z"
      },
      ...
    ]
  },
  ...
]
```

**Filter to just your sent messages.** From the terminal, in the unzipped folder:

```bash
# Find your user ID first (it'll be the same across every message you sent)
jq -r '.[0].messages[0].from' messages.json
```

Then:

```bash
# Replace YOUR_ID with what you just printed
jq -r '.[] | .messages[] | select(.from == "YOUR_ID") | .message' \
  messages.json \
  > my_tinder_sent.txt
```

That gives you one message per line. Probably a few hundred to a few thousand depending on how active you've been.

If you want context (recommended for short-attention-span dating-app messages), keep both sides:

```bash
jq -r --arg me "YOUR_ID" '
  .[] |
  "=== Match \(.match_id) ===" ,
  (.messages[] |
    if .from == $me then "<ME>: \(.message)"
    else "<THEM>: \(.message)" end
  )
' messages.json > my_tinder_tagged.txt
```

**Other dating apps with similar data exports:**

- **Hinge**: Settings → Download my data. Email-based, takes a day or two. Format is similar (JSON per match).
- **Bumble**: Settings → Security and Privacy → Download my data. Email-based, takes a few days.
- **Feeld**: Email support@feeld.co with a GDPR data-request. Manual process, slower.
- **Grindr / Scruff / OkCupid**: All have similar GDPR-mandated download paths. Search "[app name] data download" or "[app name] GDPR".

The shape varies per platform, but the pattern is the same: find the file with your messages, filter to ones where the sender is you, output one message per line (or tagged with context).

## Step 2: Transform your messages into a voice pack

You now have a text file with your sent messages (and ideally some context). Next: feed it to an LLM with the prompt below, get the JSON back, save it.

**What this costs:** Usually under $0.10 of API spend. The prompt is long, but the corpus you feed it is only a few thousand tokens of plain text, and the JSON output is a few thousand tokens. One call.

**Where to run it:** Anywhere you can paste a prompt and attach a file. Claude Code (`claude` in your terminal with the file in your project) is easiest. Codex works. So does claude.ai with a file upload, or the Anthropic console, or the OpenAI playground. Pick whichever you already have set up.

### The transformation prompt (copy-paste)

Paste everything between the dividers below into your LLM of choice, then attach (or paste) your `my_sent_messages.txt` file underneath.

---

> You are going to build a JSON "voice pack" that captures how the user writes when texting people they're dating. The pack will be used by a separate app that generates dating-app reply suggestions in the user's voice.
>
> **The user has attached a corpus of their real sent messages.** Study it carefully. Your output is a JSON object that abstractly describes the user's voice, NOT examples copied from the corpus.
>
> ## Output schema
>
> Return EXACTLY this shape, a single JSON object, no commentary before or after:
>
> ```json
> {
>   "base_voice": "string, 500 to 1000 words",
>   "modes": {
>     "mode_local": "string, 80 to 200 words",
>     "mode_travel": "string, 80 to 200 words",
>     "mode_go": "string, 80 to 200 words",
>     "tag_kink": "string, 80 to 200 words",
>     "tag_chill": "string, 80 to 200 words",
>     "tag_10": "string, 80 to 200 words",
>     "tag_re": "string, 80 to 200 words"
>   }
> }
> ```
>
> ## What each field is for
>
> **`base_voice` (the big one, 500 to 1000 words).**
> A reference document the model reads on every reply. It is NOT a list of example messages. It is a *description* of how the user writes. Cover:
>
> - **Tone fingerprint**: dry / warm / playful / direct / curious / sardonic / etc. Use multiple words, qualify with frequency ("usually dry, sometimes warm when she's being vulnerable").
> - **Sentence shape**: average length, how often they use one-word replies, how often they use fragments vs. full sentences, how they handle multi-sentence replies (one block? broken into 2 messages?).
> - **Punctuation habits**: do they use periods at the end? Exclamation points? Question marks? Lowercase by default or capitalized? Apostrophes?
> - **Vocabulary fingerprint**: words and phrases they actually reach for that are distinctive (note them as a list of representative phrases, NOT verbatim copies of full messages).
> - **Opener moves**: how they typically start a conversation with someone new (callback to bio? observation? question? joke? compliment? something else?).
> - **Escalation style**: how they move a conversation toward meeting up. Direct ask? Soft suggestion? Wait for her to bring it up?
> - **How they handle silence / ghosting / slow replies**: do they double-text? Ignore and wait? Bring it up later?
> - **How they handle heavy moments**: if she shares something vulnerable, how do they respond? With matched vulnerability? A specific recall? A joke? Warmth without intrusion?
> - **Things they would NEVER say**: every voice has anti-patterns. List 5 to 10 things that would feel actively wrong in their voice (e.g. "never says 'lol'", "never calls anyone 'babe' on the first day", "never opens with a compliment about appearance", "never uses 'circle back'").
> - **A note about emoji**: do they use them? Which ones? How often? Same answer for GIFs/reactions if you can tell.
>
> Write `base_voice` in second person addressed to the model that will use it ("You write like this:", "You never:", etc.) so the downstream LLM reads it as instructions.
>
> **`modes.mode_local` (80 to 200 words).**
> Default mode. The user's everyday flirting voice when they're at home, no special context. Describe what shifts (if anything) in this mode versus the base voice. If the corpus shows their default register clearly, describe that. If not, describe what their default should be in spirit.
>
> **`modes.mode_travel` (80 to 200 words).**
> When the user is visiting somewhere. Time-bounded ("I'm in town until Sunday"), often more direct because of the deadline, often more curious about her city / what she'd recommend. Describe the shift from base voice.
>
> **`modes.mode_go` (80 to 200 words).**
> Direct, high-energy, "let's actually meet" mode. Cuts the banter, proposes a plan with a specific time or place. Describe what shifts. If you can find examples in the corpus where the user proposed meeting up, use those as a guide for tone (DESCRIBE, don't quote).
>
> **`modes.tag_kink` (80 to 200 words).**
> Flirty / suggestive, NOT explicit. Playful escalation, double meanings, tension. The kind of thing said to someone the user is already clearly clicking with. Describe what shifts. Find evidence in the corpus of how they flirt and describe THAT register (do not produce explicit content).
>
> **`modes.tag_chill` (80 to 200 words).**
> Long, low-pressure conversation mode. Warmer, more curious, more willing to follow her lead and ask follow-ups instead of pushing toward a meet. Describe what shifts.
>
> **`modes.tag_10` (80 to 200 words).**
> Tonight mode. Specifically tuned to "we are going to meet in the next few hours." Quick plan, specific time, low friction, no fluff. Describe what shifts.
>
> **`modes.tag_re` (80 to 200 words).**
> Re-engage mode. For ghosted threads or conversations that died weeks/months ago. Brings warmth without acting like the gap didn't happen. Acknowledges the gap lightly OR opens with something specific that makes the reach-out feel non-random. Describe what shifts.
>
> ## Hard rules
>
> 1. **No em dashes (`—`), en dashes (`–`), or double hyphens (`--`)** anywhere in your output. Use commas, periods, or parentheses.
> 2. **No AI-assistant phrasing** like "I'd be happy to" or "feel free to" or "as you mentioned". Voice packs are written in the user's voice, not the model's.
> 3. **No generic pickup-artist lines** anywhere ("negging", "push-pull", "DHV", "stack the routine", etc.). The point is sounding like THIS user, not like a template.
> 4. **Describe patterns, don't copy messages verbatim.** If the corpus has a great line, abstract the move it represents and describe that. Don't paste the line into the pack.
> 5. **Each mode section should describe what SHIFTS from base voice, not repeat base voice.** Brevity in each mode is good if base voice covers the rest.
> 6. **Match the register of the source corpus.** If the user texts in lowercase, write the descriptions with examples in lowercase. If they capitalize, capitalize.
> 7. **Output a single JSON object.** No prose before. No prose after. No code-block fencing. Just the JSON.

---

That's the prompt. Save it somewhere you can copy-paste from later in case you want to regenerate your pack with a fresh corpus (e.g. six months from now after more conversations).

### Sanity-check the output

Once the LLM returns the JSON, open it and read it. You're checking:

1. **Does `base_voice` sound like a description of you?** If you'd be embarrassed for a friend to read it as a description of your texting, regenerate (often a re-run with the same prompt and the same corpus yields a better result).
2. **Are the mode sections actually different from each other?** If `mode_local` and `mode_travel` say basically the same thing, the model didn't differentiate enough. Regenerate or hand-edit.
3. **Are there any em dashes?** Search for `—` and `–` and `--`. If you find any, replace them with commas. (The app strips them at runtime as a safety net, but a clean pack is better.)
4. **Are there any names from your corpus?** The pack should be voice-only and not mention specific people. Search for any names you saw in your message archive and remove them.
5. **JSON is valid?** Paste it into [jsonlint.com](https://jsonlint.com) or run `jq . my_voice_pack.json` from the terminal. If `jq` doesn't error, you're good.

Save the result as `my_voice_pack.json` (or whatever you want to call it).

## Step 3: Load it into the app

Three ways. Pick the one that fits where the JSON file currently is.

### Option 1: Paste JSON (easiest on phone)

1. Open your JSON file on your computer.
2. Copy the entire contents.
3. On your phone, open Unicorn Pocket → Settings (gear icon top right) → scroll to **Voice pack**.
4. Find the field labeled **"…or paste voice-pack JSON"** and paste into the textarea.
5. Tap **Save pasted pack**.
6. The status above should now read "Voice pack loaded, 7 mode sections, base voice [N] chars."

If you don't see that confirmation, the JSON didn't parse. Check for missing commas or quotes in the pasted text.

### Option 2: AirDrop a .json file

1. On your Mac, rename the file `voicepack.json` (or anything with a `.json` extension).
2. AirDrop it to your phone.
3. Tap the AirDrop notification → save to Files.
4. In Unicorn Pocket → Settings → Voice pack → find **"…or load a .json file (AirDrop it to your phone first)"**.
5. Tap the file picker, navigate to where you saved it, select it.
6. The pack loads. Same confirmation as above.

### Option 3: Load from URL

If you want to host the pack somewhere (a private Gist, your own server, an iCloud Drive shared link) so you can update it from one place and have it sync, use this.

1. Host the JSON wherever (must be publicly accessible from the URL, even if it's privately shared).
2. In Unicorn Pocket → Settings → Voice pack → find **"Load from URL"**.
3. Paste the URL into the field.
4. Tap **Fetch**.
5. The pack loads.

A few cautions on URL hosting:

- The URL is fetched from your browser, so anything that requires a login (private Notion pages, password-protected URLs) won't work. Use a Gist with a "secret" (unguessable) URL, or your own server.
- If you put it on a public Gist, anyone with the URL can read your voice pack. That's only as private as the URL is hard to guess.
- The fetched pack overwrites the current one. If you've been tweaking the pasted version on your phone, fetch will blow those tweaks away.

## Privacy notes

- Your voice pack lives **only on your device**, in your browser's `localStorage`. It never leaves your phone except when the app uses it to construct a prompt to send to your AI provider (Anthropic, or OpenAI via a proxy you control) when you tap Generate.
- Your message history (the raw text file you extracted in Step 1) is processed **only** by whatever LLM you chose to run the transformation prompt on. The resulting JSON contains *abstract* voice instructions, not raw messages from your archive. After the transformation, you can delete the raw text file if you want.
- The starter pack option (one tap in Settings if you ever land on it) lets you skip all of this if you want a faster path. You can switch to your custom pack later by following Step 3 above.
- The app uses your own API key on every request, so the cost of the actual reply generation goes to your AI account, not anyone else's. Same for the one-time voice-pack transformation.

That's it. You should now have a voice pack that sounds like you, loaded into the app, ready to use on screenshots. If a reply ever sounds off (too generic, too aggressive, too soft), that's signal to tweak the relevant mode section in your pack (open Settings, paste an edited JSON, save). The pack is meant to evolve with you.
