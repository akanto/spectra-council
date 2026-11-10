# What Spectra Council needs from Mirador's plugin API

Real reviewers run as conversations that a plugin starts (plugin API 5, `CanvasToolContext.startConversation({ profile, prompt })`).
These are the extensions that would make them better, most important first.

## 1. Model and effort per started conversation

**What:** `startConversation({ profile, prompt, model?, effort? })`.

**Why:** A started conversation takes its profile's mode and effort (`applyProfileChoices` in `host/conversations.ts`) and
the agent's default model. A profile has no model field. What the user picks in a conversation's header goes through the
session's `setConfigOption`, which plugins can't reach. So a seat can't choose its model, and the setup can't offer one.

**Sketch:** once the session exists, apply `model` with `trySetConfigOption`, matched to the agent's model config option as
`modelChoiceFor` does. Apply `effort` to the `thought_level` option, and skip it when the model doesn't offer it. This is
what `applyProfileChoices` already does for the profile's values. Then a seat is a profile, a model and an effort, and the
setup offers the choices.

```ts
startConversation({ profile: "pi home", prompt, model: "<model id>", effort: "high" });
```

Until then, pin a model per profile in the profile's environment: `ANTHROPIC_MODEL` for Claude Code, or a
`PI_CODING_AGENT_DIR` whose `settings.json` names `defaultModel` for pi. The effort comes from the profile's effort field.

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

## 3. Stopping a started conversation

**What:** `stopConversation(id)` on the plugin context.

**Why:** Stop in the canvas aborts the review, but the reviewers' conversations run on until their turn ends. Their replies
are ignored. The user sees agents still working after they pressed Stop, and they still spend tokens.

**Sketch:**

```ts
stopConversation(conversationId: string): Promise<void>;
```

The turn ends, and the plugin's `replied` hears `ended: "stopped"`.

Until then, the plugin reads the model and effort a conversation runs on from Mirador's database, read-only
(`hosts/mirador/records.ts`), to name each seat by its model. An API for that would replace the database read: for
example `conversationModel(id): { model: string; effort: string | null } | null` on the plugin context.

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

## 5. Progress of a started conversation

**What:** a way to hear a started conversation's tool calls (file reads, searches) as they happen.

**Why:** A seat shows only "asked", "started conversation …" and the result at the end of each turn. A mock's panel shows
each read and search as it happens. A real seat's panel should too.

**Sketch:** a hook beside `replied`, called for each step the conversation takes:

```ts
activity?(started: StartedConversation, step: { kind: "read" | "search" | "tool" | "message"; text: string; at: number }, context: CanvasActionContext): void;
```

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
notification for that turn. An older Mirador ignores the field, so the plugin keeps `"api": 5`; there the user gets both
the ping and the review's own telling. The field is an opt-in because a plugin with `replied` that doesn't tell its
caller (Spectra Council 0.2.0 and earlier) would otherwise end silently.
