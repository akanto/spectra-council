// Mirador's shared/model.ts imports types from the ACP SDK, which a sparse checkout of shared/ doesn't install. The
// plugin API doesn't use them, so they may be anything here.
declare module "@agentclientprotocol/sdk" {
  export type PermissionOption = any;
  export type SessionConfigOption = any;
  export type SessionUpdate = any;
  export type StopReason = any;
  export type ToolCallUpdate = any;
  export type ToolKind = any;
}

declare module "@agentclientprotocol/sdk/unstable" {
  export type PermissionOption = any;
  export type SessionConfigOption = any;
  export type SessionUpdate = any;
  export type StopReason = any;
  export type ToolCallUpdate = any;
  export type ToolKind = any;
}
