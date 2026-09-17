# TuringMarket v0.9.9 Organization Ownership Transfer

## Objective

Deliver one independently releasable Phase 8 governance capability: a company owner or platform administrator can transfer an organization's ownership to another eligible member without weakening tenant isolation, auditability, or session security.

## Scope

- Add migration 022 for mutable-but-guarded `organization_authority` records.
- Add an atomic ownership-transfer service and authenticated API endpoint.
- Expose eligible transfer actions in the existing Organization and Members admin view.
- Require a transfer reason and exact target username confirmation.
- Revoke sessions for both the previous and new owner after a successful transfer.
- Preserve all unrelated CRM, AI, influencer, reporting, and frozen PPT behavior.

## Contract

### Database

`organization_authority` gains:

- `updated_by`: last actor recorded for the authority change.
- `updated_at`: canonical SQLite timestamp for the last change.
- `version`: positive integer starting at `1` and incremented exactly once per transfer.

Migration 022 preserves `org_id`, `owner_user_id`, `created_by`, and `created_at`. Database guards continue to reject deletion and replacement. An update is accepted only when:

- immutable creation fields do not change;
- the owner actually changes;
- `version` increments by exactly one;
- the target is an active, read-write member backed by an active user;
- `updated_by` is an active platform administrator or the current owner;
- `updated_at` is a valid canonical timestamp.

### API

`POST /api/organization-governance/organizations/:organizationId/owner/transfer`

Exact request body:

```json
{
  "new_owner_user_id": 12,
  "expected_owner_user_id": 7,
  "expected_version": 3,
  "confirmation_username": "new-owner",
  "reason": "Regional leadership handover"
}
```

Rules:

- Actor is a live platform administrator or the organization's current owner.
- Expected owner and version must match the current record.
- Candidate username must exactly match `confirmation_username`.
- Candidate must be a different, active, read-write member of the same organization.
- Reason is trimmed, 8-500 characters, and persisted in the audit record.
- Compare-and-swap update, session revocation, and audit insertion run in one immediate transaction.

Success returns the previous owner, new owner summary, and new version. Stable 4xx errors cover invalid input, forbidden actors, stale authority state, ineligible candidates, and confirmation mismatch.

### UI

- Existing Organization and Members layout remains intact.
- Eligible target rows show `转移所有权` only when the server grants the action.
- A focused accessible modal names the organization, current owner, and target account.
- The operator enters a reason and the target username before the submit control is enabled.
- On self-transfer, local authentication is cleared and the login screen is shown after the success response because the server revoked the current session.
- A platform administrator who is not the previous owner stays signed in and sees refreshed organization/member projections.

## Tests

RED tests are added before implementation for:

- v21 to v22 preservation, deterministic columns, triggers, and idempotent migration;
- database rejection of invalid targets, stale versions, deletion, fake updates, and immutable-field changes;
- owner/admin authorization and organization-admin/member denial;
- exact body validation, candidate confirmation, stale compare-and-swap, and cross-organization denial;
- old/new session revocation and audit contents;
- full rollback when audit persistence fails;
- route registration and stable response envelopes;
- server-owned UI action visibility, modal confirmation, successful refresh, and self-transfer re-login.

## Release Gate

This is a high-risk authorization and tenant-governance slice. Run the affected governance, authentication, migration, sanitizer, trusted-source, deployment-contract, and browser tests plus syntax, secret, and frozen-PPT checks. Complete an independent code/security review before release.

After passing:

1. Commit and push the source release.
2. Create and verify the production backup.
3. Deploy migration 022 and the application.
4. Verify health, database integrity, tenant isolation, transfer-to-test-member, transfer-back-to-original-owner, session revocation, and desktop/mobile UI.
5. Synchronize `CHANGELOG.md`, repository release record, Obsidian archive, GitHub, and the visual progress board.

## Rollback

- Application rollback uses the verified pre-deploy artifact and database backup.
- Migration 022 is forward-only in normal operation; rollback restores the paired pre-deploy database backup rather than attempting a lossy down migration.
- Production acceptance requires restoring the original owner after the controlled transfer smoke test.
