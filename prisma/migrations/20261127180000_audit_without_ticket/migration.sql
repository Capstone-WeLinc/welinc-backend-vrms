-- Spec 0029 (child 0004): a referral rejection, and the retry or dismiss of its delivery, belong
-- to no ticket, so their audit rows carry none. Rows about a ticket still set it. DDL only: the
-- append only triggers refuse row UPDATE and DELETE, which this does not do.
ALTER TABLE "audit_logs" ALTER COLUMN "repair_ticket_id" DROP NOT NULL;
