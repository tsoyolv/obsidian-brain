import { z } from "zod";
import { getDataService } from "@/lib/services/data";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  fromPath: z
    .string()
    .min(1)
    .describe("Vault-relative source Data note path that will link to targets."),
  toPaths: z
    .array(z.string().min(1))
    .min(1)
    .describe("One or more vault-relative target Data note paths."),
});

export interface LinkDataNotesOutput {
  fromPath: string;
  linked: number;
}

export const linkDataNotesTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  LinkDataNotesOutput
> = {
  name: "link_data_notes",
  description:
    "Create deduplicated wiki-links between Data notes and maintain automatic backlinks.",
  parameters: ParamsSchema,
  async run(input) {
    await getDataService().linkDataNotes({
      fromPath: input.fromPath,
      toPaths: input.toPaths,
    });
    return { fromPath: input.fromPath, linked: input.toPaths.length };
  },
};
