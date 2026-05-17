import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { councilLinksDiscoveryWorkflow } from "@/lib/workflows/council-links-discovery";
import { hasAdminRole, hasValidIngestionServiceToken } from "@/lib/api/workflow-auth";

type CouncilLinksRequest = {
  stateCode?: unknown;
  maxLinks?: unknown;
  concurrency?: unknown;
};

function parsePositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

export async function POST(request: Request) {
  const authResult = await auth();
  const hasServiceToken = hasValidIngestionServiceToken(request);
  if (!authResult.isAuthenticated && !hasServiceToken) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  if (!hasServiceToken && !hasAdminRole(authResult.sessionClaims)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  let stateCode: string | undefined;
  let maxLinks: number | undefined;
  let concurrency: number | undefined;

  try {
    const body = (await request.json()) as CouncilLinksRequest;
    if (body.stateCode !== undefined) {
      if (typeof body.stateCode !== "string") {
        throw new Error("stateCode must be a string");
      }
      stateCode = body.stateCode;
    }
    maxLinks = parsePositiveInt(body.maxLinks, "maxLinks");
    concurrency = parsePositiveInt(body.concurrency, "concurrency");
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const run = await start(councilLinksDiscoveryWorkflow, [
    {
      stateCode,
      maxLinks,
      concurrency,
    },
  ]);

  return NextResponse.json({
    runId: run.runId,
    message: "Council link discovery workflow started",
  });
}
