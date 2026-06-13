# Unicorn Pocket — 5-minute quick start

The fastest path from "a friend sent me a link" to "I just copied my first reply." If you want the full reference (every setting, GPT, privacy, troubleshooting), see **setup.md** — but you don't need it to get going.

**Live:** https://slysfearx.github.io/unicorn-pocket/

What it does: you screenshot a dating-app conversation, pick a vibe, and get three reply options that sound like you. You copy the one you like and paste it back into the dating app. No server, no signup — everything stays on your phone.

---

## ① Install it (30 sec) — iPhone, Safari

1. Open the link above **in Safari** (not Chrome — iOS only installs web apps from Safari).
2. Tap the **Share** button (the square with the up-arrow ⬆).
3. Scroll down, tap **Add to Home Screen**, then **Add**.
4. Open the new **Unicorn** icon from your home screen. It now behaves like a real app.

## ② Pick a voice (10 sec)

The first time it opens you'll see a **Welcome to Pocket** card. Tap:

> **Use starter voice (anonymous, 2 sec)**

That loads a friendly, neutral texting voice so you can start immediately. (You can build a voice from your *own* messages later — it makes replies sound much more like you — but skip that for now.)

## ③ Add your API key (~2 min)

Pocket uses Claude to read the screenshot and write replies, on **your own** key — so the next step is pasting one in.

1. Go to **console.anthropic.com** → sign in → **API Keys** → **Create Key**. Copy it (it starts with `sk-ant-`).
   - New accounts usually get a few dollars of free credit — enough for hundreds of replies.
2. Back in Pocket, you'll be on the **key entry** step (or tap the ⚙️ gear → paste into **Anthropic API key**).
3. Paste the key. Make sure there's no extra space at the start or end.

## ④ Confirm it works (10 sec) — the "Test connection" button

Tap **Test connection**.

- **Green ✓ "Claude key works"** → you're ready. 🎉
- **Red message** → it tells you exactly what's wrong (usually: re-paste the key, or add credit at console.anthropic.com). Fix it and tap Test again.

This is the whole point of the button: you *know* you're set up before you try a real conversation, no guessing.

## ⑤ Your first reply (30 sec)

On the main screen:

1. **Add a screenshot** — tap **📋 Paste screenshot** (after copying one), or **Tap to add screenshots from your camera roll**. Add up to 6 if the thread spans several shots (oldest → newest).
2. *(Optional)* tap a **voice mode** (Tourist / Kink / Long / Go) or type a **Note** to steer it ("keep it short", "ask her out Friday"). No mode = your default voice.
3. Tap **Generate replies**. Three options come back.
4. Tap **Copy** on the one you like, switch to the dating app, and paste.

That's the entire loop: **screenshot → Generate → Copy.** Three taps once you're set up.

---

## Make it land (the good stuff)

Once the basic loop clicks, these are what make Unicorn actually *good* — try them once you've got a real conversation going:

- **Not quite right? Refine in one tap.** Under your three options, tap **Shorter**, **Bolder**, **Funnier**, **More curious**, or **Make a move** to get a fresh set nudged that way — or **🔄 New options** for a different take. Tap **Edit** on any option to tweak the wording first; what you copy is exactly what you edited.
- **🔍 Read the room.** Not sure where you stand? Tap **Read the room** (under Generate) for a quick, honest coach's read of the screenshot: her interest level, what's working or stalling, and one concrete next move. It doesn't write the reply — it tells you how to play it.
- **🎚 Tune your voice.** Replies sound a little off? Settings → **Tune my voice** → say what to fix in one line ("too formal", "I'd never say buddy", "more playful"). One tap updates your voice, and it sticks.
- **Track what lands.** In **History** (🕘), tap 💚 / 🚫 / 👻 on a past reply to mark whether she answered. After a few, Unicorn shows you **which voice gets the most replies** — so you can lean on what actually works.

---

## You're done. Optional extras (later)

- **Prefer GPT over Claude?** In Settings, pick a **GPT-4o** model, add your OpenAI key, and tap **"Use the shared circle proxy"** (one tap — no deploying anything; it still runs on your own OpenAI key). Full steps in **setup.md** §5.
- **Make it sound like *you*.** Build a personal voice pack from your real messages (~15 min, once). First-run **"Build my own"** button, or **setup.md** §9.
- **Get updates.** Force-close the app and reopen it twice — the new version swaps in on the second open (a PWA quirk).
- **Send feedback that helps.** History (🕘) → **Export history (JSON)** → share the file with whoever sent you Pocket. It carries your screenshots, which reply you picked, and anonymous usage counts — exactly what's needed to tune the voice. Nothing leaves your phone unless you export it.

---

*Full reference: [setup.md](setup.md) · Build your own voice: [voice-pack-from-your-messages.md](voice-pack-from-your-messages.md) · Live: https://slysfearx.github.io/unicorn-pocket/*
