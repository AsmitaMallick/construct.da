import { z } from "zod";

export const confidenceSchema = z.number().min(0).max(1).describe("Confidence score between 0 and 1 indicating the confidence level of the extracted facts");

export const reportSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type ReportSeverity = z.infer<typeof reportSeveritySchema>;

export const projectTypeSchema = z.enum([
    "NEW_DWELLING",
    "HOME_EXTENSION",
    "SECOND_STOREY_ADDITION",
    "GARAGE_OR_CARPORT",
    "GRANNY_FLAT",
    "SWIMMING_POOL",
    "CHANGE_OF_USE",
    "DEMOLITION",
    "SIGNAGE",
    "RETAINING_WALL"
]);

export type ProjectTypeEnum = z.infer<typeof projectTypeSchema>;

export const projectDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  fileType: z.string().nullable(),
  mimeType: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
});

export const projectContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  council: z.string(),
  state: z.string().nullable(),
  projectType: projectTypeSchema,
  zoning: z.array(z.string()),
  overlays: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  documents: z.array(projectDocumentSchema),
});
export type ProjectContext = z.infer<typeof projectContextSchema>;

export const retrievedRuleSchema = z.object({
  id: z.string().describe("Unique identifier for the retrieved rule"),
  title: z.string().nullable().describe("Title of the retrieved rule"),
  content: z.string().describe("Content of the retrieved rule"),
  source: z.string().nullable().describe("Source of the retrieved rule"),
  clause: z.string().nullable().describe("Clause of the retrieved rule"),
  zone: z.string().nullable().describe("Zone to which the retrieved rule applies"),
  topic: z.string().nullable().describe("Topic to which the retrieved rule belongs"),
  vectorScore: z.number().describe("Vector similarity score"),
  bm25Score: z.number().describe("BM25 similarity score"),
  hybridScore: z.number().describe("Hybrid similarity score"),
  metadata: z.record(z.string(), z.unknown()).nullable().describe("Additional metadata associated with the retrieved rule"),
});

export const rulesPackSchema = z.object({
  query: z.string().describe("The query used to retrieve the rules"),
  appliedFilters: z.object({
    state: z.string().nullable().describe("State or territory where the project is located"),
    council: z.string().nullable().describe("Local council where the project is located"),
    projectType: projectTypeSchema.describe("Type of development project"),
    zoning: z.array(z.string()).describe("List of zoning categories applicable to the project"),
  }),
  rules: z.array(retrievedRuleSchema).describe("List of retrieved rules that are applicable to the project context"),
});
export type RulesPack = z.infer<typeof rulesPackSchema>;

export const extractedFactsSchema = z.object({
  siteArea: z.number().describe("The total area of the site in square meters").nullable(),
  frontage: z.number().describe("The length of the frontage of the site in meters").nullable(),
  setbacks: z.record(z.string(), z.number()).default({}).describe("Record of setback distances for each side of the site"),
  height: z.number().describe("The height of the building in meters").nullable(),
  floorArea: z.number().describe("The total floor area of the building in square meters").nullable(),
  fsr: z.number().describe("The Floor Space Ratio").nullable(),
  overlays: z.array(z.string()).default([]).describe("List of planning overlays that apply to the project"),
  parking: z.number().describe("The number of parking spaces required").nullable(),
  bedrooms: z.number().describe("The number of bedrooms in the building").nullable(),
  missingConsultantDocs: z.array(z.string()).default([]).describe("List of required consultant reports that are missing from the project documents"),
  detectedReports: z.array(z.string()).default([]).describe("List of consultant reports detected based on project documents"),
  confidence: confidenceSchema,
  notes: z.string().describe("Additional notes about the extracted facts").nullable(),
});
export type ExtractedFacts = z.infer<typeof extractedFactsSchema>;

export const complianceCheckSchema = z.object({
  key: z.string(),
  category: z.enum([
    "COMPLETENESS",
    "NUMERIC_THRESHOLD",
    "CONTRADICTION",
    "PATHWAY_ELIGIBILITY",
    "RISK_HEURISTIC",
  ]),
  passed: z.boolean(),
  severity: reportSeveritySchema,
  message: z.string(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  evidence: z.array(z.string()).default([]),
});
export type ComplianceCheck = z.infer<typeof complianceCheckSchema>;

export const findingSchema = z.object({
  key: z.string(),
  severity: reportSeveritySchema,
  title: z.string(),
  detail: z.string(),
  evidence: z.array(z.string()).default([]),
  recommendation: z.string().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

export const checksResultSchema = z.object({
  checks: z.array(complianceCheckSchema),
  findings: z.array(findingSchema),
  score: z.number().int().min(0).max(100),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  missingDocuments: z.array(z.string()),
  likelyPathway: z.string(),
  blockingIssues: z.array(z.string()),
});
export type ChecksResult = z.infer<typeof checksResultSchema>;

export const reportSummarySchema = z.object({
  executiveSummary: z.string(),
  likelyRisks: z.array(z.string()),
  missingDocs: z.array(z.string()),
  recommendedNextSteps: z.array(z.string()),
  confidenceNote: z.string(),
  summary: z.string(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const workflowIssueSchema = z.object({
  step: z.string(),
  message: z.string(),
});
export type WorkflowIssue = z.infer<typeof workflowIssueSchema>;

export const validationDecisionSchema = z.object({
  url: z.string(),
  councilId: z.string(),
  decision: z.enum(["PASS", "CONDITIONAL_PASS", "FAIL"]),
  credibilityScore: z.number().min(0).max(1),
  failedChecks: z.array(z.string()),
  passedChecks: z.array(z.string()),
  reasoning: z.string(),
  rulesList: z.array(z.string()),
  documentType: z.string(),
  reviewRequired: z.boolean(),
});
export type ValidationDecision = z.infer<typeof validationDecisionSchema>;

export interface CandidateUrl {
  url: string;
  councilId: string;
  councilName: string;
  state: string;
}
