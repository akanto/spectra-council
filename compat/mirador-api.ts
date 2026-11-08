/**
 * hosts/mirador/api.ts is a hand copy of Mirador's plugin API; this file checks it still fits Mirador's own types, at
 * compile time, against a Mirador checkout ("mirador-shared/" resolves to its shared/ folder; scripts/api-compat.ts
 * typechecks it). What Mirador hands the plugin must fit our copy (we may use less of it); what the plugin hands
 * Mirador must fit Mirador's. A type error here names the field where they disagree.
 */
import type * as Ours from "../hosts/mirador/api.ts";
import type * as Plugins from "mirador-shared/canvas-plugins.ts";
import type * as Document from "mirador-shared/canvas-document.ts";

/** Any review data will do: the API is generic over it. */
type Data = { review: string };

/** What Mirador hands the plugin: its types must be usable as ours. */
export const fromMirador = {
  placement: (x: Plugins.PluginItemPlacement): Ours.PluginItemPlacement => x,
  item: (x: Plugins.PluginItem<Data>): Ours.PluginItem<Data> => x,
  storage: (x: Plugins.CanvasPluginStorage): Ours.CanvasPluginStorage => x,
  pluginContext: (x: Plugins.CanvasPluginContext<Data>): Ours.CanvasPluginContext<Data> => x,
  actionContext: (x: Plugins.CanvasActionContext<Data>): Ours.CanvasActionContext<Data> => x,
  toolContext: (x: Plugins.CanvasToolContext<Data>): Ours.CanvasToolContext<Data> => x,
  started: (x: Plugins.StartedConversation): Ours.StartedConversation => x,
  reply: (x: Plugins.ConversationReply): Ours.ConversationReply => x,
  itemContext: (x: Document.PluginItemContext): Ours.PluginItemContext => x,
  bridge: (x: Document.PluginViewBridge<Data>): Ours.PluginViewBridge<Data> => x,
};

/** What the plugin hands Mirador: ours must be usable as Mirador's. */
export const toMirador = {
  placement: (x: Ours.PluginItemPlacement): Plugins.PluginItemPlacement => x,
  itemType: (x: Ours.PluginItemType<Data>): Plugins.PluginItemType<Data> => x,
  tool: (x: Ours.CanvasTool<Data>): Plugins.CanvasTool<Data> => x,
  note: (x: Ours.CanvasPluginNote): Plugins.CanvasPluginNote => x,
  host: (x: Ours.CanvasHost<Data>): Plugins.CanvasHost<Data> => x,
  reply: (x: Ours.ConversationReply): Plugins.ConversationReply => x,
};

/*
 * Methods compare their parameters both ways in TypeScript, so the checks above miss a parameter that changed. These
 * compare them one way, as tuples: the arguments we pass Mirador's functions must fit what Mirador's take; the arguments
 * Mirador passes our functions must fit what ours take.
 */
type Args<F> = F extends (...args: infer A) => unknown ? A : never;
type OurContext = Ours.CanvasToolContext<Data> & Ours.CanvasActionContext<Data>;
type TheirTool = Plugins.CanvasToolContext<Data>;
type TheirAction = Plugins.CanvasActionContext<Data>;

/** Mirador's functions, as we call them. */
export const weCall = {
  items: (x: Args<OurContext["items"]>): Args<TheirTool["items"]> => x,
  change: (x: Args<OurContext["change"]>): Args<TheirTool["change"]> => x,
  storageGet: (x: Args<Ours.CanvasPluginStorage["get"]>): Args<Plugins.CanvasPluginStorage["get"]> => x,
  storageSet: (x: Args<Ours.CanvasPluginStorage["set"]>): Args<Plugins.CanvasPluginStorage["set"]> => x,
  profileSetting: (x: Args<OurContext["profileSetting"]>): Args<TheirTool["profileSetting"]> => x,
  toolPrompt: (x: Args<Ours.CanvasToolContext<Data>["prompt"]>): Args<TheirTool["prompt"]> => x,
  actionPrompt: (x: Args<Ours.CanvasActionContext<Data>["prompt"]>): Args<TheirAction["prompt"]> => x,
  publish: (x: Args<Ours.CanvasToolContext<Data>["publish"]>): Args<TheirTool["publish"]> => x,
  startConversation: (x: Args<Ours.CanvasToolContext<Data>["startConversation"]>): Args<TheirTool["startConversation"]> => x,
  heard: (x: Args<Ours.CanvasPluginNote["heard"]>): Args<Plugins.CanvasPluginNote["heard"]> => x,
  onItem: (x: Args<Ours.PluginViewBridge<Data>["onItem"]>): Args<Document.PluginViewBridge<Data>["onItem"]> => x,
  send: (x: Args<Ours.PluginViewBridge<Data>["send"]>): Args<Document.PluginViewBridge<Data>["send"]> => x,
  viewPrompt: (x: Args<Ours.PluginViewBridge<Data>["prompt"]>): Args<Document.PluginViewBridge<Data>["prompt"]> => x,
  setFullscreen: (x: Args<Ours.PluginViewBridge<Data>["setFullscreen"]>): Args<Document.PluginViewBridge<Data>["setFullscreen"]> => x,
  openFile: (x: Args<NonNullable<Ours.PluginViewBridge<Data>["openFile"]>>): Args<NonNullable<Document.PluginViewBridge<Data>["openFile"]>> => x,
};

/** Our functions, as Mirador calls them. */
export const miradorCalls = {
  count: (x: Args<NonNullable<Plugins.PluginItemType<Data>["count"]>>): Args<NonNullable<Ours.PluginItemType<Data>["count"]>> => x,
  outcome: (x: Args<NonNullable<Plugins.PluginItemType<Data>["outcome"]>>): Args<NonNullable<Ours.PluginItemType<Data>["outcome"]>> => x,
  listed: (x: Args<NonNullable<Plugins.PluginItemType<Data>["listed"]>>): Args<NonNullable<Ours.PluginItemType<Data>["listed"]>> => x,
  run: (x: Args<Plugins.CanvasTool<Data>["run"]>): Args<Ours.CanvasTool<Data>["run"]> => x,
  action: (x: Args<NonNullable<Plugins.CanvasHost<Data>["action"]>>): Args<NonNullable<Ours.CanvasHost<Data>["action"]>> => x,
  note: (x: Args<NonNullable<Plugins.CanvasHost<Data>["note"]>>): Args<NonNullable<Ours.CanvasHost<Data>["note"]>> => x,
  replied: (x: Args<NonNullable<Plugins.CanvasHost<Data>["replied"]>>): Args<NonNullable<Ours.CanvasHost<Data>["replied"]>> => x,
};
