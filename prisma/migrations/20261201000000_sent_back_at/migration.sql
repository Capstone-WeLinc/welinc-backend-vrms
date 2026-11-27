-- VRMS spec 0027: when a chief last sent an In progress ticket back to its mechanics, so the
-- "Sent back to me" sub page and its count read a column instead of scanning audit rows.
ALTER TABLE "repair_tickets" ADD COLUMN "sent_back_at" TIMESTAMPTZ(6);

-- Backfill, once: an In progress ticket whose newest status change is a send back
-- (For verification to In progress) has one in force. This is the same rule as the ticket
-- detail's send back scan (lastRejectionFrom in audit-events.ts), which stops at a resend.
-- Reading audit_logs is fine: only writes to it are refused.
UPDATE "repair_tickets" AS t
SET "sent_back_at" = r.created_at
FROM (
  SELECT DISTINCT ON (a.repair_ticket_id)
    a.repair_ticket_id,
    a.created_at,
    c->>'before' AS before_status,
    c->>'after' AS after_status
  FROM "audit_logs" AS a
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(a.changes::jsonb) = 'array' THEN a.changes::jsonb ELSE '[]'::jsonb END
  ) AS c
  WHERE a.action = 'STATUS_CHANGE'
    AND a.repair_ticket_id IS NOT NULL
    AND c->>'field' = 'repairStatus'
  ORDER BY a.repair_ticket_id, a.created_at DESC, a.id DESC
) AS r
WHERE r.repair_ticket_id = t.id
  AND t.repair_status = 'IN_PROGRESS'
  AND r.before_status = 'FOR_VERIFICATION'
  AND r.after_status = 'IN_PROGRESS';
