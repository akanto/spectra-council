# What Spectra Council needs from Mirador's plugin API

Real reviewers run as conversations that a plugin starts (`CanvasToolContext.startConversation`). Plugin API 8 brought
what this list asked for first: a started conversation's `title`, `model` and `effort`, which the plugin now uses. Since
then Mirador has also shipped `stopConversation` (API 10, section 3), which the plugin uses when a review stops, and the
`activity` hook (API 6, section 5), which it doesn't use yet. These are the extensions that would make reviewers better,
most important first.

## 1. The models and efforts a profile offers

**What:** the choices of a profile's model and effort options, e.g. `profiles()` (section 4) with
`models: { value: string; name: string }[]` and `efforts` alike.

**Why:** the setup offers each seat the models its profile's agent offers. Today the plugin reads them from the config
options of the profile's latest conversation in Mirador's database (`hosts/mirador/records.ts`), so a profile with no
conversation yet offers none, and the user types a model's name instead.

## 2. Starting conversations from a view action

**What:** `startConversation` on `CanvasActionContext`, so the view's Start button can start reviewers directly.

**Why:** Today the plugin keeps the tool context of the latest tool call in that conversation, and starts conversations
through it after the tool has returned. Mirador's implementation allows this, but the API doesn't promise it. After a
Mirador restart there is no kept context, so Start asks the agent to call `council_begin` first.

**Sketch:** the same call tools have now, on the action context:

```ts
startConversation(start: { profile: string; prompt: string }): Promise<StartedConversation>;
```

It keeps the same rule: a conversation a plugin started can't start more.

## 3. Stopping a started conversation (done)

Done in Mirador's plugin API 10: `stopConversation(conversationId)` on both the tool and the action context. A Mirador
older than that lacks it, so the plugin asks for `"api": 8` and checks whether it is there. A stop stops each reviewer
conversation still running; one whose turn already ended is left alone, and so is one the turn's limit gave up on, whose
late reply the user can still fetch. The stopped conversation's `replied` then hears `ended: "stopped"`, which changes
nothing and tells no one.

**What:** `stopConversation(id)` on the plugin context.

The plugin reads the model and effort a conversation runs on from Mirador's database, read-only
(`hosts/mirador/records.ts`), to name each seat by its model while its turn runs. `ConversationReply.ranOn` (API 8)
gives it at the turn's end; an API for it while the turn runs would replace the database read: for example
`conversationModel(id): { model: string; effort: string | null } | null` on the plugin context.

## 4. Listing profiles

**What:** `profiles(): { name: string; harness: string }[]` on the plugin context.

**Why:** The setup offers real profile names instead of free text plus the names seated before. (Today the plugin reads
them, with the model each last ran on, from Mirador's database; `hosts/mirador/records.ts`.) Today a wrong name fails
that seat at Start, and the error lists Mirador's profiles.

**Sketch:**

```ts
profiles(): { name: string; harness: string }[];
```

`name` is the profile's name as Mirador has it (for example "Home" or "pi home"), and `harness` says which agent runs it.

## 5. Progress of a started conversation (partly shipped in API 6, not used yet)

The `activity` hook (API 6) hears every conversation's turn and tool starts and ends, without text or arguments. That is
enough to measure a turn's limit as idle time (spectra-council-9yd), but not to show a real seat's reads and searches
as a mock's panel shows them: that would need the tool call's title or path, e.g. `toolTitle` on "tool-started".

## 6. A promise about tool contexts

**What:** if (2) isn't wanted, document that a tool's context stays usable after the tool returns, and what a `replied`
context addresses.

**Why:** The plugin relies on this for deliberation rounds, proposals and re-checks. Each of them starts conversations
after the tool that began the step has returned. And it tells a review's own conversation what came of its fixer or of a
reviewer's late reply through the `replied` hook's context: that telling must reach the conversation the started
conversation belongs to, in the plugin's voice. Mirador's API docs promise the first half ("the context is the
conversation that started it"), and since Mirador 0.8.0 (plugin API 5, the floor `plugin.json` declares) its `prompt`
speaks in the plugin's voice, though no sentence promises that. The plugin checks the aim where it can (the late reply
against its recorded chair); a fixer conversation, kept on no record of ours, relies on it.

**Sketch:** sentences in the API docs, such as: "A `CanvasToolContext` stays valid for `startConversation`, `change` and
`prompt` after its tool returns, for as long as the conversation exists in this Mirador process." And: "`replied`'s
context's `prompt` speaks in the plugin's voice."

## 7. A started conversation's reply, on demand

**What:** a way to read the reply of a conversation the plugin started, at any time: the agent's last message of its
latest turn and how that turn ended (or that it still runs), as `replied` gives it.

**Why:** `replied` is heard once. When a seat's turn runs past its limit, the plugin keeps the conversation on record
and keeps a reply that comes later, but a reply that came while Mirador or the plugin was down is only in Mirador's
database, which `hosts/mirador/records.ts` reads (`replyOf`) to let the user fetch it into the review.

**Sketch:** `CanvasPluginContext.replyOf(conversationId): ConversationReply | { ended: "running" } | null`.

## 8. No turn-end ping for a conversation whose plugin tells its caller

Done in Mirador after 0.12.0: a plugin whose `plugin.json` says `"tellsCaller": true`, and which has a `replied` hook,
tells the conversation that started a conversation how its first turn ended, so Mirador leaves out its own "turn ended"
notification for that turn. An older Mirador ignores the field, so it needs no newer `"api"`; there the user gets both
the ping and the review's own telling. The field is an opt-in because a plugin with `replied` that doesn't tell its
caller (Spectra Council 0.2.0 and earlier) would otherwise end silently.
