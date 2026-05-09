import type { AgentTool, AgentToolResult } from "@maya-ai/tool-agent-runtime";
import { Type } from "typebox";
import type { RegisteredTool, ToolRisk } from "../../toolRegistry.js";
import type { MarkdownWikiEngine, MarkdownWikiIssue } from "./markdownWikiEngine.js";

export const wikiLintToolName = "wiki_lint";
export const wikiUpdateIndexToolName = "wiki_update_index";
export const wikiAppendLogToolName = "wiki_append_log";
export const wikiRecordRelationshipToolName = "wiki_record_relationship";

export interface WikiMaintenanceToolDetails {
  status: "ok" | "error";
  changedFiles?: string[];
  issueCount?: number;
  added?: number;
}

interface AppendLogParams {
  action?: string;
  details?: string;
  affectedFiles?: string[];
}

interface RecordRelationshipParams {
  from?: string;
  to?: string;
  type?: string;
  evidence?: string;
  date?: string;
}

export function createMarkdownWikiMaintenanceToolDefinitions(engine: MarkdownWikiEngine): RegisteredTool[] {
  return [
    definition(createWikiLintTool(engine), "read"),
    definition(createWikiUpdateIndexTool(engine), "write"),
    definition(createWikiAppendLogTool(engine), "write"),
    definition(createWikiRecordRelationshipTool(engine), "write")
  ];
}

export function buildMarkdownWikiMaintenancePrompt(input: { availableTools: Set<string> }): string {
  const tools = [
    input.availableTools.has(wikiLintToolName) ? wikiLintToolName : undefined,
    input.availableTools.has(wikiUpdateIndexToolName) ? wikiUpdateIndexToolName : undefined,
    input.availableTools.has(wikiAppendLogToolName) ? wikiAppendLogToolName : undefined,
    input.availableTools.has(wikiRecordRelationshipToolName) ? wikiRecordRelationshipToolName : undefined
  ].filter(Boolean);
  if (!tools.length) return "";
  return [
    "## Wiki Maintenance",
    `Available wiki maintenance tools: ${tools.join(", ")}.`,
    "Use wiki_lint to inspect wiki health before broad maintenance changes.",
    "Use write-capable wiki tools only when maintaining generated wiki structure, logs, or relationship edges.",
    ""
  ].join("\n");
}

function createWikiLintTool(engine: MarkdownWikiEngine): AgentTool<any, WikiMaintenanceToolDetails> {
  return {
    name: wikiLintToolName,
    label: "Wiki Lint",
    description: "Inspect the configured markdown wiki for missing support files, broken wikilinks, and relationship issues.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      try {
        const report = engine.lint();
        return jsonResult(report, {
          status: "ok",
          issueCount: report.issueCount
        });
      } catch (error) {
        return jsonResult(errorPayload(error), { status: "error" });
      }
    }
  };
}

function createWikiUpdateIndexTool(engine: MarkdownWikiEngine): AgentTool<any, WikiMaintenanceToolDetails> {
  return {
    name: wikiUpdateIndexToolName,
    label: "Wiki Update Index",
    description: "Regenerate configured markdown wiki generated files, including the index.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      try {
        const changedFiles = engine.updateGeneratedFiles();
        return jsonResult(
          {
            changedFiles
          },
          {
            status: "ok",
            changedFiles
          }
        );
      } catch (error) {
        return jsonResult(errorPayload(error), { status: "error" });
      }
    }
  };
}

function createWikiAppendLogTool(engine: MarkdownWikiEngine): AgentTool<any, WikiMaintenanceToolDetails> {
  return {
    name: wikiAppendLogToolName,
    label: "Wiki Append Log",
    description: "Append a maintenance entry to the configured markdown wiki log.",
    parameters: Type.Object({
      action: Type.String({ description: "Short action name, for example sync, decision, update, review." }),
      details: Type.String({ description: "Concise details for the log entry." }),
      affectedFiles: Type.Optional(Type.Array(Type.String({ description: "Wiki files affected by the event." })))
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        const input = params as AppendLogParams;
        const action = input.action?.trim();
        const details = input.details?.trim();
        if (!action || !details) return jsonResult({ error: "action and details are required" }, { status: "error" });
        engine.appendLog({
          action,
          details,
          affectedFiles: input.affectedFiles?.map((file) => file.trim()).filter(Boolean) ?? []
        });
        return jsonResult(
          {
            changedFiles: ["log.md"]
          },
          {
            status: "ok",
            changedFiles: ["log.md"]
          }
        );
      } catch (error) {
        return jsonResult(errorPayload(error), { status: "error" });
      }
    }
  };
}

function createWikiRecordRelationshipTool(engine: MarkdownWikiEngine): AgentTool<any, WikiMaintenanceToolDetails> {
  return {
    name: wikiRecordRelationshipToolName,
    label: "Wiki Record Relationship",
    description: "Record a typed relationship edge in the configured markdown wiki relationship graph.",
    parameters: Type.Object({
      from: Type.String({ description: "Source endpoint, usually a markdown file path." }),
      to: Type.String({ description: "Target endpoint, usually a markdown file path." }),
      type: Type.String({ description: "Relationship type allowed by the app/domain wiki layout." }),
      evidence: Type.String({ description: "Short evidence for the relationship." }),
      date: Type.Optional(Type.String({ description: "Optional ISO date. Defaults to the wiki engine clock date." }))
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        const input = params as RecordRelationshipParams;
        const from = input.from?.trim();
        const to = input.to?.trim();
        const type = input.type?.trim();
        const evidence = input.evidence?.trim();
        if (!from || !to || !type || !evidence) {
          return jsonResult({ error: "from, to, type, and evidence are required" }, { status: "error" });
        }
        const added = engine.recordRelationships([{ from, to, type, evidence, date: input.date?.trim() || undefined }]);
        return jsonResult(
          {
            added,
            changedFiles: added > 0 ? ["graph/relationships.jsonl"] : []
          },
          {
            status: "ok",
            added,
            changedFiles: added > 0 ? ["graph/relationships.jsonl"] : []
          }
        );
      } catch (error) {
        return jsonResult(errorPayload(error), { status: "error" });
      }
    }
  };
}

function definition(tool: AgentTool<any, WikiMaintenanceToolDetails>, risk: ToolRisk): RegisteredTool {
  return {
    tool,
    metadata: {
      source: "memory",
      risk
    }
  };
}

function jsonResult(value: unknown, details: WikiMaintenanceToolDetails): AgentToolResult<WikiMaintenanceToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details
  };
}

function errorPayload(error: unknown): { error: string; issues?: MarkdownWikiIssue[] } {
  return {
    error: error instanceof Error ? error.message : String(error)
  };
}
