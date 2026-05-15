import { google } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { webSearchTool } from "@/lib/agent/tools/web-search";
import { z } from "zod";

const councilSchema = z.object({
  name: z.string().min(1).describe("Official council name"),
  officialWebsite: z
    .url()
    .describe("Official council website URL"),
});

const discoveryOutputSchema = z.object({
  councils: z
    .array(councilSchema)
    .describe("Array of councils in the Australian state"),
  discoveryCount: z
    .number()
    .describe("Total number of councils discovered"),
});

export type DiscoveredCouncil = z.infer<typeof councilSchema>;

function parseAgentResponse(text: string): DiscoveredCouncil[] {
  try {
    const codeBlockMatch = text.match(
      /```(?:json)?\s*([\s\S]*?)\s*```/
    );
    const jsonString = codeBlockMatch
      ? codeBlockMatch[1]
      : text;

    const parsed = JSON.parse(jsonString);

    if (parsed.councils && Array.isArray(parsed.councils)) {
      return parsed.councils;
    }

    if (Array.isArray(parsed)) {
      return parsed;
    }

    return [];
  } catch (e) {
    console.error("Failed to parse agent response:", e);
    return [];
  }
}

function deduplicateCouncils(
  councils: DiscoveredCouncil[]
): DiscoveredCouncil[] {
  const seen = new Map<string, DiscoveredCouncil>();

  for (const council of councils) {
    const key = council.name.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, council);
    }
  }

  return Array.from(seen.values());
}

export async function runCouncilDiscoveryAgent(
  state: string
): Promise<DiscoveredCouncil[]> {
  const { output } = await generateText({
    model: google("gemini-3-flash"),
    tools: {
      webSearch: webSearchTool,
    },
    output: Output.object({ schema: discoveryOutputSchema }),
    system: `You are a council discovery assistant for Australian local government.
Find all local councils in ${state} and return their official names and websites.
Requirements:
- Return ONLY local government councils (exclude state/regional bodies)
- Include official website URLs (verify they are official council sites)
- Format response as JSON within markdown code blocks if needed
- Return an array of councils with "name" and "officialWebsite" fields`,
    prompt: `Find all local councils in ${state}, Australia. Return their names and official website URLs as a JSON array.`,
  });

  const parsed = parseAgentResponse(output?.councils ? JSON.stringify(output) : "");
  return deduplicateCouncils(parsed);
}