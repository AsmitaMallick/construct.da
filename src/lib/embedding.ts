import { google, GoogleEmbeddingModelOptions } from '@ai-sdk/google';
import { embed, embedMany } from 'ai';
import { Prisma } from '@prisma/client';
import {prisma} from './prisma';
import { SemanticChunk } from '@models/types';

const DEFAULT_EMBEDDING_CHUNK_SIZE = 100;
const MAX_EMBEDDING_CHUNK_RETRIES = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 250;

type EmbeddingWriteClient = Prisma.TransactionClient | typeof prisma;

type GoogleContent = { text: string } | { inlineData: { mimeType: string; data: string } };

// ─── Filters that can be passed to narrow hybrid search ──────────────────────
export interface SearchFilters {
    fileId?: string;
    projectId?: string;
    clause?: string;
    zone?: string;
    topic?: string;
    source?: string;
    pageNumber?: number;
}

type HybridSearchRow = {
  id: string;
  fileId: string | null;
  ruleFileId: string | null;
  projectId: string | null;
  chunkIndex: number | null;
  pageNumber: number | null;
  title: string | null;
  content: string;
  source: string | null;
  clause: string | null;
  zone: string | null;
  topic: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  vectorScore: number;
  bm25Score: number;
  hybridScore: number;
};

// ─── A single result row returned from hybrid search ─────────────────────────
export interface HybridSearchResult {
    id: string;
    fileId: string | null;
    ruleFileId: string | null;
    projectId: string | null;
    chunkIndex: number;
    pageNumber: number | null;
    title: string | null;
    content: string;
    source: string | null;
    clause: string | null;
    zone: string | null;
    topic: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    // Scores
    vectorScore: number;   // cosine similarity  (0 – 1)
    bm25Score: number;     // full-text rank      (0 – n)
    hybridScore: number;   // RRF-fused final score
}

// ─────────────────────────────────────────────────────────────────────────────
//  Embedding helpers (already provided – kept for completeness)
// ─────────────────────────────────────────────────────────────────────────────

export async function generateEmbedding(text: string, content?: GoogleContent[]) {
    try {
        const embedding = await embed({
            model: google.embedding('gemini-embedding-001'),
            value: text,
            providerOptions: {
                google: {
                    taskType: 'RETRIEVAL_QUERY',
                    content: content && content.length > 0 ? [content] : undefined,
                } satisfies GoogleEmbeddingModelOptions,
            },
        });
        return embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        throw error;
    }
}

export async function generateEmbeddings(
    input: { text: string; content?: GoogleContent[] }[]
) {
    try {
        const embeddings = await embedMany({
            model: google.embedding('gemini-embedding-001'),
            values: input.map((item) => item.text),
            providerOptions: {
                google: {
                    taskType: 'RETRIEVAL_QUERY',
                    content: input.map((item) =>
                        item.content && item.content.length > 0 ? item.content : null
                    ),
                } satisfies GoogleEmbeddingModelOptions,
            },
        });
        return embeddings;
    } catch (error) {
        console.error('Error generating embeddings:', error);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  saveEmbeddingsToDB
//  Persists every chunk returned by embedMany() into FileEmbedding rows.
//
//  The function expects that the embedMany result carries parallel arrays
//  `values` (the original text chunks) and `embeddings` (float arrays).
//  Extra per-chunk metadata is merged with the shared `metadata` argument.
// ─────────────────────────────────────────────────────────────────────────────

export async function saveEmbeddingsToDB(
    db: EmbeddingWriteClient,
    result: Awaited<ReturnType<typeof embedMany>>,
    fileId: string| null = null,
    ruleFileId: string | null = null,
    /**
     * Shared metadata applied to every chunk.
     * Keys recognised by the schema (title, source, clause, zone, topic,
     * pageNumber) are lifted to first-class columns; everything else goes
     * into the `metadata` JSON column.
     */
    metadata?: {
        batch: SemanticChunk[];
        offset: number;
    },
    projectId?: string
) {
    const operationStartedAt = Date.now();

    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        });

    const chunkSizeFromEnv = Number.parseInt(process.env.EMBEDDING_DB_CHUNK_SIZE ?? '', 10);
    const chunkSize =
        Number.isInteger(chunkSizeFromEnv) && chunkSizeFromEnv > 0
            ? chunkSizeFromEnv
            : DEFAULT_EMBEDDING_CHUNK_SIZE;

    const isTransientWriteError = (error: unknown) => {
        if (!(error instanceof Error)) {
            return false;
        }

        const prismaError = error as Error & { code?: string };
        const transientCodes = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);
        if (prismaError.code && transientCodes.has(prismaError.code)) {
            return true;
        }

        const message = error.message.toLowerCase();
        return (
            message.includes('timeout') ||
            message.includes('deadlock') ||
            message.includes('could not serialize') ||
            message.includes('connection reset') ||
            message.includes('too many clients')
        );
    };

    const executeWithRetry = async (
        operation: () => Promise<void>,
        chunkNumber: number,
        totalChunks: number
    ) => {
        for (let attempt = 1; attempt <= MAX_EMBEDDING_CHUNK_RETRIES; attempt++) {
            try {
                await operation();
                return;
            } catch (error) {
                const shouldRetry =
                    attempt < MAX_EMBEDDING_CHUNK_RETRIES && isTransientWriteError(error);

                if (!shouldRetry) {
                    throw error;
                }

                const delayMs = EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
                console.warn(
                    `[Embeddings] Chunk ${chunkNumber}/${totalChunks} write failed (attempt ${attempt}/${MAX_EMBEDDING_CHUNK_RETRIES}). Retrying in ${delayMs}ms`,
                    {
                        fileId,
                        ruleFileId,
                        projectId,
                        error,
                    }
                );
                await sleep(delayMs);
            }
        }
    };

    try {
        if (!result.values || result.values.length === 0) {
            console.warn('saveEmbeddingsToDB: no values to save');
            return { saved: 0 };
        }

        const { values, embeddings } = result;

        if (values.length !== embeddings.length) {
            throw new Error(
                `Mismatch: ${values.length} chunks vs ${embeddings.length} embeddings`
            );
        }

        // ── Resolve per-chunk metadata from the batch array ─────────────────
        const batch = metadata?.batch ?? [];
        const offset = metadata?.offset ?? 0;

        // ── Build individual INSERT statements via raw SQL so we can write
        //    the pgvector `embedding` column and the tsvector column directly.
        //    Prisma does not yet support Unsupported() columns in create().
        // ────────────────────────────────────────────────────────────────────

        let saved = 0;
        const totalChunks = Math.ceil(values.length / chunkSize);

        for (let batchStart = 0; batchStart < values.length; batchStart += chunkSize) {
            const chunkStartTime = Date.now();
            const batchEnd = Math.min(batchStart + chunkSize, values.length);
            const chunkNumber = Math.floor(batchStart / chunkSize) + 1;
            const rowsSql: Prisma.Sql[] = [];

            console.info(
                `[Embeddings] Saving chunk ${chunkNumber}/${totalChunks} (${batchEnd - batchStart} rows)`,
                {
                    fileId,
                    ruleFileId,
                    projectId,
                }
            );

            for (let i = batchStart; i < batchEnd; i++) {
                const chunkIndex = offset + i;
                const content = values[i] as string;
                const vector = embeddings[i];          // number[]
                const chunk = batch[i];
                const title = chunk?.title ?? null;
                const source = chunk?.source ?? null;
                const clause = chunk?.clause ?? null;
                const zone = chunk?.zone ?? null;
                const topic = chunk?.topic ?? null;
                const pageNumber = typeof chunk?.pageNumber === 'number' ? chunk.pageNumber : null;
                const perChunkMeta =
                    chunk?.metadata && typeof chunk.metadata === 'object' ? chunk.metadata : {};

                // Merged JSON metadata stored in the metadata column
                const jsonMeta = {
                    ...perChunkMeta,
                };

                // pgvector literal: '[0.1,0.2,...]'
                const vectorLiteral = `[${vector.join(',')}]`;

                // tsvector: combine title + content for richer full-text index
                const tsInput = [title, content].filter(Boolean).join(' ');

                rowsSql.push(
                    Prisma.sql`(
                        gen_random_uuid(),
                        ${fileId},
                        ${ruleFileId},
                        ${chunkIndex},
                        ${pageNumber},
                        ${title ?? null},
                        ${content},
                        ${source ?? null},
                        ${clause ?? null},
                        ${zone ?? null},
                        ${topic ?? null},
                        ${vectorLiteral}::vector,
                        to_tsvector('english', ${tsInput}),
                        ${JSON.stringify(jsonMeta)}::jsonb,
                        NOW(),
                        ${projectId ?? null}
                    )`
                );
            }

            await executeWithRetry(
                async () => {
                    await db.$executeRaw(
                        Prisma.sql`
                            INSERT INTO "FileEmbedding" (
                                id,
                                "fileId",
                                "ruleFileId",
                                "chunkIndex",
                                "pageNumber",
                                title,
                                content,
                                source,
                                clause,
                                zone,
                                topic,
                                embedding,
                                search_vector,
                                metadata,
                                "createdAt",
                                "projectId"
                            ) VALUES ${Prisma.join(rowsSql)}
                        `
                    );
                },
                chunkNumber,
                totalChunks
            );

            saved += rowsSql.length;
            console.info(`[Embeddings] Chunk saved in ${Date.now() - chunkStartTime}ms`, {
                chunkNumber,
                totalChunks,
                rows: rowsSql.length,
                fileId,
                ruleFileId,
                projectId,
            });
        }

        console.info(`[Embeddings] Total saved: ${saved}`, {
            fileId,
            ruleFileId,
            projectId,
            elapsedMs: Date.now() - operationStartedAt,
            chunkSize,
        });
        return { saved };
    } catch (error) {
        console.error('Error saving embeddings to DB:', error);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  getRelevantContentForQuery
//
//  Hybrid search combining:
//    1. Vector similarity  – cosine distance via pgvector (<=>)
//    2. Full-text search   – ts_rank_cd on the pre-built tsvector column
//    3. Reciprocal Rank Fusion (RRF) to merge both ranked lists
//
//  RRF formula:  score(d) = Σ  1 / (k + rank_i(d))
//  where k=60 is the standard constant that dampens rank differences.
//
//  Optional `filters` narrow the candidate set before ranking.
// ─────────────────────────────────────────────────────────────────────────────

export async function getRelevantContentForQuery(
    query: string,
    topK: number = 5,
    filters: SearchFilters = {},
    options: {
        /**
         * Weight for vector side in Reciprocal Rank Fusion.
         * bm25Weight = 1 - vectorWeight
         */
        vectorWeight?: number;

        /**
         * Minimum hybrid score threshold.
         */
        minScore?: number;
    } = {}
): Promise<HybridSearchResult[]> {
    try {
        const { vectorWeight = 0.7, minScore = 0 } = options;
        const bm25Weight = 1 - vectorWeight;
        const RRF_K = 60;

        // ─────────────────────────────────────────────────────────────
        // 1. Build embedding for semantic search
        // ─────────────────────────────────────────────────────────────
        const { embedding } = await generateEmbedding(query);
        const vectorLiteral = `[${embedding.join(',')}]`;

        // ─────────────────────────────────────────────────────────────
        // 2. Dynamic filters
        // ─────────────────────────────────────────────────────────────
        const conditions: Prisma.Sql[] = [];

        if (filters.fileId) {
            conditions.push(
                Prisma.sql`fe."fileId" = ${filters.fileId}`
            );
        }

        if (filters.projectId) {
            conditions.push(
                Prisma.sql`fe."projectId" = ${filters.projectId}`
            );
        }

        if (filters.clause) {
            conditions.push(
                Prisma.sql`fe.clause = ${filters.clause}`
            );
        }

        if (filters.zone) {
            conditions.push(
                Prisma.sql`fe.zone = ${filters.zone}`
            );
        }

        if (filters.topic) {
            conditions.push(
                Prisma.sql`fe.topic = ${filters.topic}`
            );
        }

        if (filters.source) {
            conditions.push(
                Prisma.sql`fe.source = ${filters.source}`
            );
        }

        if (filters.pageNumber !== undefined) {
            conditions.push(
                Prisma.sql`fe."pageNumber" = ${filters.pageNumber}`
            );
        }

        const whereClause =
            conditions.length > 0
                ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
                : Prisma.sql``;

        const tsQuery = query.trim();

        // ─────────────────────────────────────────────────────────────
        // 3. Hybrid Search
        // ─────────────────────────────────────────────────────────────
        const rows = await prisma.$queryRaw<HybridSearchRow[]>`
            WITH

            -- ======================================================
            -- VECTOR SEARCH ARM
            -- ======================================================
            vector_ranked AS (
                SELECT
                    fe.id,
                    fe."fileId",
                    fe."ruleFileId",
                    fe."projectId",
                    fe."chunkIndex",
                    fe."pageNumber",
                    fe.title,
                    fe.content,
                    fe.source,
                    fe.clause,
                    fe.zone,
                    fe.topic,
                    fe.metadata,
                    fe."createdAt",

                    1 - (fe.embedding <=> ${vectorLiteral}::vector)
                        AS vector_score,

                    ROW_NUMBER() OVER (
                        ORDER BY fe.embedding <=> ${vectorLiteral}::vector ASC
                    ) AS vector_rank

                FROM "FileEmbedding" fe
                ${whereClause}
            ),

            -- ======================================================
            -- FULL TEXT SEARCH ARM
            -- ======================================================
            bm25_ranked AS (
                SELECT
                    fe.id,

                    ts_rank_cd(
                        fe.search_vector,
                        plainto_tsquery('english', ${tsQuery}),
                        32
                    ) AS bm25_score,

                    ROW_NUMBER() OVER (
                        ORDER BY ts_rank_cd(
                            fe.search_vector,
                            plainto_tsquery('english', ${tsQuery}),
                            32
                        ) DESC
                    ) AS bm25_rank

                FROM "FileEmbedding" fe

                ${
                    conditions.length > 0
                        ? Prisma.sql`
                            WHERE
                                ${Prisma.join(
                                    conditions,
                                    ' AND '
                                )}
                                AND fe.search_vector @@ plainto_tsquery('english', ${tsQuery})
                        `
                        : Prisma.sql`
                            WHERE fe.search_vector @@ plainto_tsquery('english', ${tsQuery})
                        `
                }
            ),

            -- ======================================================
            -- MERGE BOTH ARMS
            -- ======================================================
            merged AS (
                SELECT
                    COALESCE(v.id, b.id) AS id,

                    v."fileId",
                    v."ruleFileId",
                    v."projectId",
                    v."chunkIndex",
                    v."pageNumber",
                    v.title,
                    v.content,
                    v.source,
                    v.clause,
                    v.zone,
                    v.topic,
                    v.metadata,
                    v."createdAt",

                    COALESCE(v.vector_score, 0) AS "vectorScore",
                    COALESCE(b.bm25_score, 0)   AS "bm25Score",

                    (
                        ${vectorWeight}::float *
                        (1.0 / (${RRF_K} + COALESCE(v.vector_rank, 1000000)))

                        +

                        ${bm25Weight}::float *
                        (1.0 / (${RRF_K} + COALESCE(b.bm25_rank, 1000000)))
                    ) AS "hybridScore"

                FROM vector_ranked v
                FULL OUTER JOIN bm25_ranked b
                    ON v.id = b.id
            )

            -- ======================================================
            -- FINAL RESULT
            -- ======================================================
            SELECT
                id,
                "fileId",
                "ruleFileId",
                "projectId",
                "chunkIndex",
                "pageNumber",
                title,
                content,
                source,
                clause,
                zone,
                topic,
                metadata,
                "createdAt",
                "vectorScore",
                "bm25Score",
                "hybridScore"
            FROM merged
            WHERE
                id IS NOT NULL
                AND "hybridScore" >= ${minScore}::float
            ORDER BY "hybridScore" DESC
            LIMIT ${topK}
        `;

        // ─────────────────────────────────────────────────────────────
        // 4. Normalize raw prisma result
        // ─────────────────────────────────────────────────────────────
        const results: HybridSearchResult[] = rows.map((row) => ({
            id: String(row.id),
            fileId: row.fileId ? String(row.fileId) : null,
            ruleFileId: row.ruleFileId ? String(row.ruleFileId) : null,
            projectId: row.projectId ? String(row.projectId) : null,
            chunkIndex: Number(row.chunkIndex),
            pageNumber:
                row.pageNumber !== null
                    ? Number(row.pageNumber)
                    : null,
            title: row.title ?? null,
            content: row.content,
            source: row.source ?? null,
            clause: row.clause ?? null,
            zone: row.zone ?? null,
            topic: row.topic ?? null,
            metadata: row.metadata ?? null,
            createdAt: new Date(row.createdAt),
            vectorScore: Number(row.vectorScore),
            bm25Score: Number(row.bm25Score),
            hybridScore: Number(row.hybridScore),
        }));

        console.info(
            `Hybrid search returned ${results.length} rows (projectId=${
                filters.projectId ?? 'none'
            })`
        );

        return results;
    } catch (error) {
        console.error(
            'Error fetching relevant content for query:',
            error
        );
        throw error;
    }
}