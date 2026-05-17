import "dotenv/config";
import { processItemsConcurrently } from "@/lib/workflows/ingestion-shared";
import {
  getCouncilsForLinking,
  getStateByCode,
  getStateName,
  getOrCreateState,
  normalizeStateCode,
  upsertCouncilLinks,
} from "@/lib/api/council-storage";
import { runCouncilLinksAgent } from "@/lib/agent/council-links-agent";

export interface CouncilLinksWorkflowInput {
  stateCode?: string;
  maxLinks?: number;
  concurrency?: number;
}

export interface CouncilLinksWorkflowResult {
  processed: number;
  succeeded: number;
  failed: number;
  stateCode: string | null;
}

const DEFAULT_CONCURRENCY = 3;

export async function councilLinksDiscoveryWorkflow(
  input: CouncilLinksWorkflowInput
): Promise<CouncilLinksWorkflowResult> {
  "use workflow";

  const stateCode = input.stateCode ? normalizeStateCode(input.stateCode) : null;
  if (input.stateCode && !stateCode) {
    throw new Error(`Invalid state code: ${input.stateCode}`);
  }

  if (stateCode) {
    const existing = await getStateByCode(stateCode);
    if (!existing) {
      await getOrCreateState(stateCode, getStateName(stateCode));
    }
  }
  const stateId = stateCode ? (await getStateByCode(stateCode))?.id : undefined;

  const councils = await getCouncilsForLinking(stateId);

  if (councils.length === 0) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      stateCode,
    };
  }

  const maxLinks = input.maxLinks ?? 5;
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);

  const results = await processItemsConcurrently(
    councils,
    Math.min(concurrency, councils.length),
    async (council) => {
      try {
        const links = await runCouncilLinksAgent({
          councilName: council.councilName,
          officialWebsite: council.officialWebsite,
          maxLinks,
        });
        await upsertCouncilLinks(council.id, links);
        return { status: "succeeded" as const };
      } catch (error) {
        console.error(
          `Council link discovery failed for ${council.councilName}:`,
          error
        );
        return { status: "failed" as const };
      }
    }
  );

  const succeeded = results.filter((r) => r.status === "succeeded").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return {
    processed: results.length,
    succeeded,
    failed,
    stateCode,
  };
}
