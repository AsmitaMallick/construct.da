import type { OCRResponse, OCRPageObject } from "@mistralai/mistralai/models/components";
import { RuleFiles } from "@prisma/client";
import type { IngestionConfig, RuleFilePrisma, SemanticChunk } from "@models/types";
import { processPDFWithMistral } from "../ocr";
import { parseOCRDocument } from "../parser";
import {prisma} from "../prisma";
import { buildSemanticChunks } from "../chunks";
import { generateEmbeddings, saveEmbeddingsToDB } from "../embedding";
import { convertJsonToListArray } from "../utils";
import {
  asJsonObject,
  buildIngestionConfig,
  MAX_ERROR_MESSAGE_LENGTH,
  processItemsConcurrently,
  normalizeOCRResult,
  summarizeIngestionResults,
  toErrorMessage,
  withRetries,
  mergeMetadata,
  resolveIngestionConfig,
} from "./ingestion-shared";

export interface IngestRuleFilesConfig {
  batchSize?: number;
  concurrency?: number;
  fileIds?: string[];
  retryFailed?: boolean;
  maxRetries?: number;
  embeddingBatchSize?: number;
  requestDelayMs?: number;
}

interface IngestSummary {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

interface FileProcessResult {
  fileId: string;
  status: "succeeded" | "failed" | "skipped";
  reason?: string;
}

function resolveRuleConfig(config?: unknown): Required<IngestRuleFilesConfig> {
  return resolveIngestionConfig(config);
}

export async function handleIngestRuleFiles(config?: unknown) {
  "use workflow";

  const effectiveConfig = resolveRuleConfig(config);
  console.log("Ingesting rule files with config:", effectiveConfig);

  const { files, length } = await fetchRuleFiles(effectiveConfig);
  if (length === 0) {
    return {
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    } satisfies IngestSummary;
  }

  const results = await processItemsConcurrently(
    files,
    effectiveConfig.concurrency,
    async (file) => processSingleRuleFile(file, effectiveConfig),
  );

  return summarizeIngestionResults(results, length);
}

async function fetchRuleFiles(config: Required<IngestRuleFilesConfig>) {
  "use step";

  try {
    const statuses: Array<"PENDING" | "REJECTED"> = config.retryFailed
      ? ["PENDING", "REJECTED"]
      : ["PENDING"];

    const ruleFiles = await prisma.ruleFiles.findMany({
      where: {
        status: { in: statuses },
        ...(config.fileIds.length > 0 ? { id: { in: config.fileIds } } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
      take: config.batchSize,
    });

    return {
      files: ruleFiles,
      length: ruleFiles.length,
    };
  } catch (error) {
    console.error("Error fetching rule files:", error);
    throw error;
  }
}

async function processSingleRuleFile(
  file: RuleFiles,
  config: Required<IngestRuleFilesConfig>,
): Promise<FileProcessResult> {
  const fileId = file.id;

  if (!file.url) {
    await handleFailure(fileId, new Error("File URL is missing"));
    return { fileId, status: "failed", reason: "missing_url" };
  }

  try {
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
          toRuleFilePrisma(file),
          buildIngestionConfig(config),
        );
        logFile(fileId, `Chunked into ${chunks.length} chunks`);

        if (chunks.length === 0) {
          return { chunks: 0, skipped: true };
        }

        await persistEmbeddings(
          fileId,
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
      await markStatus(fileId, "APPROVED", {
        ingestion: {
          stage: "COMPLETED_WITHOUT_CHUNKS",
          completedAt: new Date().toISOString(),
        },
      });

      return { fileId, status: "skipped", reason: "no_chunks" };
    }

    await markStatus(fileId, "APPROVED", {
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
  file: RuleFilePrisma,
  ingestionConfig: IngestionConfig,
) {
  return buildSemanticChunks(cleanedPages, structure, file, ingestionConfig);
}

async function persistEmbeddings(
  fileId: string,
  chunks: SemanticChunk[],
  embeddingBatchSize: number,
  requestDelayMs: number,
) {
  "use step";

  await prisma.fileEmbedding.deleteMany({ where: { ruleFileId: fileId } });

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

    await saveEmbeddingsToDB(prisma, embedResult, null, fileId, { batch, offset });

    // Use a delay between batches to avoid overwhelming the embedding service
    await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
  }
}

async function markStatus(
  fileId: string,
  status: "APPROVED" | "REJECTED",
  metadataPatch?: Record<string, unknown>,
) {
  "use step";

  const existing = await prisma.ruleFiles.findUnique({
    where: { id: fileId },
    select: { metadata: true },
  });

  const mergedMetadata = mergeMetadata(
    asJsonObject(existing?.metadata),
    metadataPatch,
  );

  await prisma.ruleFiles.update({
    where: { id: fileId },
    data: {
      status,
      ingestedAt: status === "APPROVED" ? new Date() : undefined,
      metadata: mergedMetadata,
    },
  });
}

async function handleFailure(fileId: string, error: unknown) {
  "use step";

  const errorMessage = toErrorMessage(error).slice(0, MAX_ERROR_MESSAGE_LENGTH);
  logFile(fileId, `Failed: ${errorMessage}`);

  await markStatus(fileId, "REJECTED", {
    ingestion: {
      stage: "FAILED",
      failedAt: new Date().toISOString(),
      error: errorMessage,
    },
  });
}

async function updateFileMetadata(
  fileId: string,
  metadataPatch: Record<string, unknown>,
) {
  "use step";

  const existing = await prisma.ruleFiles.findUnique({
    where: { id: fileId },
    select: { metadata: true },
  });

  const mergedMetadata = mergeMetadata(
    asJsonObject(existing?.metadata),
    metadataPatch,
  );

  await prisma.ruleFiles.update({
    where: { id: fileId },
    data: {
      metadata: mergedMetadata,
    },
  });
}

function toRuleFilePrisma(file: RuleFiles): RuleFilePrisma {
  const metadata = asJsonObject(file.metadata);

  return {
    ...file,
    metadata: metadata as RuleFilePrisma["metadata"],
  };
}

function logFile(fileId: string, message: string) {
  console.log(`[${fileId}] ${message}`);
}
