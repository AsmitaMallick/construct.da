import { prisma } from "../lib/prisma";

// Minimal seed — replace with full ABS dataset
const SEED_COUNCILS = [
  {
    councilId: "NSW_SYDNEY_CITY",
    councilName: "City of Sydney",
    state: "NSW",
    officialWebsite: "https://www.cityofsydney.nsw.gov.au",
    daSystemType: "DCP+LEP",
  },
  {
    councilId: "VIC_MELBOURNE_CITY",
    councilName: "City of Melbourne",
    state: "VIC",
    officialWebsite: "https://www.melbourne.vic.gov.au",
    daSystemType: "Planning Scheme",
  },
  {
    councilId: "QLD_BRISBANE_CITY",
    councilName: "Brisbane City Council",
    state: "QLD",
    officialWebsite: "https://www.brisbane.qld.gov.au",
    daSystemType: "Planning Scheme",
  },
];

async function seed() {
  console.log("Seeding councils...");
  for (const council of SEED_COUNCILS) {
    await prisma.council.upsert({
      where: { councilId: council.councilId },
      update: {},
      create: { ...council, status: "pending" },
    });
  }
  console.log(`Seeded ${SEED_COUNCILS.length} councils.`);
  await prisma.$disconnect();
}

seed();