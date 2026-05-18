"use server";
import { FileSpecs, FilesStrict } from "@models/data";
import { ProjectStage, ProjectStatus } from "@models/data";
import {prisma} from "../prisma";
import { updateProjectMetadata } from "./projects";

function asJsonObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    return value as Record<string, unknown>;
}

function shouldMarkNeedsReview(metadata: Record<string, unknown>): boolean {
    return metadata.processingStatus !== ProjectStatus.IN_PROGRESS;
}


export async function uploadFileToProject(fileSpecs: FileSpecs): Promise<FilesStrict> {
    try {
        const newFile = await prisma.files.create({
            data: {
                name: fileSpecs.filename,
                url: fileSpecs.url,
                metadata: {
                    mimeType: fileSpecs.mimetype,
                    size: fileSpecs.size,
                    fileType: fileSpecs.fileType,
                },
                userId: fileSpecs.userId,
                projectId: fileSpecs.projectId,
            },
        });

        return {
            ...newFile,
            metadata: newFile.metadata as Pick<FilesStrict, "metadata">["metadata"],
        };

    } catch (error) {
        console.error("Error uploading file to project:", error);
        throw error;
    }
}

export async function uploadFilesToProject(filesSpecs: FileSpecs[]): Promise<{ success: boolean; count: number; allFiles: FilesStrict[] }> {
    try {
        const uploadedFiles = await prisma.files.createMany({
            data: filesSpecs.map((fileSpecs) => ({
                name: fileSpecs.filename,
                url: fileSpecs.url,
                metadata: {
                    mimeType: fileSpecs.mimetype,
                    size: fileSpecs.size,
                    fileType: fileSpecs.fileType,
                },
                userId: fileSpecs.userId,
                projectId: fileSpecs.projectId,
            })),
        });

        const allFilesProject = await prisma.files.findMany({
            where: {
                projectId: filesSpecs[0].projectId,
            },
        });

        const currentProject = await prisma.project.findUnique({
            where: { id: filesSpecs[0].projectId },
            select: { metadata: true },
        });

        const currentMetadata = asJsonObject(currentProject?.metadata);
        await updateProjectMetadata(filesSpecs[0].projectId, {
            filesUpdatedAt: new Date().toISOString(),
            ...(shouldMarkNeedsReview(currentMetadata)
                ? {
                    processingStatus: ProjectStatus.NEEDS_REVIEW,
                    stage: ProjectStage.FILES_UPLOADED,
                }
                : {}),
        });

        return {
            success: uploadedFiles.count === filesSpecs.length,
            count: uploadedFiles.count,
            allFiles: allFilesProject.map((file) => ({
                ...file,
                metadata: file.metadata as Pick<FilesStrict, "metadata">["metadata"],
            })),
        }
    } catch (error) {
        console.error("Error uploading files to project:", error);
        throw error;
    }
}

export async function deleteFileFromProject(params: {
    fileId: string;
    projectId: string;
}): Promise<FilesStrict[]> {
    await prisma.files.delete({
        where: {
            id: params.fileId,
        },
    });

    const allFilesProject = await prisma.files.findMany({
        where: {
            projectId: params.projectId,
        },
    });

    const currentProject = await prisma.project.findUnique({
        where: { id: params.projectId },
        select: { metadata: true },
    });

    const currentMetadata = asJsonObject(currentProject?.metadata);
    await updateProjectMetadata(params.projectId, {
        filesUpdatedAt: new Date().toISOString(),
        ...(shouldMarkNeedsReview(currentMetadata)
            ? {
                processingStatus: ProjectStatus.NEEDS_REVIEW,
                stage: ProjectStage.FILES_UPLOADED,
            }
            : {}),
    });

    return allFilesProject.map((file) => ({
        ...file,
        metadata: file.metadata as Pick<FilesStrict, "metadata">["metadata"],
    }));
}