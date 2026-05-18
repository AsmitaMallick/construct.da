"use server";
import {prisma} from "../prisma";


export async function createUser(name: string, email: string, clerkUserId: string) {
    try {
        const existing = await prisma.user.findUnique({
            where: { email },
        });

        if (existing) {
            throw new Error(`User already exists for this email: ${email}`);
        }

        const user = await prisma.user.create({
            data: {
                name,
                email,
                clerkUserId
            }
        });

        return user;
    } catch (error) {
        console.error("Error creating user:", error);
        throw error;
    }
}

export async function resolveUserIdByClerkIdentity(params: {
    clerkUserId: string;
    email?: string;
    name?: string;
}): Promise<string> {
    const existing = await prisma.user.findUnique({
        where: {
            clerkUserId: params.clerkUserId,
        },
    });

    if (existing) {
        return existing.id;
    }

    if (!params.email) {
        throw new Error("Email is required to create a user record.");
    }

    const created = await prisma.user.create({
        data: {
            clerkUserId: params.clerkUserId,
            email: params.email,
            name: params.name,
        },
    });

    return created.id;
}