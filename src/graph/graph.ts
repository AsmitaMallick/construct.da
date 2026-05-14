import { StateGraph, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { PipelineState, PipelineStateType, CouncilRecord } from "./state";
import { discoveryAgent } from "../agents/discovery";
import { validationAgent } from "../agents/validation";
import { scraperAgent } from "../agents/scraper";
import { storageAgent } from "../agents/storage";
import { RuntimeQueue } from "../lib/queue";
import { prisma } from "../lib/prisma";

// --- Node: pick next council from queue ---
function makeOrchestratorNode(queue: RuntimeQueue<CouncilRecord & { id: string }>) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const batch = queue.dequeue(1);
    if (!batch.length) {
      return { currentCouncil: null };
    }
    const council = batch[0];
    console.log(`\n[Orchestrator] Processing: ${council.councilName} (${council.state})`);

    // Mark in Neon as in_progress
    await prisma.council.update({
      where: { councilId: council.id },
      data: { status: "in_progress" }
    });

    return { currentCouncil: council, candidateUrls: [] };
  };
}

// --- Node: run scraper + storage after validation ---
function makeCollectorNode(queue: RuntimeQueue<CouncilRecord & { id: string }>) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const council = state.currentCouncil;
    if (!council || !state.validatedDocs.length) {
      if (council) queue.markDone(council.id);
      return { totalProcessed: 1 };
    }

    const scraped = await scraperAgent(state.validatedDocs);
    const stored = await storageAgent(scraped, queue);

    // Update council status in Neon
    await prisma.council.update({
      where: { councilId: council.id },
      data: {
        status: stored > 0 ? "collected" : "no_documents_found",
        documentsFound: stored,
        lastProcessedAt: new Date(),
      }
    });

    queue.markDone(council.id);

    return {
      totalProcessed: 1,
      totalDocumentsFound: stored,
      validatedDocs: [],   // reset for next council
      candidateUrls: [],
    };
  };
}

// --- Edge: should we continue or finish? ---
function shouldContinue(state: PipelineStateType): "discovery" | "end" {
  if (state.currentCouncil === null) return "end";
  return "discovery";
}

// --- Build & export the graph ---
export function buildGraph(queue: RuntimeQueue<CouncilRecord & { id: string }>) {
  const checkpointer = SqliteSaver.fromConnString("checkpoints.db");

  const builder = new StateGraph(PipelineState)
    .addNode("orchestrator", makeOrchestratorNode(queue))
    .addNode("discovery", discoveryAgent)
    .addNode("validation", validationAgent)
    .addNode("collector", makeCollectorNode(queue))

    .addEdge("__start__", "orchestrator")
    .addConditionalEdges("orchestrator", shouldContinue, {
      discovery: "discovery",
      end: END,
    })
    .addEdge("discovery", "validation")
    .addEdge("validation", "collector")
    .addEdge("collector", "orchestrator");  // loop back for next council

  return builder.compile({ checkpointer });
}