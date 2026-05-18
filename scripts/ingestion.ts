import fs from "node:fs/promises";
import path from "node:path";

import { RuleFiles, ruleFiles } from "@data/fileData";
import {prisma} from "@/lib/prisma";

import type { RuleCoverage } from "@prisma/client";
import { put } from "@vercel/blob";
import pLimit from "p-limit";
import "dotenv/config";
import { scrapeNSWLEPs } from "./downloadLEP";

const FILE_CONCURRENCY = 3;

/* ---------------------------------- */
/* Terminal Animations */
/* ---------------------------------- */

// const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const startSpinner = (text: string) => {
    let i = 0;

    const timer = setInterval(() => {
        process.stdout.write(
            `\r${spinnerFrames[i++ % spinnerFrames.length]} ${text}`
        );
    }, 80);

    return () => {
        clearInterval(timer);
        process.stdout.write(`\r✔ ${text}\n`);
    };
};

const progressPulse = (done: number, total: number, label: string) => {
    const width = 20;
    const filled = Math.round((done / total) * width);

    const bar =
        "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));

    process.stdout.write(
        `\r${label} [${bar}] ${done}/${total}`
    );

    if (done === total) process.stdout.write("\n");
};

/* ---------------------------------- */
/* Ingest Files */
/* ---------------------------------- */

export const ingestFiles = async () => {
    const stop = startSpinner("Uploading rule files...");
    const limit = pLimit(FILE_CONCURRENCY);

    let completed = 0;
    const total = ruleFiles.length;

    await Promise.all(
        ruleFiles.map((file) =>
            limit(async () => {
                const existing = await prisma.ruleFiles.findFirst({
                    where: {
                        name: file.name,
                    },
                    select: {
                        id: true,
                    },
                });

                if (!existing) {
                    const absolutePath = path.resolve(process.cwd(), file.filePath);

                    const buffer = await fs.readFile(absolutePath);

                    const blob = await put(`${file.name}.${file.metadata.extension}`, buffer, {
                        access: "private",
                        addRandomSuffix: true,
                    });

                    await prisma.ruleFiles.create({
                        data: {
                            name: file.name,
                            coverage: file.coverage as RuleCoverage,
                            metadata: {
                                ...file.metadata,
                                pathname: blob.pathname,
                                contentType: blob.contentType,
                                etag: blob.etag,
                            },
                            url: blob.url,
                        },
                    });
                }

                completed++;
                progressPulse(completed, total, "Files");
            })
        )
    );

    stop();
};

const processEPIs = async (filesData: RuleFiles[]) => {
    const stop = startSpinner("Processing EPIs...");
    const limit = pLimit(FILE_CONCURRENCY);

    let completed = 0;
    const total = filesData.length;
    await Promise.all(
        filesData.map((file) =>
            limit(async () => {
                const existing = await prisma.ruleFiles.findFirst({
                    where: {
                        name: file.name,
                    },
                    select: {
                        id: true,
                    },
                });

                if (!existing) {
                    const absolutePath = path.resolve(process.cwd(), file.filePath);

                    const buffer = await fs.readFile(absolutePath);

                    const blob = await put(`${file.name}.${file.metadata.extension}`, buffer, {
                        access: "private",
                        addRandomSuffix: true,
                    });

                    await prisma.ruleFiles.create({
                        data: {
                            name: file.name,
                            coverage: file.coverage as RuleCoverage,
                            metadata: {
                                ...file.metadata,
                                pathname: blob.pathname,
                                contentType: blob.contentType,
                                etag: blob.etag,
                            },
                            url: blob.url,
                        },
                    });
                }

                completed++;
                progressPulse(completed, total, "Files");
            })
        )
    );

    stop();
}

/* ---------------------------------- */
/* Master Runner */
/* ---------------------------------- */

const ingestAll = async () => {
    try {
        console.log("\n🚀 Starting Rule Ingestion\n");
        await ingestFiles();

        console.log("\n🚀 Starting EPIs Scraping\n");
        const EPIfilesData = await scrapeNSWLEPs();
        console.log("\n🚀 Starting EPIs Ingestion\n")
        await processEPIs(EPIfilesData);

        console.log("\n✨ All ingestion tasks complete.\n");
    } catch (error) {
        console.error("❌ Ingestion failed:", error);
    } finally {
        process.exit(0);
    }
};

ingestAll();