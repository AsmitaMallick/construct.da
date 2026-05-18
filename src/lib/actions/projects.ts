"use server";
import { FilesStrict, GenerateProjectReport, ProjectSpecs, ProjectStage, ProjectStatus, ProjectStrict, ProjectWithFiles } from "@models/data";
import {prisma} from "../prisma";
import { auth, currentUser } from "@clerk/nextjs/server";
import { buildRossStreetMasterViewProjectMetadata, buildRossStreetMasterViewProjectSpecs, ROSS_STREET_MASTER_VIEW_APPLICATION } from "@/lib/masterview/north-sydney";
import { addressToCoordinatesGoogle } from "../geoEncoding";
import { Prisma } from "@prisma/client";
import { ExtractedFacts, RulesPack } from "../agent/types";
import { buildFixtureSpatialConstraints, SpatialConstraintSource, SPATIAL_FIXTURE_RETRIEVED_AT } from "../spatial";
import { resolveUserIdByClerkIdentity } from "@/lib/actions/users";



export async function createRossStreetMasterViewDemoProject(): Promise<ProjectStrict> {
    try {
        const { userId: clerkUserId } = await auth();
        if (!clerkUserId) {
            throw new Error("User must be authenticated to create the Ross Street MasterView demo project.");
        }

        const user = await currentUser();
        const userId = await resolveUserIdByClerkIdentity({
            clerkUserId,
            email: user?.primaryEmailAddress?.emailAddress,
            name: user?.fullName ?? undefined,
        });
        const projectSpecs = buildRossStreetMasterViewProjectSpecs(userId);
        const metadata = buildRossStreetMasterViewProjectMetadata();
        const application = ROSS_STREET_MASTER_VIEW_APPLICATION;

        const checks = [
            {
                key: "masterview_document_pack",
                category: "COMPLETENESS",
                passed: true,
                severity: "LOW",
                message: "MasterView document pack imported: BASIX, heritage statement, site plans, SEE, survey, stormwater, waste, shadow diagrams, and notification plans.",
                expected: "Lodged DA document set",
                actual: application.documents.map((document) => document.fileType),
                evidence: ["North Sydney MasterView documents table"],
            },
            {
                key: "ross_street_controls_extracted",
                category: "NUMERIC_THRESHOLD",
                passed: true,
                severity: "LOW",
                message: "R2 zoning, 8.5 m height control, approximately 234-241.4 sqm site area, and 172 sqm proposed GFA are captured for review.",
                expected: { zoning: application.zoning, heightControl: application.heightControl },
                actual: { siteArea: application.siteAreaRange, proposedGfa: application.proposedGfa },
                evidence: ["SEE", "Site plans", "Survey plan"],
            },
            {
                key: "clause46_not_triggered",
                category: "PATHWAY_ELIGIBILITY",
                passed: true,
                severity: "LOW",
                message: "No cl. 4.6 variation is triggered by the current control-case facts because the SEE states height and controls are compliant.",
                expected: "No development-standard breach identified",
                actual: "SEE marks LEP height compliance as YES",
                evidence: ["SEE North Sydney LEP 2013 assessment", "Site plans height-control notation"],
            },
            {
                key: "heritage_adjacency_review",
                category: "RISK_HEURISTIC",
                passed: false,
                severity: "MEDIUM",
                message: "Heritage-adjacent context should remain in planner review: the site is not listed but is near 17 and 21 Ross Street heritage items and Bay Road Conservation Area, with Heritage Officer referral recorded.",
                expected: "Heritage referral risk acknowledged",
                actual: "Referral to Heritage Officer plus nearby heritage resources",
                evidence: ["Heritage Statement", "MasterView tracking table"],
            },
        ];

        const findings = [
            {
                key: "heritage_adjacency_review",
                severity: "MEDIUM",
                title: "Heritage-adjacent referral to review",
                detail: "The subject site is not a heritage item and is not within a conservation area, but the lodged material identifies nearby heritage items at 17 and 21 Ross Street and Bay Road Conservation Area. MasterView tracking records referral to the Heritage Officer.",
                evidence: ["Heritage Statement", "MasterView tracking table"],
                recommendation: "Keep the Heritage Statement and design response visible in the advisory report; do not treat the site as unconstrained merely because it is not listed.",
            },
        ];

        const summary = {
            executiveSummary: "DA172/2026 at 15A Ross Street is loaded as a live North Sydney MasterView control case. The app can show the real document pack, extract key planning controls, flag heritage-adjacent review, and avoid hallucinating a cl. 4.6 variation where the lodged SEE says controls are satisfied.",
            likelyRisks: ["Heritage-adjacent referral review"],
            missingDocs: [],
            recommendedNextSteps: [
                "Review the Heritage Officer referral once Council publishes assessment comments.",
                "Use the site plans and SEE as the source of truth for the no-cl. 4.6 control-case demo.",
                "Switch to a prepared breach fixture only for the separate cl. 4.6 drafting wow moment.",
            ],
            confidenceNote: "High confidence for application metadata and document-list facts from MasterView; advisory only until Council assessment is complete.",
            summary: "Live MasterView DA imported and ready as a no-hallucination control case.",
        };

        const facts = {
            siteArea: 241.4,
            frontage: 6.185,
            setbacks: {},
            height: null,
            floorArea: 172,
            fsr: null,
            overlays: ["heritage-adjacent", "heritage-officer-referral"],
            parking: null,
            bedrooms: null,
            missingConsultantDocs: [],
            detectedReports: application.documents.map((document) => document.fileType),
            confidence: 0.9,
            notes: "Ross Street MasterView control-case facts seeded from lodged SEE, site plans, survey, and heritage statement.",
        };

        const rules = {
            query: "North Sydney R2 semi-detached dwelling alterations DA172/2026",
            appliedFilters: {
                state: "NSW",
                council: application.council,
                projectType: projectSpecs.type,
                zoning: [application.zoning],
            },
            rules: [],
        };

        const createdProject = await prisma.project.create({
            data: {
                name: projectSpecs.name,
                description: projectSpecs.description,
                address: projectSpecs.address,
                type: projectSpecs.type,
                council: projectSpecs.council,
                userId,
                metadata: metadata as unknown as Prisma.InputJsonObject,
                Files: {
                    createMany: {
                        data: projectSpecs.files.map((file) => ({
                            name: file.filename,
                            url: file.url,
                            status: "PROCESSED",
                            metadata: {
                                mimeType: file.mimetype,
                                size: file.size,
                                fileType: file.fileType,
                                source: "north-sydney-masterview",
                                applicationNumber: application.applicationNumber,
                                stage: "PROCESSED",
                                completedAt: metadata.processingCompletedAt,
                            },
                            userId: file.userId,
                        })),
                    },
                },
                ProjectReport: {
                    create: {
                        status: "COMPLETED",
                        score: 88,
                        summary: summary.summary,
                        executiveSummary: summary.executiveSummary,
                        findingsJson: findings as Prisma.InputJsonValue,
                        factsJson: facts as Prisma.InputJsonValue,
                        rulesJson: rules as Prisma.InputJsonValue,
                        rawOutputJson: {
                            facts,
                            rules,
                            checks: {
                                checks,
                                findings,
                                score: 88,
                                riskLevel: "LOW",
                                missingDocuments: [],
                                likelyPathway: "Standard DA pathway with heritage-adjacent planner review",
                                blockingIssues: [],
                            },
                            summary,
                            issues: [],
                        } as Prisma.InputJsonObject,
                        content: {
                            summary,
                            checks: {
                                checks,
                                findings,
                                score: 88,
                                riskLevel: "LOW",
                                missingDocuments: [],
                                likelyPathway: "Standard DA pathway with heritage-adjacent planner review",
                                blockingIssues: [],
                            },
                        } as Prisma.InputJsonObject,
                        version: 1,
                        findings: {
                            create: findings.map((finding) => ({
                                ...finding,
                                evidence: finding.evidence as Prisma.InputJsonValue,
                            })),
                        },
                        checkResults: {
                            create: checks.map((check) => ({
                                key: check.key,
                                category: check.category,
                                passed: check.passed,
                                severity: check.severity,
                                message: check.message,
                                expected: check.expected as Prisma.InputJsonValue,
                                actual: check.actual as Prisma.InputJsonValue,
                                evidence: check.evidence as Prisma.InputJsonValue,
                            })),
                        },
                    },
                },
            },
        });

        return {
            ...createdProject,
            metadata: createdProject.metadata as unknown as Pick<ProjectStrict, "metadata">["metadata"],
        };
    } catch (error) {
        console.error("Error creating Ross Street MasterView demo project:", error);
        throw error;
    }
}

export async function getProjectsForUser(userId: string): Promise<ProjectStrict[]> {
    try {
        const projects = await prisma.project.findMany({
            where: {
                userId,
            }
        });

        return projects.map(project => ({
            ...project,
            metadata: project.metadata as unknown as Pick<ProjectStrict, "metadata">["metadata"],
        }));
    } catch (error) {
        console.error("Error fetching projects for user:", error);
        throw error;
    }
}

export async function createProject(projectSpecs: ProjectSpecs): Promise<ProjectStrict> {
    try {
        // Get GeoEncoding data for the project address
        const geoEncoding = await addressToCoordinatesGoogle(projectSpecs.address);

        if (!geoEncoding) {
            throw new Error(`Failed to geocode the provided address: ${projectSpecs.address}`);
        }

        const spatialConstraints = buildFixtureSpatialConstraints({
            address: projectSpecs.address,
            council: projectSpecs.council,
        });

        const newProject = await prisma.project.create({
            data: {
                name: projectSpecs.name,
                description: projectSpecs.description,
                address: projectSpecs.address,
                type: projectSpecs.type,
                council: projectSpecs.council,
                userId: projectSpecs.userId,
                metadata: {
                    geoEncoding: {
                        lat: geoEncoding.lat,
                        lng: geoEncoding.lng,
                    },
                    runId: null,
                    stage: projectSpecs.files.length > 0 ? ProjectStage.FILES_UPLOADED : ProjectStage.CREATED,
                    processingStatus: projectSpecs.files.length > 0 ? ProjectStatus.NEEDS_REVIEW : ProjectStatus.CREATED,
                    filesUpdatedAt: projectSpecs.files.length > 0 ? new Date().toISOString() : undefined,
                    spatialConstraints,
                    spatialConstraintsLoadedAt: SPATIAL_FIXTURE_RETRIEVED_AT,
                    spatialConstraintsSource: SpatialConstraintSource.FIXTURE,
                },
                Files: {
                    createMany: {
                        data: projectSpecs.files.map(file => ({
                            name: file.filename,
                            url: file.url,
                            metadata: {
                                mimeType: file.mimetype,
                                size: file.size,
                                fileType: file.fileType,
                            },
                            userId: file.userId,
                        })),
                    },
                }
            }
        });

        return {
            ...newProject,
            metadata: newProject.metadata as unknown as Pick<ProjectWithFiles, "metadata">["metadata"],
        };
    } catch (error) {
        console.error("Error creating project:", error);
        throw error;
    }
}

export async function getProjectById(projectId: string): Promise<ProjectWithFiles> {
    try {
        const project = await prisma.project.findUnique({
            where: {
                id: projectId,
            },
            include: {
                Files: true,
            }
        });

        if (!project) {
            throw new Error(`Project not found for ID: ${projectId}`);
        }

        return {
            ...project,
            metadata: project.metadata as unknown as Pick<ProjectWithFiles, "metadata">["metadata"],
            Files: project.Files.map(file => ({
                ...file,
                metadata: file.metadata as Pick<FilesStrict, "metadata">["metadata"],
            })),
        };
    } catch (error) {
        console.error("Error fetching project by ID:", error);
        throw error;
    }
}

export async function deleteProject(projectId: string): Promise<void> {
    try {
        await prisma.project.delete({
            where: {
                id: projectId,
            },
        });
    } catch (error) {
        console.error("Error deleting project:", error);
        throw error;
    }
}

function mergeMetadata(
    current: Record<string, unknown>,
    patch?: Record<string, unknown>
): Prisma.InputJsonValue {
    if (!patch) {
        return current as Prisma.InputJsonObject;
    }

    const merged = deepMerge(current, patch);
    return merged as Prisma.InputJsonObject;
}

function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>
): Record<string, unknown> {
    const output: Record<string, unknown> = { ...target };

    for (const [key, value] of Object.entries(source)) {
        if (
            isPlainObject(value) &&
            isPlainObject(output[key])
        ) {
            output[key] = deepMerge(
                output[key] as Record<string, unknown>,
                value as Record<string, unknown>
            );
            continue;
        }

        output[key] = value;
    }

    return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function updateProjectMetadata(projectId: string, metadata: Partial<Pick<ProjectStrict, "metadata">["metadata"]>): Promise<void> {
    try {
        const project = await prisma.project.findUnique({
            where: {
                id: projectId,
            },
        });
        if (!project) {
            throw new Error(`Project not found for ID: ${projectId}`);
        }
        const currentMetadata = project.metadata as unknown as Record<string, unknown>;
        const mergedMetadata = mergeMetadata(currentMetadata, metadata);

        await prisma.project.update({
            where: {
                id: projectId,
            },
            data: {
                metadata: mergedMetadata,
            },
        });

    } catch (error) {
        console.error("Error updating project metadata:", error);
        throw error;
    }
}

export async function fetchProjectGeneratedReports(projectId: string): Promise<GenerateProjectReport[]> {
    try {
        const reports = await prisma.projectReport.findMany({
            where: {
                projectId,
            },
            orderBy: [
                { version: "desc" },
                { createdAt: "desc" },
            ],
            include: {
                findings: true,
                checkResults: true,
            }
        });

        return reports.map(report => ({
            ...report,
            facts: report.factsJson as unknown as ExtractedFacts,
            rules: report.rulesJson as unknown as RulesPack,
            content: report.content as unknown as Pick<GenerateProjectReport, "content">["content"],
            rawOutput: report.rawOutputJson as unknown as Pick<GenerateProjectReport, "rawOutput">["rawOutput"],
        }));
    } catch (error) {
        console.error("Error fetching generated reports for project:", error);
        throw error;
    }
}
