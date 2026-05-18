import type { Prisma } from "@prisma/client";
import { getProjectById } from "@actions/projects";
import { runFactsAgent } from "@/lib/agent/facts-agent";
import { runRulesAgent } from "@/lib/agent/rules-agent";
import { runSummaryAgent } from "@/lib/agent/summary-agent";
import {
    checksResultSchema,
    extractedFactsSchema,
    projectContextSchema,
    reportSummarySchema,
    rulesPackSchema,
    type ChecksResult,
    type ExtractedFacts,
    type ProjectContext,
    type ReportSummary,
    type RulesPack,
    type WorkflowIssue,
} from "@/lib/agent/types";
import { runComplianceChecksTool } from "@/lib/agent/tools/run-compliance-checks";
import {prisma} from "../prisma";
import { GenerateProjectReportStatus, ProjectMetadata, ProjectStage, ProjectStatus } from "@models/data";
import { getWritable } from "workflow";
import { updateProjectMetadata } from "@actions/projects";

type GenerateProjectReportInput = {
    projectId: string;
};

type GenerateProjectReportResult = {
    reportId: string;
    projectId: string;
    status: "COMPLETED" | "PARTIAL" | "FAILED";
    score: number;
    issues: WorkflowIssue[];
};

function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    return {};
}

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
    }

    if (typeof value === "string") {
        return value
            .split(",")
            .map((segment) => segment.trim())
            .filter(Boolean);
    }

    return [];
}

function inferStateFromAddress(address: string): string | null {
    const normalized = address.toUpperCase();
    const states = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"];

    for (const state of states) {
        if (normalized.includes(state)) {
            return state;
        }
    }

    return null;
}

function emptyRulesPack(project: ProjectContext): RulesPack {
    return rulesPackSchema.parse({
        query: "",
        appliedFilters: {
            state: project.state,
            council: project.council,
            projectType: project.projectType,
            zoning: project.zoning,
        },
        rules: [],
    });
}

function emptyFacts(project: ProjectContext): ExtractedFacts {
    return extractedFactsSchema.parse({
        siteArea: null,
        frontage: null,
        setbacks: {},
        height: null,
        floorArea: null,
        fsr: null,
        overlays: project.overlays,
        parking: null,
        bedrooms: null,
        missingConsultantDocs: [],
        detectedReports: project.documents
            .map((document) => document.fileType)
            .filter((value): value is string => Boolean(value)),
        confidence: 0,
        notes: "Facts extraction did not complete.",
    });
}

function emptyChecks(): ChecksResult {
    return checksResultSchema.parse({
        checks: [],
        findings: [],
        score: 0,
        riskLevel: "HIGH",
        missingDocuments: [],
        likelyPathway: "Insufficient data",
        blockingIssues: ["Compliance checks were not completed."],
    });
}

function emptySummary(checks: ChecksResult): ReportSummary {
    return reportSummarySchema.parse({
        executiveSummary: "Automated summary was unavailable.",
        likelyRisks: checks.findings.slice(0, 3).map((finding) => finding.title),
        missingDocs: checks.missingDocuments,
        recommendedNextSteps: [
            "Review extracted facts and re-run report generation.",
            "Confirm missing documents and upload evidence.",
        ],
        confidenceNote: "Low confidence because summary generation failed.",
        summary: "Partial compliance report generated without model-authored summary.",
    });
}

async function fetchProjectStep(projectId: string): Promise<ProjectContext> {
    "use step";

    const project = await getProjectById(projectId);
    const projectMetadata = asRecord(project.metadata);

    return projectContextSchema.parse({
        id: project.id,
        name: project.name,
        address: project.address,
        council: project.council,
        state:
            typeof projectMetadata.state === "string"
                ? projectMetadata.state
                : inferStateFromAddress(project.address),
        projectType: project.type,
        zoning: toStringArray(projectMetadata.zoning ?? projectMetadata.zone ?? projectMetadata.zones),
        overlays: toStringArray(projectMetadata.overlays),
        metadata: projectMetadata,
        documents: project.Files.map((file) => {
            const metadata = asRecord(file.metadata);
            return {
                id: file.id,
                name: file.name,
                fileType: typeof metadata.fileType === "string" ? metadata.fileType : null,
                mimeType: typeof metadata.mimeType === "string" ? metadata.mimeType : null,
                url: file.url,
                createdAt: file.createdAt.toISOString(),
            };
        }),
    });
}

async function retrieveApplicableRulesStep(project: ProjectContext): Promise<RulesPack> {
    "use step";
    return runRulesAgent(project);
}

async function extractFactsStep(project: ProjectContext, rules: RulesPack): Promise<ExtractedFacts> {
    "use step";
    const { facts } = await runFactsAgent({ project, rules });
    return facts;
}

async function runChecksStep(input: {
    project: ProjectContext;
    facts: ExtractedFacts;
    rules: RulesPack;
}): Promise<ChecksResult> {
    "use step";
    return runComplianceChecksTool(input);
}

async function runSummaryStep(input: {
    project: ProjectContext;
    facts: ExtractedFacts;
    rules: RulesPack;
    checks: ChecksResult;
}): Promise<ReportSummary> {
    "use step";
    return runSummaryAgent(input);
}

async function storeReportStep(input: {
    projectId: string;
    status: "COMPLETED" | "PARTIAL" | "FAILED";
    rules: RulesPack;
    facts: ExtractedFacts;
    checks: ChecksResult;
    summary: ReportSummary;
    issues: WorkflowIssue[];
}): Promise<{ reportId: string; version: number }> {
    "use step";

    const previousReport = await prisma.projectReport.findFirst({
        where: { projectId: input.projectId },
        orderBy: { createdAt: "desc" },
        select: { version: true },
    });

    const nextVersion = (previousReport?.version ?? 0) + 1;
    const findingsToCreate = input.checks.findings.map((finding) => ({
        key: finding.key,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        evidence: finding.evidence as Prisma.InputJsonValue,
        recommendation: finding.recommendation,
    }));

    const checksToCreate = input.checks.checks.map((check) => ({
        key: check.key,
        category: check.category,
        passed: check.passed,
        severity: check.severity,
        message: check.message,
        expected: check.expected as Prisma.InputJsonValue | undefined,
        actual: check.actual as Prisma.InputJsonValue | undefined,
        evidence: check.evidence as Prisma.InputJsonValue,
    }));

    const createdReport = await prisma.projectReport.create({
        data: {
            projectId: input.projectId,
            status: input.status,
            score: input.checks.score,
            summary: input.summary.summary,
            executiveSummary: input.summary.executiveSummary,
            findingsJson: input.checks.findings as Prisma.InputJsonValue,
            factsJson: input.facts as Prisma.InputJsonValue,
            rulesJson: input.rules as Prisma.InputJsonValue,
            rawOutputJson: {
                rules: input.rules,
                facts: input.facts,
                checks: input.checks,
                summary: input.summary,
                issues: input.issues,
            } as Prisma.InputJsonValue,
            content: {
                summary: input.summary,
                checks: input.checks,
            } as Prisma.InputJsonValue,
            version: nextVersion,
            ...(findingsToCreate.length > 0
                ? {
                    findings: {
                        create: findingsToCreate,
                    },
                }
                : {}),
            ...(checksToCreate.length > 0
                ? {
                    checkResults: {
                        create: checksToCreate,
                    },
                }
                : {}),
        },
        select: {
            id: true,
        },
    });

    return {
        reportId: createdReport.id,
        version: nextVersion,
    };
}

export async function generateProjectReport(
    input: GenerateProjectReportInput
): Promise<GenerateProjectReportResult> {
    "use workflow";

    const issues: WorkflowIssue[] = [];
    const project = await fetchProjectStep(input.projectId);
    const projectMetadata = asRecord(project.metadata);
    const processingStartedAt = typeof projectMetadata.processingStartedAt === "string"
        ? projectMetadata.processingStartedAt
        : null;

    let rules = emptyRulesPack(project);
    let facts = emptyFacts(project);
    let checks = emptyChecks();
    let summary = emptySummary(checks);
    let status: "COMPLETED" | "PARTIAL" | "FAILED" = "COMPLETED";

    try {
        await writeToStream({
            status: "FETCHING_RULES",
            progress: 20,
            issues,
        });
        rules = await retrieveApplicableRulesStep(project);
    } catch (error) {
        issues.push({
            step: "retrieveApplicableRules",
            message: error instanceof Error ? error.message : "Unknown rules retrieval failure.",
        });
    }

    try {
        await writeToStream({
            status: "EXTRACTING_FACTS",
            progress: 40,
            issues,
        });
        facts = await extractFactsStep(project, rules);
    } catch (error) {
        facts = emptyFacts(project);
        issues.push({
            step: "extractFacts",
            message: error instanceof Error ? error.message : "Unknown fact extraction failure.",
        });
    }

    try {
        await writeToStream({
            status: "RUNNING_CHECKS",
            progress: 60,
            issues,
        });
        checks = await runChecksStep({ project, facts, rules });
    } catch (error) {
        checks = emptyChecks();
        issues.push({
            step: "runChecks",
            message: error instanceof Error ? error.message : "Unknown deterministic checks failure.",
        });
    }

    try {
        await writeToStream({
            status: "GENERATING_SUMMARY",
            progress: 80,
            issues,
        });
        summary = await runSummaryStep({ project, facts, rules, checks });
    } catch (error) {
        summary = emptySummary(checks);
        issues.push({
            step: "runLLMSummary",
            message: error instanceof Error ? error.message : "Unknown summary generation failure.",
        });
    }

    if (issues.length > 0) {
        status = "PARTIAL";
    }

    if (checks.checks.length === 0 && issues.length > 0) {
        status = "FAILED";
    }

    await writeToStream({
        status: "SAVING_REPORT",
        progress: 90,
        issues,
    });

    const stored = await storeReportStep({
        projectId: project.id,
        status,
        rules,
        facts,
        checks,
        summary,
        issues,
    });

    const completedAt = new Date();
    const durationMs = processingStartedAt
        ? completedAt.getTime() - new Date(processingStartedAt).getTime()
        : null;

    await updateProject(project.id, {
        processingStatus: status === "FAILED"
            ? ProjectStatus.FAILED
            : status === "PARTIAL"
                ? ProjectStatus.NEEDS_REVIEW
                : ProjectStatus.COMPLETED,
        processingCompletedAt: completedAt.toISOString(),
        lastRunDurationMs: durationMs ?? undefined,
        reportVersion: stored.version,
        stage: ProjectStage.COMPLETED,
    });

    await writeToStream({
        status: "COMPLETED",
        progress: 100,
        issues,
    });
    await finalizeStream();

    return {
        reportId: stored.reportId,
        projectId: project.id,
        status,
        score: checks.score,
        issues,
    };
}

async function updateProject(projectId: string, data: Partial<ProjectMetadata>) {
    "use step";
    try {
        await updateProjectMetadata(projectId, data);
    } catch (error) {
        console.error(`Failed to update project metadata for project ${projectId}:`, error);
        throw error instanceof Error ? error : new Error("Unknown error during project metadata update.");
    }
}

async function writeToStream(data: GenerateProjectReportStatus) {
    "use step";
    // Stream operations must happen in steps
    const writable = getWritable<GenerateProjectReportStatus>();
    const writer = writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
}

async function finalizeStream() {
  "use step";
  await getWritable().close(); // Signal completion
}