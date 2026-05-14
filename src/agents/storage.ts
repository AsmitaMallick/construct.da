import { prisma } from "../lib/prisma";
import { uploadToBlob } from "../lib/blob";
import { RuntimeQueue } from "../lib/queue";
import { ScrapedDocument } from "./scraper";

export async function storageAgent(
  docs: ScrapedDocument[],
  queue: RuntimeQueue<any>
): Promise<number> {
  let stored = 0;

  for (const doc of docs) {
    // Deduplication via runtime Set
    if (queue.isDuplicate(doc.contentHash)) {
      console.log(`[Storage] Duplicate skipped: ${doc.validatedDoc.url}`);
      continue;
    }

    try {
      // Upload to Vercel Blob
      const filename = `${doc.contentHash.substring(0, 8)}.${doc.fileFormat}`;
      const blobUrl = await uploadToBlob(
        doc.validatedDoc.councilId,
        "AU",
        filename,
        doc.rawContent,
        doc.fileFormat === "pdf" ? "application/pdf" : "text/html"
      );

      // Write to Neon via Prisma
      await prisma.councilDocument.create({
        data: {
          councilId: doc.validatedDoc.councilId,
          url: doc.validatedDoc.url,
          documentTitle: doc.title,
          documentType: doc.validatedDoc.documentType,
          fileFormat: doc.fileFormat,
          fileSizeBytes: BigInt(doc.fileSizeBytes),
          contentHash: doc.contentHash,
          credibilityScore: doc.validatedDoc.credibilityScore,
          validationDecision: doc.validatedDoc.decision,
          validationReason: doc.validatedDoc.reasoning,
          blobUrl,
          textExtracted: doc.fileFormat !== "pdf",
          indexedAt: new Date(),
        },
      });

      stored++;
      console.log(`[Storage] Saved: ${doc.validatedDoc.url}`);
    } catch (e) {
      console.error(`[Storage] Failed to store: ${doc.validatedDoc.url}`, e);
    }
  }

  return stored;
}