import {prisma} from "@/lib/prisma";
import { Prisma } from "@prisma/client";

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

export async function upsertCouncils(
  stateId: string,
  councils: Array<{ name: string; officialWebsite: string }>
) {
  const results = [];

  for (const council of councils) {
    const councilId = council.name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const result = await prisma.council.upsert({
      where: {
        councilId: councilId,
      },
      update: {
        councilName: council.name,
        stateId,
        officialWebsite: council.officialWebsite,
      },
      create: {
        councilId,
        councilName: council.name,
        stateId,
        officialWebsite: council.officialWebsite,
      },
    });
    results.push(result);
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