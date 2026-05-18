import { google } from "@ai-sdk/google";
import { generateText, stepCountIs } from "ai";
import { httpFetch } from "./tools/http-fetch";
import { parseJsonFromText } from "@/lib/utils/parse-json";
import type { CandidateUrl, ValidationDecision } from "./types";

const APPROVED_STATE_PORTALS = [
  "planning.nsw.gov.au",
  "planningportal.vic.gov.au",
  "dilgp.qld.gov.au",
  "dplh.wa.gov.au",
  "sa.gov.au/planning",
  "planning.act.gov.au",
  "nt.gov.au/property",
];

function isGovAuDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname.endsWith(".gov.au");
  } catch {
    return false;
  }
}

function isApprovedPortal(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return APPROVED_STATE_PORTALS.some((portal) => hostname.includes(portal));
  } catch {
    return false;
  }
}

function matchesCouncilDomain(url: string, councilName: string, state: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const councilSlug = councilName
      .toLowerCase()
      .replace(/ council| city of| shire of| town of/g, "")
      .replace(/[^a-z0-9]/g, "");
    const stateSlug = state.toLowerCase();
    return (
      hostname.includes(councilSlug) ||
      hostname.includes(stateSlug) ||
      isApprovedPortal(url)
    );
  } catch {
    return false;
  }
}

function validateContentType(contentType: string): "PASS" | "FAIL" {
  if (!contentType) return "PASS";
  const lower = contentType.toLowerCase();
  const validTypes = [
    "application/pdf",
    "text/html",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  return validTypes.some((t) => lower.includes(t)) ? "PASS" : "FAIL";
}

function validateFreshness(lastModified: string, content: string): { status: "PASS" | "FLAG"; tags: string[] } {
  const tags: string[] = [];
  let status: "PASS" | "FLAG" = "PASS";

  if (lastModified) {
    const docDate = new Date(lastModified);
    const now = new Date();
    const yearsDiff = (now.getTime() - docDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
    if (yearsDiff > 10) {
      tags.push("HISTORICAL_OVER_10_YEARS");
      status = "FLAG";
    }
  }

  const historicalKeywords = ["superseded", "archived", "repealed", "outdated", "former"];
  const lowerContent = content.toLowerCase();
  if (historicalKeywords.some((k) => lowerContent.includes(k))) {
    tags.push("HISTORICAL_KEYWORD");
    status = "FLAG";
  }

  return { status, tags };
}

export async function runValidationAgent(
  candidates: CandidateUrl[]
): Promise<ValidationDecision[]> {
  const results: ValidationDecision[] = [];

  for (const candidate of candidates) {
    const passedChecks: string[] = [];
    const failedChecks: string[] = [];
    const rulesFound: string[] = [];
    let documentType = "unknown";
    let reviewRequired = false;
    let reasoning = "";

    // Stage 1: Domain Authority Whitelist
    const stage1Pass = isGovAuDomain(candidate.url) || isApprovedPortal(candidate.url);
    if (stage1Pass) {
      passedChecks.push("DOMAIN_AUTHORITY_WHITELIST");
      rulesFound.push("Australian Government Domain (.gov.au)");
    } else {
      failedChecks.push("DOMAIN_AUTHORITY_WHITELIST");
      reasoning = "Non-official domain - not .gov.au or approved portal";
      results.push({
        url: candidate.url,
        councilId: candidate.councilId,
        decision: "FAIL",
        credibilityScore: 0,
        failedChecks,
        passedChecks: [],
        reasoning,
        rulesList: [],
        documentType: "unknown",
        reviewRequired: true,
      });
      continue;
    }

    // Stage 2: Council-URL Ownership Match (using LLM)
    const stage2Prompt = `Does the URL "${candidate.url}" belong to "${candidate.councilName}" council in ${candidate.state}, Australia? 
Check if the domain matches the council name or is an official state planning portal.
Respond with ONLY: "YES" or "NO" and a brief explanation.`;

    const { text: stage2Text } = await generateText({
      model: google("gemini-3-flash"),
      stopWhen: stepCountIs(5),
      prompt: stage2Prompt,
      system: "You are a URL ownership verifier. Answer with YES or NO only.",
    });

    const stage2Pass = stage2Text.toLowerCase().includes("yes") || matchesCouncilDomain(candidate.url, candidate.councilName, candidate.state);
    if (stage2Pass) {
      passedChecks.push("COUNCIL_URL_OWNERSHIP");
    } else {
      failedChecks.push("COUNCIL_URL_OWNERSHIP");
      reasoning = stage2Pass ? "URL verified as council-owned" : "URL does not belong to council jurisdiction";
    }

    // Stage 3: Content Type Verification
    const httpHeaders = await httpFetch({ url: candidate.url, method: "HEAD", timeoutMs: 10000 });
    const stage3Status = httpHeaders.ok ? validateContentType(httpHeaders.contentType || "") : "FAIL";
    if (stage3Status === "PASS") {
      passedChecks.push("CONTENT_TYPE_VERIFICATION");
    } else {
      failedChecks.push("CONTENT_TYPE_VERIFICATION");
      if (!reasoning) reasoning = "Non-document content type";
    }

    // Determine document type from content-type
    if (httpHeaders.contentType) {
      if (httpHeaders.contentType.includes("pdf")) documentType = "PDF";
      else if (httpHeaders.contentType.includes("html")) documentType = "HTML";
      else if (httpHeaders.contentType.includes("word")) documentType = "DOC/DOCX";
    }

    // Stage 4: DA Relevance Score
    let relevanceScore = 0;
    if (httpHeaders.ok) {
      const httpContent = await httpFetch({ url: candidate.url, method: "GET", timeoutMs: 15000 });
      const contentSample = httpContent.content?.slice(0, 2000) || "";

      const { text: relevanceText } = await generateText({
        model: google("gemini-3-flash"),
        stopWhen: stepCountIs(10),
        system: `You are a DA relevance scorer. Evaluate if the content contains official development approval rules, regulations, codes, or planning guides.
Score 0.0-1.0:
- ≥ 0.7 = PASS (highly relevant)
- 0.4-0.69 = CONDITIONAL PASS (needs review)
- < 0.4 = FAIL (not relevant)

Respond with ONLY a JSON object:
{ "score": 0.0-1.0, "documentType": "DCP|LEP|Planning Scheme|Guideline|Policy|Other", "rules": ["list of rules found"] }`,
        prompt: `Content sample from ${candidate.url} (council: ${candidate.councilName}, state: ${candidate.state}):

${contentSample}`,
      });

      try {
        const parsed = parseJsonFromText<{ score: number; documentType?: string; rules?: string[] }>(relevanceText || "");
        if (parsed) {
          relevanceScore = parsed.score ?? 0;
          if (parsed.documentType) documentType = parsed.documentType;
          if (parsed.rules) rulesFound.push(...parsed.rules);
        }
      } catch {
        relevanceScore = 0.5;
      }
    }

    // Stage 4 decision
    if (relevanceScore >= 0.7) {
      passedChecks.push("DA_RELEVANCE_SCORE");
    } else if (relevanceScore >= 0.4) {
      passedChecks.push("DA_RELEVANCE_SCORE");
      reviewRequired = true;
    } else {
      failedChecks.push("DA_RELEVANCE_SCORE");
      if (!reasoning) reasoning = `Low DA relevance: score ${relevanceScore}`;
    }

    // Stage 5: Freshness & Authority Check
    const freshness = validateFreshness(httpHeaders.lastModified || "", "");
    if (freshness.status === "PASS") {
      passedChecks.push("FRESHNESS_AUTHORITY");
      if (freshness.tags.length > 0) {
        rulesFound.push(...freshness.tags);
      }
    } else {
      passedChecks.push("FRESHNESS_AUTHORITY");
      rulesFound.push(...freshness.tags);
    }

    // Final decision logic
    let decision: "PASS" | "CONDITIONAL_PASS" | "FAIL" = "PASS";
    if (failedChecks.length > 0) {
      decision = "FAIL";
    } else if (reviewRequired || freshness.tags.length > 0) {
      decision = "CONDITIONAL_PASS";
    }

    // Build reasoning if empty
    if (!reasoning) {
      const passedCount = passedChecks.length;
      const total = 5;
      reasoning = `Passed ${passedCount}/${total} checks. Score: ${relevanceScore.toFixed(2)}. Document type: ${documentType}.`;
    }

    results.push({
      url: candidate.url,
      councilId: candidate.councilId,
      decision,
      credibilityScore: relevanceScore,
      failedChecks,
      passedChecks,
      reasoning,
      rulesList: Array.from(new Set(rulesFound)),
      documentType,
      reviewRequired,
    });
  }

  return results;
}