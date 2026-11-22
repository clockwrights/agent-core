/**
 * Test helpers for tool-agent runs: deterministic scripted/replayed models,
 * a recorder that captures real model responses as a cassette, a recording
 * tool wrapper, and an event collector.
 *
 * Imported from the `@maya-ai/tool-agent-runtime/testing` subpath so the
 * main entry point stays free of test-only code.
 *
 * Models are plain pi-ai `Model` objects backed by a provider registered in
 * pi-ai's API registry under a unique `api` id, so `runToolAgent` drives them
 * exactly like a real provider. Call `dispose()` when done.
 */

import {
  createAssistantMessageEventStream,
  registerApiProvider,
  streamSimple,
  unregisterApiProviders,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TSchema,
  type Usage,
} from "@mariozechner/pi-ai";
import type { AgentEventSink } from "./loop.js";
import type { AgentEvent, AgentTool, AgentToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Cassette format
// ---------------------------------------------------------------------------

/** Version of the cassette format written by `createModelRecorder`. */
export const CASSETTE_VERSION = 1;

/**
 * Shape of the conversation a model call received. Recorded alongside each
 * response so a replay can detect that the code under test now sends a
 * different conversation than when the cassette was recorded.
 * Prompts and message contents are deliberately not stored.
 */
export interface RequestFingerprint {
  messageCount: number;
  lastRole: Message["role"] | null;
  toolNames: string[];
}

export interface CassetteStep {
  request?: RequestFingerprint;
  response: AssistantMessage;
}

/** Serializable record of model responses. Holds model output only. */
export interface ModelCassette {
  version: typeof CASSETTE_VERSION;
  steps: CassetteStep[];
}

// ---------------------------------------------------------------------------
// Scripted / replay model
// ---------------------------------------------------------------------------

/** What a scripted model returns for one call. */
export type ReplayStep =
  | AssistantMessage
  | CassetteStep
  | ((context: Context, callIndex: number) => AssistantMessage | Promise<AssistantMessage>);

export interface ReplayModelOptions {
  /**
   * When a step carries a recorded `request` fingerprint, compare it with
   * the live request and fail the call on mismatch. Default: true.
   */
  checkRequests?: boolean;
  /** Model id reported on the returned model and messages. Default "replay". */
  modelId?: string;
}

/** Non-secret stream options recorded by a replay model. */
export interface RecordedCallOptions {
  reasoning?: SimpleStreamOptions["reasoning"];
  maxTokens?: number;
  sessionId?: string;
  transport?: SimpleStreamOptions["transport"];
  hasSignal: boolean;
}

export interface ReplayModel {
  /** Pass this to `runToolAgent` as `model`. */
  model: Model<string>;
  /** Snapshot of every context the model received, in call order. */
  readonly calls: Context[];
  /**
   * Stream options of every call, in call order. Only non-secret fields are
   * kept: never `apiKey`, `headers` or the signal.
   */
  readonly callOptions: RecordedCallOptions[];
  /** Number of scripted steps not yet consumed. */
  readonly remaining: number;
  /** Unregister the backing provider. */
  dispose(): void;
}

/**
 * Create a model that answers each call with the next scripted step.
 * Streams deterministically (one delta per content block). When the script
 * runs out, or a recorded request fingerprint does not match, the call ends
 * with `stopReason: "error"` and an explanatory `errorMessage`.
 * Honours `AbortSignal`: an aborted call ends with `stopReason: "aborted"`.
 */
export function createReplayModel(
  steps: readonly ReplayStep[] | ModelCassette,
  options: ReplayModelOptions = {},
): ReplayModel {
  const script: ReplayStep[] = isCassette(steps) ? [...steps.steps] : [...steps];
  const checkRequests = options.checkRequests ?? true;
  const calls: Context[] = [];
  const callOptions: RecordedCallOptions[] = [];
  const { api, sourceId } = uniqueApi("replay");
  const model = syntheticModel(api, options.modelId ?? "replay");

  const streamFn = (_m: Model<string>, context: Context, streamOptions?: SimpleStreamOptions) => {
    const out = createAssistantMessageEventStream();
    const callIndex = calls.length;
    calls.push(snapshotContext(context));
    callOptions.push({
      reasoning: streamOptions?.reasoning,
      maxTokens: streamOptions?.maxTokens,
      sessionId: streamOptions?.sessionId,
      transport: streamOptions?.transport,
      hasSignal: streamOptions?.signal !== undefined,
    });
    const step = script.shift();

    void (async () => {
      try {
        if (streamOptions?.signal?.aborted) {
          finish(out, abortedMessage(model, []));
          return;
        }
        if (step === undefined) {
          finish(out, errorMessage(model, `Replay model has no scripted response for call ${callIndex + 1}`));
          return;
        }
        let response: AssistantMessage;
        if (typeof step === "function") {
          response = await step(context, callIndex);
        } else if (isCassetteStep(step)) {
          if (checkRequests && step.request) {
            const mismatch = compareFingerprint(step.request, fingerprintContext(context));
            if (mismatch) {
              finish(out, errorMessage(model, `Replay request mismatch on call ${callIndex + 1}: ${mismatch}`));
              return;
            }
          }
          response = step.response;
        } else {
          response = step;
        }
        await streamMessage(out, adoptMessage(model, response), streamOptions?.signal);
      } catch (err) {
        finish(out, errorMessage(model, err instanceof Error ? err.message : String(err)));
      }
    })();

    return out;
  };

  registerApiProvider({ api, stream: streamFn, streamSimple: streamFn }, sourceId);

  return {
    model,
    calls,
    callOptions,
    get remaining() {
      return script.length;
    },
    dispose: () => unregisterApiProviders(sourceId),
  };
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface ModelRecorder {
  /** Pass this to `runToolAgent` as `model`; calls go to the wrapped model. */
  model: Model<string>;
  /** The responses recorded so far, as a replayable cassette. */
  cassette(): ModelCassette;
  /** Unregister the backing provider. */
  dispose(): void;
}

/**
 * Wrap a real model so every response is recorded. Replay the result with
 * `createReplayModel(recorder.cassette())`. The cassette holds model output
 * and request fingerprints only — never prompts, tool results or API keys —
 * but model output can still echo user data, so review cassettes before
 * committing them.
 */
export function createModelRecorder(target: Model<any>): ModelRecorder {
  const steps: CassetteStep[] = [];
  const { api, sourceId } = uniqueApi("record");
  // Same metadata as the target, routed to the recording provider. The target
  // itself (with its own api and compat settings) is what actually streams.
  const model = { ...target, api } as unknown as Model<string>;

  const streamFn = (_m: Model<string>, context: Context, streamOptions?: SimpleStreamOptions) => {
    const out = createAssistantMessageEventStream();
    const request = fingerprintContext(context);

    void (async () => {
      try {
        const inner = streamSimple(target, context, streamOptions);
        for await (const event of inner) out.push(event);
        const response = await inner.result();
        steps.push({ request, response: structuredClone(response) });
        out.end(response);
      } catch (err) {
        finish(out, errorMessage(model, err instanceof Error ? err.message : String(err)));
      }
    })();

    return out;
  };

  registerApiProvider({ api, stream: streamFn, streamSimple: streamFn }, sourceId);

  return {
    model,
    cassette: () => ({ version: CASSETTE_VERSION, steps: structuredClone(steps) }),
    dispose: () => unregisterApiProviders(sourceId),
  };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export interface ReplyOptions {
  usage?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };
  stopReason?: AssistantMessage["stopReason"];
}

/** Assistant reply containing text (and optional extra blocks). */
export function replyText(text: string, options: ReplyOptions = {}): AssistantMessage {
  return reply([{ type: "text", text }], options.stopReason ?? "stop", options);
}

/** Assistant reply that calls one or more tools. */
export function replyToolCalls(
  calls: ReadonlyArray<{ name: string; arguments?: Record<string, any>; id?: string }>,
  options: ReplyOptions & { text?: string } = {},
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];
  if (options.text) content.push({ type: "text", text: options.text });
  calls.forEach((call, i) =>
    content.push({ type: "toolCall", id: call.id ?? `call_${i + 1}`, name: call.name, arguments: call.arguments ?? {} }),
  );
  return reply(content, options.stopReason ?? "toolUse", options);
}

/** Assistant reply representing a provider error. */
export function replyError(message: string, options: ReplyOptions = {}): AssistantMessage {
  return { ...reply([], "error", options), errorMessage: message };
}

function reply(
  content: (TextContent | ThinkingContent | ToolCall)[],
  stopReason: AssistantMessage["stopReason"],
  options: ReplyOptions,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "replay",
    provider: "replay",
    model: "replay",
    usage: { ...zeroUsage(), ...options.usage, cost: { ...zeroUsage().cost, ...options.usage?.cost } },
    stopReason,
    timestamp: 0,
  };
}

// ---------------------------------------------------------------------------
// Recording tool wrapper
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  toolCallId: string;
  params: unknown;
  /** Set when execute resolved. */
  result?: AgentToolResult<any>;
  /** Set when execute threw. */
  error?: string;
  /** Whether a signal was passed and was aborted when execute settled. */
  aborted: boolean;
}

/**
 * Wrap a tool so every `execute` call is recorded (params, result or error).
 * All other tool fields are preserved; errors are re-thrown unchanged.
 */
export function recordTool<P extends TSchema, D>(tool: AgentTool<P, D>): { tool: AgentTool<P, D>; calls: ToolCallRecord[] } {
  const calls: ToolCallRecord[] = [];
  const wrapped = {
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: Parameters<AgentTool<P, D>["execute"]>[3],
    ) => {
      const record: ToolCallRecord = { toolCallId, params: structuredClone(params), aborted: false };
      calls.push(record);
      try {
        const result = await tool.execute(toolCallId, params as never, signal, onUpdate);
        record.result = result;
        return result;
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        record.aborted = signal?.aborted === true;
      }
    },
  } as AgentTool<P, D>;
  return { tool: wrapped, calls };
}

// ---------------------------------------------------------------------------
// Event collector
// ---------------------------------------------------------------------------

export interface EventCollector {
  /** Pass this to `runToolAgent` as the event sink. */
  emit: AgentEventSink;
  readonly events: AgentEvent[];
  /** Event types in emission order. */
  types(): AgentEvent["type"][];
  /** Events of one type, narrowed. */
  ofType<K extends AgentEvent["type"]>(type: K): Extract<AgentEvent, { type: K }>[];
}

export function collectEvents(): EventCollector {
  const events: AgentEvent[] = [];
  return {
    emit: (event) => {
      events.push(event);
    },
    events,
    types: () => events.map((e) => e.type),
    ofType: <K extends AgentEvent["type"]>(type: K) =>
      events.filter((e): e is Extract<AgentEvent, { type: K }> => e.type === type),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let apiCounter = 0;

function uniqueApi(kind: string): { api: string; sourceId: string } {
  apiCounter += 1;
  const suffix = `${apiCounter}-${Math.random().toString(36).slice(2, 8)}`;
  return { api: `maya-${kind}-${suffix}`, sourceId: `maya-${kind}-source-${suffix}` };
}

function syntheticModel(api: string, id: string): Model<string> {
  return {
    id,
    name: id,
    api,
    provider: "replay",
    baseUrl: "http://replay.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isCassette(value: unknown): value is ModelCassette {
  return !!value && !Array.isArray(value) && typeof value === "object" && "steps" in value;
}

function isCassetteStep(value: unknown): value is CassetteStep {
  return !!value && typeof value === "object" && "response" in value && !("role" in value);
}

/**
 * Deep copy of a context. Tools are reduced to their model-facing fields:
 * runtime tools carry functions (`execute`), which cannot be cloned.
 */
function snapshotContext(context: Context): Context {
  return {
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
    tools: context.tools?.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: structuredClone(parameters),
    })),
  };
}

export function fingerprintContext(context: Context): RequestFingerprint {
  const last = context.messages[context.messages.length - 1];
  return {
    messageCount: context.messages.length,
    lastRole: last ? last.role : null,
    toolNames: (context.tools ?? []).map((t) => t.name).sort(),
  };
}

function compareFingerprint(expected: RequestFingerprint, actual: RequestFingerprint): string | null {
  const problems: string[] = [];
  if (expected.messageCount !== actual.messageCount) {
    problems.push(`messageCount ${actual.messageCount} (recorded ${expected.messageCount})`);
  }
  if (expected.lastRole !== actual.lastRole) {
    problems.push(`lastRole ${actual.lastRole} (recorded ${expected.lastRole})`);
  }
  if (expected.toolNames.join(",") !== actual.toolNames.join(",")) {
    problems.push(`tools [${actual.toolNames.join(", ")}] (recorded [${expected.toolNames.join(", ")}])`);
  }
  return problems.length ? problems.join("; ") : null;
}

/** Copy a scripted/recorded message onto this model's identity. */
function adoptMessage(model: Model<string>, message: AssistantMessage): AssistantMessage {
  const copy = structuredClone(message);
  return {
    ...copy,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: copy.usage ?? zeroUsage(),
    timestamp: copy.timestamp || Date.now(),
  };
}

function errorMessage(model: Model<string>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function abortedMessage(model: Model<string>, content: AssistantMessage["content"]): AssistantMessage {
  return { ...errorMessage(model, "Request was aborted"), content, stopReason: "aborted" };
}

function finish(out: AssistantMessageEventStream, message: AssistantMessage): void {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    out.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    out.push({ type: "done", reason: message.stopReason, message });
  }
  out.end(message);
}

/** Stream a complete message as start → per-block start/delta/end → done. */
async function streamMessage(
  out: AssistantMessageEventStream,
  message: AssistantMessage,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    finish(out, message);
    return;
  }
  const partial: AssistantMessage = { ...message, content: [] };
  const snapshot = (): AssistantMessage => ({ ...partial, content: partial.content.map((c) => ({ ...c })) });
  out.push({ type: "start", partial: snapshot() });

  for (let i = 0; i < message.content.length; i++) {
    // Yield between blocks so an abort raised by a listener can take effect.
    await Promise.resolve();
    if (signal?.aborted) {
      finish(out, { ...abortedMessage(syntheticFrom(message), snapshot().content) });
      return;
    }
    const block = message.content[i]!;
    const events = blockEvents(block, i, partial, snapshot);
    for (const event of events) out.push(event);
  }
  finish(out, message);
}

function syntheticFrom(message: AssistantMessage): Model<string> {
  return { ...syntheticModel(message.api, message.model), provider: message.provider };
}

function blockEvents(
  block: AssistantMessage["content"][number],
  index: number,
  partial: AssistantMessage,
  snapshot: () => AssistantMessage,
): AssistantMessageEvent[] {
  if (block.type === "text") {
    partial.content.push({ type: "text", text: "" });
    const start = { type: "text_start", contentIndex: index, partial: snapshot() } as const;
    (partial.content[index] as TextContent).text = block.text;
    return [
      start,
      { type: "text_delta", contentIndex: index, delta: block.text, partial: snapshot() },
      { type: "text_end", contentIndex: index, content: block.text, partial: snapshot() },
    ];
  }
  if (block.type === "thinking") {
    partial.content.push({ type: "thinking", thinking: "" });
    const start = { type: "thinking_start", contentIndex: index, partial: snapshot() } as const;
    (partial.content[index] as ThinkingContent).thinking = block.thinking;
    return [
      start,
      { type: "thinking_delta", contentIndex: index, delta: block.thinking, partial: snapshot() },
      { type: "thinking_end", contentIndex: index, content: block.thinking, partial: snapshot() },
    ];
  }
  partial.content.push({ ...block, arguments: {} });
  const start = { type: "toolcall_start", contentIndex: index, partial: snapshot() } as const;
  (partial.content[index] as ToolCall).arguments = block.arguments;
  return [
    start,
    { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: snapshot() },
    { type: "toolcall_end", contentIndex: index, toolCall: block, partial: snapshot() },
  ];
}
