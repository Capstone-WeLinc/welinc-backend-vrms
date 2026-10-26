-- Spec 0009: accounts live in welinc-auth only. Mechanics and audit rows key on the welinc-auth user id.

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";

-- DropForeignKey
ALTER TABLE "mechanics" DROP CONSTRAINT "mechanics_user_id_fkey";

-- DropForeignKey
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "password_reset_tokens_user_id_fkey";

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey";

-- DropIndex
DROP INDEX "mechanics_user_id_key";

-- AlterTable
ALTER TABLE "mechanics" DROP COLUMN "user_id",
ADD COLUMN     "auth_user_id" UUID,
ADD COLUMN     "email" VARCHAR(255);

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_name" VARCHAR(100);

-- DropTable
DROP TABLE "users";

-- DropTable
DROP TABLE "user_roles";

-- DropTable
DROP TABLE "password_reset_tokens";

-- DropTable
DROP TABLE "refresh_tokens";

-- DropEnum
DROP TYPE "UserRole";

-- DropEnum
DROP TYPE "SystemType";

-- CreateIndex
CREATE UNIQUE INDEX "mechanics_auth_user_id_key" ON "mechanics"("auth_user_id");

