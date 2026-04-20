import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { getDataService } from "@/lib/services/data";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Chat session id to archive. Defaults to current agent session."),
});

export interface ArchiveChatToDataOutput {
  sessionId: string;
  archived: boolean;
}

/**
 * Archive chat summary into the Data layer. Delegates to chatService.summarize
 * so existing summarize guardrails and persistence behavior stay unchanged.
 */
export const archiveChatToDataTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  ArchiveChatToDataOutput
> = {
  name: "archive_chat_to_data",
  description:
    "Summarize a chat session and persist the archive into the Data layer. " +
    "Uses existing summarize flow and safety rules.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const chat = getChatService();
    const sessionId = input.sessionId ?? ctx.sessionId;
    const session = await chat.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown chat session: ${sessionId}`);
    }

    // Reuse the canonical summarize pipeline to avoid divergent archive logic.
    await chat.summarize(sessionId);
    await getDataService().buildIndex({ scope: "all" });
    return { sessionId, archived: true };
  },
};
