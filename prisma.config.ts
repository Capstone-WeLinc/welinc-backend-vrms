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
  // No fallback: credentials never live in the repo. Set DATABASE_URL (see .env.example).
  // `prisma generate` works without it; migrate and db commands fail with a clear error.
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});

