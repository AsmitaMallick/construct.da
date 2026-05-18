import {prisma} from "../prisma";
import { getWritable } from "workflow";
import { start } from "workflow/api";
import { processPDFWithMistral } from "../ocr";
import { parseOCRDocument } from "../parser";
import { buildSemanticChunks } from "../chunks";
import { generateEmbeddings, saveEmbeddingsToDB } from "../embedding";
import type { IngestionConfig, SemanticChunk } from "@models/types";
import type {
  OCRPageObject,
  OCRResponse,
} from "@mistralai/mistralai/models/components";
import { FilesStrict, ProcessingProjectFileStatus, ProjectStage } from "@models/data";
import { updateProjectMetadata } from "@/lib/actions/projects";
import { convertJsonToListArray } from "../utils";
import { generateProjectReport } from "@workflows/generate-project-report";
import {
  buildIngestionConfig,
  asJsonObject,
  resolveIngestionConfig,
  MAX_ERROR_MESSAGE_LENGTH,
  processItemsConcurrently,
  normalizeOCRResult,
  summarizeIngestionResults,
  toErrorMessage,
  withRetries,
  mergeMetadata,
} from "./ingestion-shared";

export interface ProjectFilesConfig {
  batchSize?: number;
  concurrency?: number;
  fileIds?: string[];
  retryFailed?: boolean;
  maxRetries?: number;
  embeddingBatchSize?: number;
  requestDelayMs?: number;
}

interface ProjectFilesSummary {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

interface ProcessingProgressState {
  completedFiles: string[];
  failedFiles: string[];
  processingFiles: string[];
}

interface FileProcessResult {
  fileId: string;
  status: "succeeded" | "failed" | "skipped";
  reason?: string;
}

export async function processProjectFiles(
  projectId: string,
  config?: unknown,
) {
  "use workflow";

  const effectiveConfig = resolveProjectConfig(config);
  console.log("Effective configuration for processing project files:", effectiveConfig);

  const progress: ProcessingProgressState = {
    completedFiles: [],
    failedFiles: [],
    processingFiles: [],
  };

  try {
    const { files, length } = await fetchProjectFiles(projectId, effectiveConfig);
    if (length === 0) {
      await emitProgress(length, progress, false, true, null);
      return {
        total: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      } satisfies ProjectFilesSummary;
    }

    progress.processingFiles = files.map((file) => file.id);
    await emitProgress(length, progress, false, false, null);

    const results = await processItemsConcurrently(
      files,
      effectiveConfig.concurrency,
      async (file) => {
        const result = await processSingleFile(file, effectiveConfig);
        progress.processingFiles = progress.processingFiles.filter((id) => id !== file.id);
        if (result.status === "failed") {
          progress.failedFiles.push(file.id);
        } else {
          progress.completedFiles.push(file.id);
        }
        await emitProgress(length, progress, false, false, null);
        return result;
      },
    );

    const summary = summarizeIngestionResults(results, length);
    if (summary.succeeded > 0) {
      await triggerReportGeneration(projectId, summary, progress);
    } else {
      await emitProgress(length, progress, false, true, null);
    }

    return summary;
  } finally {
    await finalizeStream();
  }
}

function resolveProjectConfig(config?: unknown): Required<ProjectFilesConfig> {
  return resolveIngestionConfig(config);
}

async function fetchProjectFiles(
  projectId: string,
  config: Required<ProjectFilesConfig>,
): Promise<{ files: FilesStrict[]; length: number }> {
  "use step";

  try {
    const statuses: Array<"PENDING" | "FAILED"> = config.retryFailed
      ? ["PENDING", "FAILED"]
      : ["PENDING"];

    const files = await prisma.$transaction(async (tx) => {
      const candidates = await tx.files.findMany({
        where: {
          projectId,
          status: { in: statuses },
          ...(config.fileIds.length > 0 ? { id: { in: config.fileIds } } : {}),
        },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true },
        take: config.batchSize,
      });

      const claimedIds: string[] = [];
      for (const candidate of candidates) {
        const claim = await tx.files.updateMany({
          where: {
            id: candidate.id,
            projectId,
            status: { in: statuses },
          },
          data: {
            status: "PROCESSING",
          },
        });

        if (claim.count === 1) {
          claimedIds.push(candidate.id);
        }
      }

      if (claimedIds.length === 0) {
        return [];
      }

      return tx.files.findMany({
        where: {
          id: { in: claimedIds },
          projectId,
          status: "PROCESSING",
        },
        orderBy: [{ createdAt: "asc" }],
      });
    });

    return {
      files: files.map((file) => ({
        ...file,
        metadata: file.metadata as FilesStrict["metadata"],
      })),
      length: files.length,
    };
  } catch (error) {
    console.error("Error fetching project files:", error);
    throw new Error(
      `Failed to fetch project files for project ${projectId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function processSingleFile(
  file: FilesStrict,
  config: Required<ProjectFilesConfig>,
): Promise<FileProcessResult> {
  const fileId = file.id;
  const projectId = file.projectId;

  if (!file.url) {
    await handleFailure(fileId, new Error("File URL is missing"));
    return { fileId, status: "failed", reason: "missing_url" };
  }

  try {
    if (!projectId) {
      throw new Error(`Project ID is missing for file ${fileId}`);
    }

    await updateFileMetadata(fileId, {
      ingestion: {
        stage: "STARTED",
        startedAt: new Date().toISOString(),
      },
    });

    const attemptResult = await withRetries(
      async (attempt) => {
        logFile(fileId, `OCR started (attempt ${attempt}/${config.maxRetries})`);
        const ocrResult = await runOCR(file.url);
        logFile(fileId, "OCR complete");

        const normalizedOcrResult = normalizeOCRResult(ocrResult);
        const { cleanedPages, structure } = parseOCRResult(normalizedOcrResult);
        logFile(fileId, `Parsed into ${structure.headings.length} headings`);

        const chunks = createChunks(
          cleanedPages,
          structure,
          file,
          buildIngestionConfig(config),
        );
        logFile(fileId, `Chunked into ${chunks.length} chunks`);

        if (chunks.length === 0) {
          return { chunks: 0, skipped: true };
        }

        await persistEmbeddings(
          fileId,
          projectId,
          chunks,
          config.embeddingBatchSize,
          config.requestDelayMs,
        );
        logFile(fileId, "Embedded successfully");

        return { chunks: chunks.length, skipped: false };
      },
      config.maxRetries,
      fileId,
      (attempt, message) => logFile(fileId, `Attempt ${attempt} failed: ${message}`),
    );

    if (attemptResult.skipped) {
      await markStatus(fileId, "PROCESSED", {
        ingestion: {
          stage: "COMPLETED_WITHOUT_CHUNKS",
          completedAt: new Date().toISOString(),
        },
      });

      return { fileId, status: "skipped", reason: "no_chunks" };
    }

    await markStatus(fileId, "PROCESSED", {
      ingestion: {
        stage: "COMPLETED",
        completedAt: new Date().toISOString(),
        chunks: attemptResult.chunks,
      },
    });

    return { fileId, status: "succeeded" };
  } catch (error) {
    await handleFailure(fileId, error);
    return {
      fileId,
      status: "failed",
      reason: toErrorMessage(error),
    };
  }
}

function logFile(fileId: string, message: string) {
  console.log(`[${fileId}] ${message}`);
}

async function handleFailure(fileId: string, error: unknown) {
  "use step";

  const errorMessage = toErrorMessage(error).slice(0, MAX_ERROR_MESSAGE_LENGTH);
  logFile(fileId, `Failed: ${errorMessage}`);

  await markStatus(fileId, "FAILED", {
    ingestion: {
      stage: "FAILED",
      failedAt: new Date().toISOString(),
      error: errorMessage,
    },
  });
}

async function markStatus(
  fileId: string,
  status: "PROCESSED" | "FAILED",
  metadataPatch?: Record<string, unknown>,
) {
  "use step";

  const existing = await prisma.files.findUnique({
    where: { id: fileId },
    select: { metadata: true },
  });

  const mergedMetadata = mergeMetadata(
    asJsonObject(existing?.metadata),
    metadataPatch,
  );

  await prisma.files.update({
    where: { id: fileId },
    data: {
      status,
      metadata: mergedMetadata,
    },
  });
}

async function updateFileMetadata(
  fileId: string,
  metadataPatch: Record<string, unknown>,
) {
  "use step";

  const existing = await prisma.files.findUnique({
    where: { id: fileId },
    select: { metadata: true },
  });

  const mergedMetadata = mergeMetadata(
    asJsonObject(existing?.metadata),
    metadataPatch,
  );

  await prisma.files.update({
    where: { id: fileId },
    data: {
      metadata: mergedMetadata,
    },
  });
}

async function runOCR(fileUrl: string) {
  "use step";

  return processPDFWithMistral(fileUrl);
}

function parseOCRResult(ocrResult: OCRResponse) {
  return parseOCRDocument(ocrResult);
}

function createChunks(
  cleanedPages: Array<{ page: OCRPageObject; cleanedMarkdown: string }>,
  structure: ReturnType<typeof parseOCRDocument>["structure"],
  file: FilesStrict,
  ingestionConfig: IngestionConfig,
) {
  return buildSemanticChunks(cleanedPages, structure, file, ingestionConfig);
}

async function persistEmbeddings(
  fileId: string,
  projectId: string,
  chunks: SemanticChunk[],
  embeddingBatchSize: number,
  requestDelayMs: number,
) {
  "use step";

  await prisma.fileEmbedding.deleteMany({ where: { fileId } });

  for (let offset = 0; offset < chunks.length; offset += embeddingBatchSize) {
    const batch = chunks.slice(offset, offset + embeddingBatchSize);
    const embeddingInput = batch.map((chunk) => {
      const context = convertJsonToListArray(chunk, {
        nullValue: "Not Present",
        maxValueLength: 300,
      });
      return { text: chunk.content, context };
    });
    const embedResult = await generateEmbeddings(embeddingInput);

    if (embedResult.embeddings.length !== batch.length) {
      throw new Error(
        `Embedding result mismatch for file ${fileId}: ` +
          `${embedResult.embeddings.length} vectors for ${batch.length} chunks`,
      );
    }

    await saveEmbeddingsToDB(prisma, embedResult, fileId, null, { batch, offset }, projectId);

    // Delay between batches to avoid overwhelming the embedding service
    await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
  }
}

async function triggerReportGeneration(
  projectId: string,
  summary: ProjectFilesSummary,
  progress: ProcessingProgressState,
) {
  "use step";
  try {
    const run = await start(generateProjectReport, [{ projectId }]);

    await updateProjectMetadata(projectId, {
      stage: ProjectStage.COMPLIANCE_REVIEW,
      runId: run.runId,
    });

    console.log("Report generation run started", run.runId);
    await emitProgress(summary.total, progress, true, true, run.runId);

    return {
      success: true,
      runId: run.runId,
    };
  } catch (error) {
    console.error(`Failed to trigger report generation for project ${projectId}:`, error);
    throw new Error(
      `Failed to trigger report generation for project ${projectId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function emitProgress(
  total: number,
  progress: ProcessingProgressState,
  includeFailedInCompleted: boolean,
  processingComplete: boolean,
  nextRunId: string | null,
) {
  const completed = includeFailedInCompleted
    ? progress.completedFiles.length + progress.failedFiles.length
    : progress.completedFiles.length;

  await writeToStream({
    completed,
    total,
    failed: progress.failedFiles.length,
    completedFiles: [...progress.completedFiles],
    failedFiles: [...progress.failedFiles],
    processingFiles: [...progress.processingFiles],
    processingComplete,
    nextRunId,
  });
}

async function writeToStream(data: ProcessingProjectFileStatus) {
  "use step";
  // Stream operations must happen in steps
  const writable = getWritable<ProcessingProjectFileStatus>();
  const writer = writable.getWriter();
  await writer.write(data);
  writer.releaseLock();
}

async function finalizeStream() {
  "use step";
  await getWritable().close(); // Signal completion
}
