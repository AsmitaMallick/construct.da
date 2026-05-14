import { prisma } from "./lib/prisma";
import { RuntimeQueue } from "./lib/queue";
import { buildGraph } from "./graph/graph";
import { CouncilRecord } from "./graph/state";

async function main() {
  const runId = `AU_DA_CRAWL_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`\n🚀 Starting run: ${runId}`);

  // Load pending councils from Neon
  const dbCouncils = await prisma.council.findMany({
    where: { status: { in: ["pending", "failed"] } },
    orderBy: { councilId: "asc" },
  });

  if (!dbCouncils.length) {
    console.log("No councils to process. Run the seed script first.");
    return;
  }

  console.log(`📋 Loaded ${dbCouncils.length} councils to process.`);

  // Build runtime queue
  const queue = new RuntimeQueue<CouncilRecord & { id: string }>();
  queue.enqueue(
    dbCouncils.map((c) => ({
      id: c.councilId,
      councilName: c.councilName,
      state: c.state,
      officialWebsite: c.officialWebsite ?? "",
      daSystemType: (c.notes as string) ?? "Unknown",
    }))
  );

  // Build and run the LangGraph pipeline
  const graph = buildGraph(queue);
  const config = { configurable: { thread_id: runId }, recursionLimit: 1000 };

  const finalState = await graph.invoke({ runId, councilQueue: [], validatedDocs: [] }, config);

  console.log("\n✅ Run complete!");
  console.log(`   Councils processed: ${finalState.totalProcessed}`);
  console.log(`   Documents found:    ${finalState.totalDocumentsFound}`);
  console.log(`   Rejected:           ${finalState.totalRejected}`);
  console.log(`   Errors:             ${finalState.errors.length}`);

  await prisma.$disconnect();
}

main().catch(console.error);