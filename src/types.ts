/**
 * 与 @opencode-ai/sdk 对齐的最小类型集
 * （仅保留本扩展用到的字段，字段形状与 SDK types.gen.d.ts 一致）
 */

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export type PartType =
  | "text"
  | "reasoning"
  | "tool"
  | "step-start"
  | "step-finish"
  | "file"
  | "patch"
  | "snapshot"
  | "agent"
  | "subtask"
  | "retry"
  | "compaction";

export interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
  type: PartType;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
}

export type ToolStateStatus = "pending" | "running" | "completed" | "error";

export interface ToolState {
  status: ToolStateStatus;
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  time?: { start: number; end?: number };
  attachments?: Array<Partial<FilePart>>;
}

export interface ToolPart extends PartBase {
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
}

export interface StepStartPart extends PartBase {
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart extends PartBase {
  type: "step-finish";
  reason: string;
  cost?: number;
}

export interface FilePart extends PartBase {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: { type: "file" | "symbol"; path: string };
}

export interface PatchPart extends PartBase {
  type: "patch";
  hash: string;
  files: Array<string>;
}

export interface SnapshotPart extends PartBase {
  type: "snapshot";
  snapshot: string;
}

export interface AgentPart extends PartBase {
  type: "agent";
  name: string;
}

export interface SubtaskPart extends PartBase {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
}

export interface RetryPart extends PartBase {
  type: "retry";
  attempt: number;
}

export interface CompactionPart extends PartBase {
  type: "compaction";
  auto: boolean;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | FilePart
  | PatchPart
  | SnapshotPart
  | AgentPart
  | SubtaskPart
  | RetryPart
  | CompactionPart;

export interface ServerMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  parentID?: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  finish?: string;
  error?: unknown;
}

export interface MessageEntry {
  info: ServerMessage;
  parts: Array<Part>;
}

export interface Session {
  id: string;
  projectID: string;
  directory?: string;
  parentID?: string;
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<FileDiff> };
}

export interface Model {
  id: string;
  name: string;
}

export interface Provider {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  models: Record<string, Model>;
}

export interface Agent {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  builtIn: boolean;
  model?: { modelID: string; providerID: string };
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface ToolPermission {
  id: string;
  type: string;
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}