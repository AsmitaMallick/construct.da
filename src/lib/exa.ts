import Exa from "exa-js";

const exa = new Exa(process.env.EXA_API_KEY!);

export interface ExaResult {
  url: string;
  title?: string;
  score?: number;
}

export async function searchGovAu(query: string): Promise<ExaResult[]> {
  const result = await exa.search(query, {
    numResults: 10,
    includeDomains: [".gov.au"],
    useAutoprompt: true, // Exa improves the query automatically
    type: "neural", // semantic search, better for gov docs
  });

  return result.results.map((r) => ({
    url: r.url,
    title: r.title ?? undefined,
    score: r.score,
  }));
}
