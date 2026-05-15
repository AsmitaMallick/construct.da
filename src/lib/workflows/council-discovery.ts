import "dotenv/config";
import {
  normalizeStateCode,
  getStateByCode,
  getOrCreateState,
  getCouncilsByStateId,
  upsertCouncils,
  getStateName,
} from "@/lib/api/council-storage";
import { runCouncilDiscoveryAgent } from "@/lib/agent/council-discovery-agent";
import type { Council, State } from "@prisma/client";

interface CouncilResult {
  councilId: string;
  councilName: string;
  officialWebsite: string | null;
  stateId: string | null;
}

interface WorkflowResult {
  councils: CouncilResult[];
  source: "database" | "search";
  stateCode: string;
}

export async function councilDiscoveryStep(
  state: string,
): Promise<WorkflowResult> {
  "use step";

  const normalized = normalizeStateCode(state);
  if (!normalized) {
    throw new Error(`Invalid state code: ${state}`);
  }

  let stateRecord = await getStateByCode(normalized);
  if (!stateRecord) {
    stateRecord = await getOrCreateState(normalized, getStateName(normalized));
  }

  let councils = await getCouncilsByStateId(stateRecord.id);

  if (councils.length === 0) {
    console.log(
      `No councils found for ${normalized}, running discovery agent...`,
    );

    const discoveredCouncils = await runCouncilDiscoveryAgent(normalized);

    if (discoveredCouncils.length > 0) {
      await upsertCouncils(
        stateRecord.id,
        discoveredCouncils.map((c) => ({
          name: c.name,
          officialWebsite: c.officialWebsite,
        })),
      );

      councils = await getCouncilsByStateId(stateRecord.id);
    }
  }

  return {
    councils: councils.map((c) => ({
      councilId: c.councilId,
      councilName: c.councilName,
      officialWebsite: c.officialWebsite,
      stateId: c.stateId,
    })),
    source: councils.length > 0 ? "database" : "search",
    stateCode: normalized,
  };
}

export async function runCouncilDiscovery(state?: string) {
  "use workflow";

  try {
    console.log("Starting council discovery workflow for state:", state);
    const result = await councilDiscoveryStep(state || "NSW");
    return result;
    console.log("Council Discovery Result:", result);
  } catch (error) {
    console.error("Error during council discovery:", error);
    return {
    councils: [],
      source: "error",
      stateCode: state || "unknown",
    };
  }
}
