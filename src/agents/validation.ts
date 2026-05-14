import { askGemini, geminiPro, geminiFlash } from "../lib/gemini";
import { prisma } from "../lib/prisma";
import { parse as parseDomain } from "tldts";
import { PipelineStateType, ValidatedDocument, CandidateURL } from "../graph/state";

const GOV_AU_PATTERN = /\.gov\.au$/i;

interface LLMCredibilityResponse {
  is_official_source: boolean;
  is_da_relevant: boolean;
  credibility_score: number;
  document_type: string;
  reasoning: string;
}

export async function validationAgent(
  state: PipelineStateType
): Promise<Partial<PipelineStateType>> {
  const council = state.currentCouncil;
  if (!council || !state.candidateUrls.length) return {};

  const validated: ValidatedDocument[] = [];
  let rejected = 0;

  for (const candidate of state.candidateUrls) {
    const result = await validateUrl(candidate, council.councilName, council.state, state.runId);
    if (result) {
      validated.push(result);
      if (result.decision === "FAIL") rejected++;
    }
  }

  return {
    validatedDocs: validated.filter((d) => d.decision !== "FAIL"),
    totalRejected: rejected,
  };
}

async function validateUrl(
  candidate: CandidateURL,
  councilName: string,
  state: string,
  runId: string
): Promise<ValidatedDocument | null> {
  const { url, councilId } = candidate;

  // CHECK 1: Must be .gov.au (hard gate)
  const domain = parseDomain(url);
  if (!GOV_AU_PATTERN.test(url)) {
    await logAudit(runId, councilId, url, "DOMAIN_CHECK", "FAIL", "Non .gov.au domain");
    return { url, councilId, decision: "FAIL", credibilityScore: 0, documentType: "unknown", reasoning: "Non-official domain" };
  }

  // CHECK 2: Content type via HEAD request
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    const ct = head.headers.get("content-type") ?? "";
    if (ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/")) {
      await logAudit(runId, councilId, url, "CONTENT_TYPE_CHECK", "FAIL", `Bad content type: ${ct}`);
      return { url, councilId, decision: "FAIL", credibilityScore: 0, documentType: "unknown", reasoning: "Non-document content type" };
    }
  } catch {
    // If HEAD fails, continue (some servers block HEAD)
  }

  // CHECK 3 + 4: LLM credibility + DA relevance (fetch first 2000 chars)
  let excerpt = "";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    excerpt = text.replace(/<[^>]+>/g, " ").substring(0, 2000);
  } catch {
    excerpt = "";
  }

  const llmPrompt = `
You are an expert Australian planning law researcher.
Evaluate this URL for a council DA rules database.

COUNCIL: ${councilName}
STATE: ${state}
URL: ${url}
CONTENT EXCERPT (first 2000 chars):
---
${excerpt}
---

Answer ALL of these:
1. Is this URL from an official Australian government source?
2. Does it contain development approval rules/regulations/codes/guides for ${councilName} or its state authority?
3. Credibility score 0.0–1.0
4. Document type: DCP | LEP | Planning Scheme | LPP | Development Code | Practice Guide | Application Form | Public Notice | Other
5. One sentence reasoning.

Respond ONLY with this JSON (no markdown, no explanation):
{
  "is_official_source": true/false,
  "is_da_relevant": true/false,
  "credibility_score": 0.0,
  "document_type": "...",
  "reasoning": "..."
}
`;

  let llmResult: LLMCredibilityResponse;
  try {
    const raw = await askGemini(geminiPro, llmPrompt);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    llmResult = JSON.parse(cleaned);
  } catch {
    return { url, councilId, decision: "FAIL", credibilityScore: 0, documentType: "unknown", reasoning: "LLM parse error" };
  }

  await logAudit(runId, councilId, url, "LLM_CREDIBILITY", 
    llmResult.credibility_score >= 0.7 ? "PASS" : "FAIL",
    llmResult.reasoning, llmPrompt, JSON.stringify(llmResult));

  // Score thresholds
  const score = llmResult.credibility_score;
  let decision: "PASS" | "CONDITIONAL_PASS" | "FAIL";
  if (score >= 0.75) decision = "PASS";
  else if (score >= 0.4) decision = "CONDITIONAL_PASS";
  else decision = "FAIL";

  return {
    url,
    councilId,
    decision,
    credibilityScore: score,
    documentType: llmResult.document_type,
    reasoning: llmResult.reasoning,
  };
}

async function logAudit(
  runId: string, councilId: string, url: string,
  checkName: string, checkResult: string, checkDetail: string,
  llmPrompt?: string, llmResponse?: string
) {
  try {
    await prisma.validationAuditLog.create({
      data: { runId, councilId, url, checkName, checkResult, checkDetail, llmPrompt, llmResponse }
    });
  } catch (e) {
    console.error("Audit log write failed:", e);
  }
}