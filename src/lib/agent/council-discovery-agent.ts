import { google } from "@ai-sdk/google";
import { generateText, stepCountIs } from "ai";
import { webSearchTool } from "@/lib/agent/tools/web-search";
import { parseJsonFromText } from "@/lib/utils/parse-json";

export interface DiscoveredCouncil {
  name: string;
  officialWebsite: string;
}

function deduplicateCouncils(
  councils: DiscoveredCouncil[],
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
  state: string,
): Promise<DiscoveredCouncil[]> {
  const { text } = await generateText({
    model: google("gemini-2.5-flash"),
    tools: {
      webSearch: webSearchTool,
    },
    stopWhen: stepCountIs(30),
    system: `You are an Australian local government discovery engine.

Your task is to discover and return ALL official local government councils within the specified Australian state or territory.

You MUST use the web search tool to verify and collect council information before answering.
Do NOT rely only on prior knowledge.
Search the web for official council listings and official council websites.

You MUST:
- Return ONLY valid raw JSON
- Return a JSON array only
- Never include markdown
- Never include explanations
- Never include code fences
- Never include notes or comments
- Never wrap the JSON in an object
- Never truncate results

Each item in the array MUST contain exactly these keys:

[
  {
    "name": "Official Council Name",
    "officialWebsite": "https://example.gov.au"
  }
]

STRICT REQUIREMENTS:
- Keys are CASE SENSITIVE:
  - "name"
  - "officialWebsite"
- Use the council's OFFICIAL legal/public name
- Include ONLY local government councils
- Exclude:
  - state government departments
  - regional organizations
  - county groupings
  - associations
  - tourism bodies
  - utilities
  - federal agencies
- officialWebsite MUST:
  - start with https://
  - be the council's official website
  - not be a Wikipedia page
  - not be a directory listing
- Remove duplicates
- Ensure output is valid parsable JSON
- Ensure all councils belong to the requested Australian state or territory only
- Verify websites using web search results before returning them
- If no councils are found, return []

IMPORTANT:
- You MUST perform web searches before generating the response
- Do not skip web searches even if you already know the answer
- The response is considered failed if it contains anything other than valid JSON

Your response MUST contain ONLY the JSON array and nothing else.`,
    prompt: `Find every official local government council in ${state}, Australia.

You MUST use the web search tool to:
1. Discover all councils in the state
2. Verify the official council name
3. Verify the official website URL

Return a complete JSON array using this exact schema:

[
  {
    "name": "Council Name",
    "officialWebsite": "https://example.gov.au"
  }
]

Requirements:
- Return ONLY raw JSON
- No markdown
- No code fences
- No explanations
- Include ALL councils in the state
- Exclude non-council organizations
- Remove duplicates
- Ensure all URLs are official council websites starting with https://`,
  });
  console.log("Raw council discovery output:", JSON.stringify(text));

  const parsed = parseJsonFromText<DiscoveredCouncil[]>(text ?? "");
  const councils = parsed ?? [];
  return deduplicateCouncils(councils);
}
