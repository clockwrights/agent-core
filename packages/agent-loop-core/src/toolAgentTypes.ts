import type { AgentTool } from "@maya-ai/tool-agent-runtime";

export interface ToolAgentRuntimeMetadata {
  enabled: boolean;
}

export interface ToolLlmAdapter {
  runToolAgent(input: ToolAgentInput): Promise<ToolAgentOutput | undefined>;
  metadata(): ToolAgentRuntimeMetadata;
}

/**
 * Image content for multimodal LLM calls. Shape matches pi-ai's `ImageContent`:
 * `data` is base64-encoded bytes (no data URL prefix); `mimeType` is the image
 * MIME type (e.g. `image/png`).
 *
 * When present on `ToolAgentInput`, the adapter constructs a multimodal user
 * message with `prompt` as the text part followed by these image parts. Used
 * by the document pipeline's Tier-C classification path.
 */
export interface ToolAgentImage {
  data: string;
  mimeType: string;
}

export interface ToolAgentInput {
  systemPrompt: string;
  prompt: string;
  sessionId: string;
  tools: AgentTool<any>[];
  maxTokens?: number;
  onProgress?: (message: string) => void;
  /**
   * Optional image attachments. When provided, the LLM call is multimodal:
   * the user message contains the text `prompt` followed by each image as a
   * `{ type: "image" }` content part. Adapters that do not support
   * multimodal MAY ignore these (and SHOULD record that they did so).
   */
  images?: ToolAgentImage[];
  /**
   * Cooperative cancellation. Adapters that wrap the in-house
   * `tool-agent-runtime` forward this to every streamSimple call and to
   * every tool's `execute`. Adapters built on other runtimes that lack
   * cancellation MAY ignore it (and SHOULD record that they did so).
   */
  signal?: AbortSignal;
}

export interface ToolAgentOutput {
  text: string;
  toolCalls: Array<{
    name: string;
    args: unknown;
    isError: boolean;
  }>;
}
