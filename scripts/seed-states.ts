import {prisma} from "@/lib/prisma";
import "dotenv/config";

const australianStates = [
  { code: "NSW", name: "New South Wales" },
  { code: "VIC", name: "Victoria" },
  { code: "QLD", name: "Queensland" },
  { code: "SA", name: "South Australia" },
  { code: "WA", name: "Western Australia" },
  { code: "TAS", name: "Tasmania" },
  { code: "ACT", name: "Australian Capital Territory" },
  { code: "NT", name: "Northern Territory" },
];

export async function seedStates() {
  console.log("Seeding Australian states...");

  for (const state of australianStates) {
    await prisma.state.upsert({
      where: { code: state.code },
      update: {},
      create: {
        code: state.code,
        name: state.name,
      },
    });
    console.log(`  Seeded: ${state.code} - ${state.name}`);
  }

  console.log("\n✓ States seeded successfully!");
}

// Run if called directly
seedStates()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });