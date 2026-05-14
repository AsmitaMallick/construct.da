import { createHash } from "crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { PipelineStateType, ValidatedDocument } from "../graph/state";

export interface ScrapedDocument {
  validatedDoc: ValidatedDocument;
  rawContent: Buffer;
  textContent: string;
  contentHash: string;
  fileFormat: string;
  fileSizeBytes: number;
  title: string;
}

export async function scraperAgent(
  validatedDocs: ValidatedDocument[]
): Promise<ScrapedDocument[]> {
  const results: ScrapedDocument[] = [];

  for (const doc of validatedDocs) {
    try {
      const scraped = await scrapeUrl(doc);
      if (scraped) results.push(scraped);
      await sleep(1000); // 1 req/sec per domain courtesy
    } catch (e) {
      console.error(`[Scraper] Failed: ${doc.url}`, e);
    }
  }

  return results;
}

async function scrapeUrl(doc: ValidatedDocument): Promise<ScrapedDocument | null> {
  const res = await fetch(doc.url, { signal: AbortSignal.timeout(30000) });
  const contentType = res.headers.get("content-type") ?? "";
  const rawContent = Buffer.from(await res.arrayBuffer());

  let textContent = "";
  let fileFormat = "html";
  let title = doc.url;

  if (contentType.includes("pdf")) {
    // For PDFs: store raw, text extraction handled separately
    fileFormat = "pdf";
    textContent = "[PDF - text extraction pending]";
  } else {
    // HTML: use Readability for clean extraction
    const html = rawContent.toString("utf-8");
    const dom = new JSDOM(html, { url: doc.url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    textContent = article?.textContent ?? html.replace(/<[^>]+>/g, " ");
    title = article?.title ?? doc.url;
    fileFormat = "html";
  }

  const contentHash = createHash("sha256").update(rawContent).digest("hex");

  return {
    validatedDoc: doc,
    rawContent,
    textContent,
    contentHash,
    fileFormat,
    fileSizeBytes: rawContent.length,
    title,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}