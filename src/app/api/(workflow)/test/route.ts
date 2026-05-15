import { runCouncilDiscovery } from "@/lib/workflows/council-discovery";
import { NextResponse } from "next/server";
import { start } from "workflow/api";

export async function POST(request: Request) {
  const { state } = await request.json();
  console.log("Received council discovery request for state:", state);
  await start(runCouncilDiscovery, [state]);
  return NextResponse.json({ message: "Council discovery workflow started" });
}
