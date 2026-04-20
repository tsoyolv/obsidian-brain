import type { AnyAgentTool } from "../types";
import { saveNoteTool } from "./save_note";
import { createTaskTool } from "./create_task";
import { completeTaskTool } from "./complete_task";
import { findTasksTool } from "./find_tasks";
import { listOpenTasksTool } from "./list_open_tasks";
import { searchVaultTool } from "./search_vault";
import { findFileTool } from "./find_file";
import { proposeOpenFileTool } from "./propose_open_file";
import { readConfirmedFileTool } from "./read_confirmed_file";
import { runFileTaskTool } from "./run_file_task";
import { answerFromVaultTool } from "./answer_from_vault";
import { softDeleteTool } from "./soft_delete";
import { webSearchTool } from "./web_search";

/**
 * The tool registry. Single source of truth the orchestrator (and any
 * future MCP / external transport) reads from. Adding a tool means:
 *
 *   1. drop a file under `src/lib/agent/tools/`
 *   2. import + register it here
 *
 * Order is irrelevant; lookup is by `name`. Names MUST be globally unique.
 */
const allTools: AnyAgentTool[] = [
  saveNoteTool,
  createTaskTool,
  completeTaskTool,
  findTasksTool,
  listOpenTasksTool,
  searchVaultTool,
  findFileTool,
  proposeOpenFileTool,
  readConfirmedFileTool,
  runFileTaskTool,
  answerFromVaultTool,
  softDeleteTool,
  webSearchTool,
];

export const toolRegistry: Map<string, AnyAgentTool> = new Map(
  allTools.map((t) => [t.name, t])
);

export function listTools(): AnyAgentTool[] {
  return [...toolRegistry.values()];
}

export function getTool(name: string): AnyAgentTool | undefined {
  return toolRegistry.get(name);
}

export {
  saveNoteTool,
  createTaskTool,
  completeTaskTool,
  findTasksTool,
  listOpenTasksTool,
  searchVaultTool,
  findFileTool,
  proposeOpenFileTool,
  readConfirmedFileTool,
  runFileTaskTool,
  answerFromVaultTool,
  softDeleteTool,
  webSearchTool,
};
