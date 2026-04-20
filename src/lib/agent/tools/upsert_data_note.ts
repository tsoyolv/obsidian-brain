import { z } from "zod";
import { getDataService } from "@/lib/services/data";
import type { DataDocumentKind } from "@/lib/types";
import type { AgentTool } from "../types";

const DataKindSchema = z.enum(["chat_archive", "concept", "case", "index"]);

const ParamsSchema = z.object({
  kind: DataKindSchema.describe("Target Data document kind."),
  title: z.string().min(1).describe("Document title or stable identifier."),
  content: z.string().min(1).describe("Markdown content to upsert."),
  links: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional vault-relative links to attach."),
});

export interface UpsertDataNoteOutput {
  path: string;
  kind: DataDocumentKind;
}

export const upsertDataNoteTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  UpsertDataNoteOutput
> = {
  name: "upsert_data_note",
  description:
    "Create or merge a Data-layer note (concept/case/index/chat_archive) " +
    "using the data service conventions.",
  parameters: ParamsSchema,
  async run(input) {
    const path = await getDataService().upsertDataNote({
      kind: input.kind,
      title: input.title,
      content: input.content,
      links: input.links,
    });
    return { path, kind: input.kind };
  },
};
