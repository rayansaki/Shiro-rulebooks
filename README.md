# Shiro Rulebooks

Slow-burn relationship meters for SillyTavern. A character stuck in "mean mode" because their card says so can actually warm up, earn trust, fall in love, or turn on you, one turn at a time.

**Status: first prototype (0.1.0).** It works end to end, but expect rough edges.

## How it works

Three parts, each with one job:

| Who | Sees | Does |
|---|---|---|
| **Your main model** | Your preset and card as usual, plus a short note about where the character stands now | Writes the reply. Never sees or sets a number. |
| **The judge** (a cheap model) | The latest exchange, the current levels, recent major events and the previous turn's verdict, plus (in Full mode) the card, persona, lorebook entries and earlier messages | Says which events happened and how serious each was. Never sets a number. |
| **The extension** | The rulebook, the last snapshot and the judge's answer | Does the maths, picks levels, saves a snapshot on the reply, writes the note. |

The note only covers levels that have changed since the start, because the card already describes the starting point:

```
[Where Ashley stands with Rayan now. This replaces how Ashley's character sheet says Ashley treats Rayan. …]
- Mean ↔ Kind (began Cruel, now Prickly): The sarcasm is teasing now, not cruel. …
- Recent (2 turns ago): caught him lying. Ashley is still affected by it.
```

### Rules that keep it fair

- **Rated by seriousness.** The judge rates each event trivial, minor, serious or severe. The rulebook decides what each level is worth: a white lie is −3 Trust only, while cheating hits Trust, Affection, Love and Kind at once.
- **Slow gains.** Each meter can gain at most 5 points a turn from ordinary events. Serious and severe losses (as set per event) ignore the cap, so betrayals land in full.
- **Hard to reach the extremes.** Within the last 20% of a meter's range, gains shrink.
- **Levels don't flicker.** A level only changes once the value is 5 points past its edge.
- **Gates.** Love stays locked until Affection reaches 50, and stays unlocked after that.
- **Expected behaviour isn't news.** The judge scores what you choose to do, and the character acting *against or beyond* their current level. A submissive character kneeling scores nothing, so meters can't feed themselves.
- **Only what the character knows.** Your inner narration is never evidence. A lie counts when it's discovered.
- **One turn of hindsight.** Each judgement may cancel or re-rate the previous turn's events. If she kneels and you say "no, today I kneel for you", the first turn is cancelled and your yielding counts. The correction is saved on the later reply, so swiping that reply away undoes it.
- **No decay or resting points.** Values only move through events.

### Swipes, regenerate, continue, impersonate

- Every reply stores its own snapshot, per swipe, so swiping back and forth always shows the right values.
- **Swipe and regenerate:** the note is built from the state *before* that reply.
- **Continue:** re-judges the whole reply as the same turn.
- **Impersonate and quiet generations** (including Guided Generations) are never judged and never get the note.

### Switching it off

The switch in the window turns the rulebook off for that chat: no judge calls, no note and no chips, so the chat runs exactly as it would without the extension. The meters keep their values and carry on when you switch it back on. Turns played while it was off aren't scored.

## Install

Extensions → Install extension → `https://github.com/rayansaki/Shiro-rulebooks`

Needs SillyTavern 1.19 or later, with the built-in **Connection Manager** extension enabled (the judge borrows a connection profile's API, model and key).

## Setup

1. **Make a connection profile for the judge**, for example Gemini 3.8 Flash or GLM 5.3 Flash on OpenRouter. Only its API, model and key are used. The judge always uses the extension's own prompt, temperature (0.2 by default), reasoning setting and token limit, never the profile's preset.
2. **Pick it** in Extensions → Rulebook → Judge → Model.
3. **Assign a rulebook to a character** under "Which rulebook each character uses", or attach one to any chat from the Rulebook window (wand menu → Rulebook, or `/rulebook`).
4. **Starting a new chat** with an assigned character attaches the rulebook and asks the assessor where the character starts. You can adjust each value before the chat starts.
5. **Attaching to a chat that's already under way** runs the assessment twice. The first run reads only the card and persona: where the card puts the character, which becomes the starting point the note compares against. The second run also reads the lorebook entries and the story so far, and is told the first run's values: where the story has taken the character, which becomes the current values. The dialog shows both (**Card** and **Now**) for you to adjust, and the note speaks from the very first turn.
6. **Reassess the starting point** (a button in the Rulebook window, or `/rulebook reassess`) runs the assessment again at any time. In a chat with judged turns, it resets the starting point and adjusts the current values.
7. **Keep your Post History last:** the note goes in at depth 0 with role user, in SillyTavern's order-100 group for in-chat prompts; an extension can't change that. At the same depth, a **higher** order is placed **closer to the end**, and prompts in the same group come before the note. So if your Post History is an in-chat prompt with order 100, the note lands after it. Give Post History (and anything else that must come after the note, like a tracker prompt) an injection order **above** 100 in the prompt manager, for example Tracker 101 and Post History 102.

## The windows

All windows can be dragged by their header and resized from any edge or corner. Position and size are remembered per browser.

- **Rulebook:** an on/off switch for the chat, Lean or Full judge context, the meters with this turn's changes, the status, a preview of the note, and buttons to re-judge the last turn, show the trace, adjust values, edit the rulebook or detach it.
- **Starting point:** the assessment to confirm, with a slider and the assessor's reason for each meter (Card and Now side by side for a chat already under way).
- **Adjust values:** change the current values by hand. The starting point stays as it was.
- **Rulebook builder:** makes, edits, imports, exports and deletes rulebooks. Open it from the wand menu (**Rulebook builder**), the **Edit rulebook** button in the Rulebook window, the settings drawer, or `/rulebook builder`.
  - **Overview:** name, the meter shown in the status line, the limits, and a live list of problems.
  - **Meters:** name, ID, colour, range and fallback start, a bar of the levels across the range, when it becomes available (from the start, or once another meter reaches a value), drifting back after quiet turns, the fast-meter option, per-meter limits, and the levels with their instructions.
  - **Events:** searchable; what the judge is told, a table of what each severity does to each meter (a column per meter in the rulebook; numbers, or `=N` to set), the cap and journal thresholds and **Always counts**.
  - **JSON:** the rulebook exactly as stored; edit or paste it and Apply.
  - Changes stay as unsaved edits until **Save**, which won't save a rulebook with problems. **Undo changes** goes back to the saved version. Renaming a meter's ID updates every event, unlock rule and the status line; deleting a meter removes its effects everywhere. Importing a rulebook with the same name or ID offers to replace the existing one.
- **Trace:** the last judgement or assessment: the prompt sent, the raw answer, the events, any revision, and the maths for each meter.

**Chips** under each judged reply show what changed and why (`Trust −3 · lied about the milk (trivial)`), in whole numbers (the maths keeps the exact values). On the newest judged turn you can tap a chip to swap it for a different event, change its severity, or remove it; the maths is redone.

## Rulebook format

See `src/defaults.js` for the bundled **Slow burn** rulebook. In short:

```jsonc
{
  "name": "Slow burn",
  "statusMeter": "kindness",                 // which meter's level gives the status line
  "limits": { "gainCap": 5, "levelMargin": 5, "softZone": 0.2, "recentTurns": 8 },
  "meters": [
    { "id": "kindness", "label": "Mean ↔ Kind", "min": -100, "max": 100, "start": 0, "color": "#3fbf9b",
      "levels": [ { "from": -100, "name": "Cruel", "status": "Walls up", "instruction": "{{char}} treats {{user}} with open contempt…" }, … ] },
    { "id": "love", …, "gate": { "meter": "affection", "min": 50 } }
  ],
  "events": {
    "dishonesty": {
      "description": "{{user}} lies to {{char}} … and {{char}} knows or finds out.",
      "bypassCapFrom": "serious",            // from this severity up, the per-turn cap doesn't apply
      "journalFrom": "serious",              // from this severity up, it's listed as a recent major event (once while it's recent; again only if it escalates)
      "effects": { "trivial": { "trust": -3 }, "severe": { "trust": -100, "affection": -40, "love": -30, "kindness": -25 } }
    }
  }
}
```

Levels are listed by where they start (`from`); the last one runs to `max`. Instructions use `{{char}}` and `{{user}}`, so one rulebook works for any character. A level with an empty instruction sends nothing.

Optional, per meter (for fast-moving meters like arousal):

- `gainCap`, `softZone`, `levelMargin`: override the rulebook's `limits` for this meter (`softZone: 0` turns off the slowdown near the ends).
- `cooldown` (on an event): `{ "arousal": { "turns": 3, "cap": 0 } }` stops that meter rising by more than `cap` a turn for the next `turns` judged turns after the event (0 blocks gains entirely). Drops and drifting back still apply; a new cooldown only replaces a running one if it lasts longer. A plain number (`{ "arousal": 3 }`) means that many turns with no gains. Removing or swapping the event on its chip removes its cooldown.
- `fade`: `{ "amount": 10, "to": 0, "after": 3 }` moves the meter towards `to` by `amount` on each judged turn once it has gone more than `after` turns in a row without any event touching it (so with `after: 3` the first fade comes on the 4th quiet turn). Any event that touches the meter resets the count. Leave `after` out (or 0) to fade on every quiet turn. For time jumps, add an event like `time_skip` that lowers the meter directly.
- Replies with no text (for example a reply that only called an image tool) are never judged, so they don't count as a turn.
- `transient: true`: a state of the moment rather than a trait. The note always describes its current level (even its starting level, since the card's opening scene doesn't cover it later on) and says just the level ("Arousal (Warm)") instead of "began X, now Y".

Optional, per event:

- An effect of `"=N"` sets the meter to N instead of changing it (applied after other changes that turn), e.g. `"arousal": "=0"` for a climax.
- `always: true`: the judge scores it whenever it happens, whoever starts it, even when it fits the character's current level (the "expected behaviour isn't news" rule doesn't apply).

`rulebooks/` has ready-made rulebooks to import: **Slice of life + arousal** (Trust, Respect, Hate ↔ Love, Sub ↔ Dom, and a fast Arousal meter that starts fading after 3 quiet turns, drops on time skips, and resets on the character's climax, with a 3-turn cooldown before it can build again).

## Where things are stored

- **Rulebooks, assignments and settings:** extension settings (nothing is written to character cards).
- **The chat's rulebook, its on/off state and its starting point:** chat metadata.
- **Snapshots:** on each reply, in `extra.shuri_rulebook` (and that swipe's copy).

The storage keys keep the extension's earlier name (`shuri_…`) so saved rulebooks, chats and snapshots carry over.

## Known limits of this prototype

- One-to-one chats only (no group chats).
- Only the newest judged turn's chips can be changed by hand.
- **Reasoning:** Off, Minimal, Low or Model default. Off asks the provider for no reasoning, but some providers think anyway (seen with GLM 5.3 Flash via Relace), and some models can only reduce it (Gemini 3.8 Flash still used about 1,100 hidden tokens with Off). Thinking counts towards **Max tokens** (default 5,000, shared by the judge and the assessment), so leave plenty of headroom: the answer itself is about 50 tokens for the judge and a few hundred for the assessment. A cut-off answer shows a clear error and isn't retried. If a provider rejects the reasoning setting outright, the call is retried once without it, and the trace says so.

## Development

```
npm test   # engine tests (Node 20+)
```
