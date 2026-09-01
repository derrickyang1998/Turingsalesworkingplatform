# Phase 7 Feishu Bitable Explicit Retry Design

## Goal

Allow a campaign owner or organization administrator to explicitly retry a Feishu Bitable delivery only when the original delivery is terminally failed with a known no-write failure. The retry must preserve the original payload, retain the historical receipt, create a new delivery receipt, and never silently resend data.

## Scope

- Add immutable retry lineage for campaign-scoped Feishu Bitable outbox deliveries.
- Add an owner/org-admin-only retry API with a required UUID `Idempotency-Key` and a required reason.
- Send the exact stored Bitable payload when a new retry is reserved.
- Add an M4 retry panel beside the existing reconciliation panel.
- Preserve the current reconciliation-only policy for uncertain `pending` deliveries.

## Explicit Non-Goals

- Do not update, delete, or compensate existing remote Bitable records. That needs a separately approved record-ID, field-mapping, conflict, and audit contract.
- Do not retry a provider-ambiguous `pending` delivery.
- Do not retry a terminal `succeeded` delivery.
- Do not allow a hidden timer, page refresh, request replay, or retry button without an explicit reason to trigger another write.
- Do not change the current influencer upload/export, collaboration, AI/RAG, proposal, or PPT contracts.

## State And Data Contract

`009_feishu_bitable_retry_lineage` adds an append-only `feishu_bitable_outbox_retries` table. One failed source delivery can have one retry child. A child that later fails is itself eligible for a new explicit retry, so the history is a chain rather than a mutable counter.

Each retry link stores:

- `org_id` and `campaign_id`, matching both linked outbox receipts;
- `failed_delivery_id`, unique for one successor per source receipt;
- `retry_delivery_id`, unique for one source per child receipt;
- `actor_user_id`, `reason`, and `created_at`.

Database triggers reject replacement, deletion, edits, cross-organization/campaign links, non-failed sources, and non-pending children at link creation. Existing outbox receipts remain terminally immutable.

The public delivery projection adds only non-sensitive lineage fields when present:

- `retry_of_delivery_id` on a retry child;
- `retry_delivery_id` on a failed source that already has a retry child;
- `retry_available` on a failed source only when its failure code is known to have produced no remote write and it has no retry child.

## Retry Eligibility

The service accepts only explicitly classified no-write failures: `FEISHU_BITABLE_WRITE_NOT_AVAILABLE`, `FEISHU_BITABLE_SCHEMA_MISMATCH`, `FEISHU_IDEMPOTENCY_REQUIRED`, `FEISHU_BATCH_LIMIT_EXCEEDED`, `FEISHU_OUTBOX_SNAPSHOT_INVALID`, `FEISHU_OUTBOX_RECORDS_INVALID`, and `FEISHU_OUTBOX_PAYLOAD_TOO_LARGE`.

All provider-ambiguous errors remain `pending` and need manual reconciliation. A provider rejection or any unclassified code is not automatically assumed safe: the user must resolve it outside this retry path or use a later explicitly designed compensation workflow.

## API Contract

`POST /api/campaigns/:id/feishu-deliveries/:deliveryId/retry`

- Requires authenticated campaign Owner or organization administrator, a writable active campaign, a UUID `Idempotency-Key`, and JSON `{ "reason": "..." }` of 1-280 characters.
- Creates one retry child from the immutable stored payload in the same database transaction as the retry-link evidence.
- Performs a Bitable `batch_create` only after the reservation/link commit. The new child uses the supplied UUID as its Bitable `client_token`.
- A same actor/same idempotency-key replay returns the current child receipt without another provider call. A different key against an already-linked source is rejected; the operator must explicitly select the child if it failed again.
- A provider ambiguity returns `202` with the new pending child and routes it to reconciliation. A known terminal failure finalizes the child as failed. A full receipt finalizes it as succeeded.

## M4 Interaction

The existing panel continues to show pending deliveries for manual reconciliation. A separate retry panel lists only `retry_available` failures for the active campaign. It requires a non-empty reason, disables duplicate clicks per campaign/delivery, sends the UUID idempotency key, refreshes receipts after completion or conflict, and never invokes the retry endpoint during initial load, refresh, or context changes.

## Verification And Release Boundary

This is a high-risk migration and external-write boundary. Test-first evidence must cover append-only lineage, source/child invariants, idempotency, authorization, no second provider call on replay, ambiguity-to-reconciliation behavior, client single-flight, and the absence of any retry control for pending or non-retryable failures. Deployment retains the migration/replay gate, verified backup, online health, static route smoke, and a review pass. No real Feishu record is created, updated, deleted, or retried for release verification.
