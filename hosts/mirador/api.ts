/**
 * Mirador's canvas plugin API, version 5, as this plugin uses it. Mirador doesn't publish these types, so this is a copy
 * of the parts of its shared/canvas-plugins.ts and of the `window.mirador` bridge in its shared/canvas-document.ts that
 * we need. Nothing outside hosts/mirador/ may import it: core/ and view/ don't know about Mirador.
 */

export type PluginItemPlacement = "page" | "tab";

/** A kind of item a plugin's canvas view draws. */
export interface PluginItemType<Data = unknown> {
  /** A character or two, for the canvas's list of pages and its header. */
  icon: string;
  placement: PluginItemPlacement;
  count?(data: Data): string;
  /** What came of the item in a few words, shown beside its title in the canvas's bar and list. */
  outcome?(data: Data): string | undefined;
  /** A new item takes room and shows the canvas if it was hidden. */
  opensWithRoom?: boolean | { setting: string };
  /** The item's data as the canvas lists it, e.g. without a run that Mirador's restart cut short. */
  listed?(item: PluginItem<Data>): Data;
}

export interface PluginItem<Data = unknown> {
  id: string;
  type: string;
  title: string;
  data: Data;
  createdAt: number;
  dismissed: boolean;
  agentEditedAt: number | null;
}

export interface CanvasPluginStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface CanvasPluginContext<Data = unknown> {
  conversationId: string;
  items(): PluginItem<Data>[];
  change(itemId: string, change: { title?: string; data?: Data }): PluginItem<Data>;
  storage: CanvasPluginStorage;
  profileSetting(id: string): string | null;
}

export interface CanvasActionContext<Data = unknown> extends CanvasPluginContext<Data> {
  prompt(text: string, options?: { afterTurn?: boolean }): Promise<void>;
}

export interface StartedConversation {
  id: string;
  profile: string;
}

export interface ConversationReply {
  text: string | null;
  ended: "finished" | "stopped" | "failed";
}

export interface CanvasToolContext<Data = unknown> extends CanvasPluginContext<Data> {
  publish(item: { type: string; title: string; data: Data }): PluginItem<Data>;
  prompt(text: string, options?: { afterTurn?: boolean }): Promise<void>;
  /** Starts a conversation in this one's workspace on the named profile (API 5); the host's `replied` hears when it ends. */
  startConversation(start: { profile: string; prompt: string }): Promise<StartedConversation>;
}

export interface CanvasTool<Data = unknown> {
  description: string;
  /** JSON Schema of an object, which Mirador checks before calling run. */
  input: Record<string, unknown>;
  run(input: unknown, context: CanvasToolContext<Data>): string | Promise<string>;
  onDemand?: boolean;
}

export interface CanvasPluginNote {
  text: string;
  heard(): void;
}

/** What the canvas host module exports. Mirador calls it in its own process; what a call throws goes to whoever caused it. */
export interface CanvasHost<Data = unknown> {
  items: Record<string, PluginItemType<Data>>;
  tools: Record<string, CanvasTool<Data>>;
  guidance?: { instructions?: string; often?: string };
  action?(item: PluginItem<Data>, action: unknown, context: CanvasActionContext<Data>): unknown;
  note?(context: CanvasPluginContext<Data>): CanvasPluginNote | null;
  /**
   * Once, when a conversation a tool started ends its first turn, or the turn a restart of Mirador resumed it in. Its
   * `context` addresses the conversation the started one belongs to — the one whose tool started it — and its `prompt`
   * speaks in the plugin's voice (Mirador 0.8.0 on, plugin API 5): the plugin relies on both to tell a review's own
   * conversation what came of its fixer or of a reviewer's late reply. A fixer conversation is kept on no record of
   * ours, so for it this is the only pin on the telling's aim. With `tellsCaller` in plugin.json, a Mirador newer than
   * 0.12.0 doesn't notify the user of that turn's end; an older one ignores the field and notifies as well.
   */
  replied?(started: StartedConversation, reply: ConversationReply, context: CanvasActionContext<Data>): void | Promise<void>;
}

/** What a plugin item's view gets besides the item. */
export interface PluginItemContext {
  seenAgentEditAt: number | null;
  imagesFromOtherSites: boolean;
  fullscreen?: boolean;
  typingAids?: { autocorrect: boolean; predictions: boolean };
}

/** `window.mirador` in a plugin's canvas view. */
export interface PluginViewBridge<Data = unknown> {
  onItem(listener: (item: PluginItem<Data>, context: PluginItemContext) => void): () => void;
  send(action: unknown): Promise<unknown>;
  prompt(text: string): Promise<void>;
  setFullscreen(on: boolean): void;
  openFile?(path: string): void;
}
