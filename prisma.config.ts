try {
  require("dotenv/config");
} catch {
  // dotenv optional
}
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "ts-node -r tsconfig-paths/register prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"] || "postgresql://welinc_vrms_user:welinc_vrms_pass@localhost:5432/welinc_vrms_db?schema=public",
  },
});

