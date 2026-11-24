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
// SHOULD record that they did so. `documents` (native PDF) is only sent to
// adapters that declare `supportsDocuments`. The pipeline never calls `generate` with
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
  /**
   * Optional native document attachments (today: whole PDF files). Only sent
   * to adapters that set `supportsDocuments: true`, and only when the caller
   * opts in (`DocumentPipelineDeps.nativePdf`). The adapter forwards them as
   * the provider's document/file content part.
   */
  documents?: PipelineDocument[];
};

export type PipelineDocument = {
  /** Base64-encoded file bytes (no data URL prefix). */
  data: string;
  /** Document MIME type, e.g. "application/pdf". */
  mimeType: string;
  /** Original file name, when known. Some providers show it to the model. */
  name?: string;
};

export type PipelineLlmResponse = {
  text: string;
};

export interface PipelineLlmAdapter {
  /** Whether the adapter will actually call out to a model. */
  readonly enabled: boolean;
  /**
   * Whether `generate` forwards `documents` (native PDF) to the model.
   * Defaults to false: the pipeline never sends documents to an adapter that
   * does not set this.
   */
  readonly supportsDocuments?: boolean;
  generate(request: PipelineLlmRequest): Promise<PipelineLlmResponse | undefined>;
}
