// ---------------------------------------------------------------------------
// Pipeline LLM Adapter
//
// The narrow, app-agnostic LLM contract that the document pipeline depends on.
// Defining it here decouples the pipeline from any consumer's richer
// `LlmProvider` interface, so the pipeline stays independently usable.
//
// Two methods are needed:
//   - `enabled` reports whether the adapter actually talks to a model.
//   - `generate` performs a single prompt-and-response turn, optionally with
//     image attachments (Tier C / multimodal segmentation).
//
// Adapters that do not support multimodal calls should ignore `images` and
// SHOULD record that they did so. The pipeline never calls `generate` with
// tool definitions — tool use belongs to the agent loop, not the pipeline.
// ---------------------------------------------------------------------------

export type PipelineImage = {
  /** Base64-encoded image bytes (no data URL prefix). */
  data: string;
  /** Image MIME type, e.g. "image/png", "image/jpeg". */
  mimeType: string;
};

export type PipelineLlmRequest = {
  systemPrompt: string;
  prompt: string;
  /** Stable session identifier — used by adapters that scope conversation context. */
  sessionId: string;
  /** Output token budget. Adapters may apply their own ceiling. */
  maxTokens?: number;
  /** Optional image attachments for multimodal calls. */
  images?: PipelineImage[];
};

export type PipelineLlmResponse = {
  text: string;
};

export interface PipelineLlmAdapter {
  /** Whether the adapter will actually call out to a model. */
  readonly enabled: boolean;
  generate(request: PipelineLlmRequest): Promise<PipelineLlmResponse | undefined>;
}
