import {prisma} from "@/lib/prisma";

export type ProjectOwnershipResult =
  | { status: "owned"; project: { id: string; userId: string; address: string; council: string; metadata: unknown } }
  | { status: "missing" }
  | { status: "forbidden" };

export async function resolveProjectOwnership(
  projectId: string,
  clerkUserId: string,
): Promise<ProjectOwnershipResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      address: true,
      council: true,
      metadata: true,
      User: {
        select: {
          clerkUserId: true,
        },
      },
    },
  });

  if (!project) {
    return { status: "missing" };
  }

  if (project.User.clerkUserId !== clerkUserId) {
    return { status: "forbidden" };
  }

  return {
    status: "owned",
    project: {
      id: project.id,
      userId: project.userId,
      address: project.address,
      council: project.council,
      metadata: project.metadata,
    },
  };
}

type ClaimsLike = {
  role?: unknown;
  roles?: unknown;
  metadata?: { role?: unknown; roles?: unknown };
  publicMetadata?: { role?: unknown; roles?: unknown };
};

export function hasAdminRole(claims: unknown): boolean {
  if (!claims || typeof claims !== "object") {
    return false;
  }

  const typedClaims = claims as ClaimsLike;
  return [
    typedClaims.role,
    typedClaims.roles,
    typedClaims.metadata?.role,
    typedClaims.metadata?.roles,
    typedClaims.publicMetadata?.role,
    typedClaims.publicMetadata?.roles,
  ].some(hasAdminValue);
}

export function hasValidIngestionServiceToken(request: Request): boolean {
  const expectedToken = process.env.INGESTION_ADMIN_TOKEN;
  if (!expectedToken) {
    return false;
  }

  return request.headers.get("x-ingestion-admin-token") === expectedToken;
}

function hasAdminValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasAdminValue);
  }

  return typeof value === "string" && value.toLowerCase() === "admin";
}
