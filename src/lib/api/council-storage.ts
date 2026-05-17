import { prisma } from "@/lib/prisma";

export function normalizeStateCode(input: string): string | null {
  const normalized = input.toUpperCase().trim();
  const validCodes = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"];
  return validCodes.includes(normalized) ? normalized : null;
}

export async function getStateByCode(code: string) {
  return prisma.state.findUnique({ where: { code } });
}

export async function getOrCreateState(code: string, name: string) {
  return prisma.state.upsert({
    where: { code },
    update: {},
    create: { code, name },
  });
}

export async function getCouncilsByStateId(stateId: string) {
  return prisma.council.findMany({
    where: { stateId },
  });
}

export async function getCouncilById(councilId: number) {
  return prisma.council.findUnique({ where: { id: councilId } });
}

export async function getCouncilsForLinking(stateId?: string) {
  return prisma.council.findMany({
    where: stateId ? { stateId } : undefined,
    select: {
      id: true,
      councilName: true,
      officialWebsite: true,
      stateId: true,
    },
    orderBy: [{ councilName: "asc" }],
  });
}

export async function upsertCouncilLinks(
  councilId: number,
  links: Array<{
    url: string;
    title?: string | null;
    sourceType?: string | null;
  }>,
) {
  const results: Array<any> = [];

  for (const link of links) {
    const result = await prisma.councilLink.upsert({
      where: {
        councilId_url: {
          councilId,
          url: link.url,
        },
      },
      update: {
        title: link.title ?? null,
        sourceType: link.sourceType ?? null,
      },
      create: {
        councilId,
        url: link.url,
        title: link.title ?? null,
        sourceType: link.sourceType ?? null,
      },
    });
    results.push(result);
  }

  return results;
}

export async function upsertCouncils(
  stateId: string,
  councils: Array<{ name: string; officialWebsite: string }>,
) {
  const results: Array<any> = [];

  for (const council of councils) {
    // Find existing council by name + stateId (no unique constraint exists),
    // update if found, otherwise create a new record.
    const existing = await prisma.council.findFirst({
      where: { councilName: council.name, stateId },
    });

    if (existing) {
      const updated = await prisma.council.update({
        where: { id: existing.id },
        data: {
          councilName: council.name,
          stateId,
          officialWebsite: council.officialWebsite,
        },
      });
      results.push(updated);
    } else {
      const created = await prisma.council.create({
        data: {
          councilName: council.name,
          stateId,
          officialWebsite: council.officialWebsite,
        },
      });
      results.push(created);
    }
  }

  return results;
}

export function getStateName(code: string): string {
  const stateNames: Record<string, string> = {
    NSW: "New South Wales",
    VIC: "Victoria",
    QLD: "Queensland",
    SA: "South Australia",
    WA: "Western Australia",
    TAS: "Tasmania",
    ACT: "Australian Capital Territory",
    NT: "Northern Territory",
  };
  return stateNames[code] || code;
}
