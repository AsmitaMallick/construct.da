import { searchGovAu } from "../lib/exa";
import { askGemini, geminiFlash } from "../lib/gemini";
import { load } from "cheerio";
import { PipelineStateType, CandidateURL } from "../graph/state";

const PLANNING_KEYWORDS = [
  "development", "planning", "DA", "DCP", "LEP",
  "scheme", "application", "approval", "zoning",
  "controls", "policy", "regulation", "permit"
];

export async function discoveryAgent(
  state: PipelineStateType
): Promise<Partial<PipelineStateType>> {
  const council = state.currentCouncil;
  if (!council) return {};

  const candidateUrls: CandidateURL[] = [];

  // 1. Generate targeted search queries with Gemini
  const queryPrompt = `
Generate 5 precise search queries to find official Development Approval (DA) 
rules and planning documents for:
Council: "${council.councilName}", State: "${council.state}"
Official website: "${council.officialWebsite}"

Target: DCPs, LEPs, Planning Schemes, Local Planning Policies, zoning codes.
Rules: queries must target .gov.au sources only.
Return ONLY a JSON array of 5 query strings, no explanation.
`;

  let queries: string[] = [];
  try {
    const raw = await askGemini(geminiFlash, queryPrompt);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    queries = JSON.parse(cleaned);
  } catch {
    queries = [
      `${council.councilName} development control plan`,
      `${council.councilName} ${council.state} planning scheme`,
      `${council.councilName} DA rules regulations`,
    ];
  }

  // 2. Execute Exa searches for each query
  for (const query of queries.slice(0, 5)) {
    try {
      const results = await searchGovAu(query);
      for (const r of results) {
        candidateUrls.push({
          url: r.url,
          councilId: council.id,
          source: "exa_search",
        });
      }
      await sleep(500); // be polite
    } catch (e) {
      console.error(`Exa search failed for: ${query}`, e);
    }
  }

  // 3. Crawl council homepage for planning links
  try {
    const res = await fetch(council.officialWebsite, {
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const $ = load(html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().toLowerCase();
      const hasKeyword = PLANNING_KEYWORDS.some(
        (kw) => text.includes(kw) || href.toLowerCase().includes(kw)
      );
      if (hasKeyword) {
        const absolute = href.startsWith("http")
          ? href
          : new URL(href, council.officialWebsite).toString();
        if (absolute.includes(".gov.au")) {
          candidateUrls.push({
            url: absolute,
            councilId: council.id,
            source: "homepage_crawl",
          });
        }
      }
    });
  } catch (e) {
    console.error(`Homepage crawl failed: ${council.officialWebsite}`, e);
  }

  // Deduplicate by URL
  const unique = Array.from(
    new Map(candidateUrls.map((u) => [u.url, u])).values()
  );

  console.log(`[Discovery] ${council.councilName}: found ${unique.length} candidate URLs`);
  return { candidateUrls: unique };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}