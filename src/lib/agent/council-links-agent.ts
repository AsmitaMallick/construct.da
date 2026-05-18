import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { webSearchTool } from "@/lib/agent/tools/web-search";
import { parseJsonFromText } from "@/lib/utils/parse-json";
import { z } from "zod";

const linkSchema = z.object({
  url: z.url(),
  title: z.string().nullable().optional(),
  sourceType: z.string().nullable().optional().describe("official | gov | pdf"),
});

const discoveryOutputSchema = z.object({
  councilName: z.string(),
  links: z.array(linkSchema),
});

export type DiscoveredCouncilLink = z.infer<typeof linkSchema>;

const ALLOWED_TLDS = new Set([".gov.au"]);

export function normalizeUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return input.trim();
  }
}

export function isGovDomain(hostname: string): boolean {
  return Array.from(ALLOWED_TLDS).some((suffix) => hostname.endsWith(suffix));
}

export function extractHostname(website?: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.toLowerCase().includes(".pdf");
  }
}

export function isOfficialOrGovUrl(
  url: string,
  officialHost: string | null,
): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (officialHost && host === officialHost) {
      return true;
    }
    return isGovDomain(host);
  } catch {
    return false;
  }
}

export function scoreLink(url: string, officialHost: string | null): number {
  const normalized = normalizeUrl(url);
  let score = 0;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./, "");
    if (officialHost && host === officialHost) score += 5;
    if (isGovDomain(host)) score += 3;
    if (isPdfUrl(normalized)) score += 1;
  } catch {
    return -1;
  }
  return score;
}

export function filterAndRankLinks(
  links: DiscoveredCouncilLink[],
  officialWebsite?: string | null,
  maxLinks = 5,
): DiscoveredCouncilLink[] {
  const officialHost = extractHostname(officialWebsite);
  const seen = new Set<string>();
  const filtered = links
    .map((link) => ({
      ...link,
      url: normalizeUrl(link.url),
    }))
    .filter((link) => isOfficialOrGovUrl(link.url, officialHost))
    .filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    })
    .sort(
      (a, b) => scoreLink(b.url, officialHost) - scoreLink(a.url, officialHost),
    );

  return filtered.slice(0, maxLinks).map((link) => ({
    ...link,
    sourceType: inferSourceType(link.url, officialHost, link.sourceType),
  }));
}

function inferSourceType(
  url: string,
  officialHost: string | null,
  sourceType?: string | null,
): string | null {
  if (sourceType) return sourceType;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (officialHost && host === officialHost) return "official";
    if (isGovDomain(host)) return "gov";
    if (isPdfUrl(url)) return "pdf";
    return null;
  } catch {
    return null;
  }
}

// parseLinkOutput removed in favor of `parseJsonFromText` utility

export async function runCouncilLinksAgent(input: {
  councilName: string;
  officialWebsite?: string | null;
  maxLinks?: number;
}): Promise<DiscoveredCouncilLink[]> {
  const maxLinks = input.maxLinks ?? 5;
  const officialHost = extractHostname(input.officialWebsite);
  const officialWebsite = input.officialWebsite ?? "";

  const { text } = await generateText({
    model: google("gemini-3-flash"),
    tools: {
      webSearch: webSearchTool,
    },
    system: [
      "You are a senior research assistant for Australian local government councils.",
      "Find relevant links for the named council.",
      "You MUST use the webSearch tool to verify links before returning them.",
      "Return ONLY valid raw JSON.",
      "Never include markdown, code fences, explanations, or extra text.",
      "Return a single JSON object with keys `councilName` and `links`.",
      "`links` must be an array of objects with keys: `url`, `title` (optional), and `sourceType` (optional: official | gov | pdf).",
      'Example output:\n{\n  "councilName": "Shire Council",\n  "links": [\n    {\n      "url": "https://example.gov.au/planning",\n      "title": "Planning and Development",\n      "sourceType": "official"\n    }\n  ]\n}',
    ].join("\n"),
    prompt: [
      `Council: ${input.councilName}`,
      officialWebsite ? `Official website: ${officialWebsite}` : "",
      officialHost ? `Official hostname: ${officialHost}` : "",
      `Return ${maxLinks} links relevant to this council such as planning, DA, building, policies, or community services pages.`,
      "Return structured JSON with 'councilName' and 'links' fields.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  console.log("Raw council links output:", text);

  const parsed = parseJsonFromText<{
    councilName?: string;
    links?: DiscoveredCouncilLink[];
  }>(text ?? "");
  const links = parsed?.links ?? [];
  return filterAndRankLinks(links, input.officialWebsite, maxLinks);
}
