import { Annotation } from "@langchain/langgraph";

export interface CouncilRecord {
  id: string;           // e.g., "NSW_BLACKTOWN"
  councilName: string;
  state: string;
  officialWebsite: string;
  daSystemType: string;
}

export interface CandidateURL {
  url: string;
  councilId: string;
  source: "exa_search" | "homepage_crawl";
}

export interface ValidatedDocument {
  url: string;
  councilId: string;
  decision: "PASS" | "CONDITIONAL_PASS" | "FAIL";
  credibilityScore: number;
  documentType: string;
  reasoning: string;
}

// The shared state object that flows through all LangGraph nodes
export const PipelineState = Annotation.Root({
  runId: Annotation<string>(),

  // Council queue — updated by orchestrator
  councilQueue: Annotation<CouncilRecord[]>({
    reducer: (_, update) => update,
  }),
  currentCouncil: Annotation<CouncilRecord | null>({
    reducer: (_, update) => update,
  }),

  // Discovery output
  candidateUrls: Annotation<CandidateURL[]>({
    reducer: (_, update) => update,
  }),

  // Validation output
  validatedDocs: Annotation<ValidatedDocument[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // Global counters
  totalProcessed: Annotation<number>({
    reducer: (current, update) => current + update,
    default: () => 0,
  }),
  totalDocumentsFound: Annotation<number>({
    reducer: (current, update) => current + update,
    default: () => 0,
  }),
  totalRejected: Annotation<number>({
    reducer: (current, update) => current + update,
    default: () => 0,
  }),

  errors: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
});

export type PipelineStateType = typeof PipelineState.State;