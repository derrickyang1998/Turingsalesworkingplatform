# Task 6A Report

## Scope

- Implemented authenticated `POST /api/campaigns/:campaign_id/proposal-confirmations`.
- Added campaign-mode M3 proposal confirmation in `platform/app.js`.
- Added focused backend and UI source-contract tests.
- Did not edit `ppt.js`, schema/migrations, deploy files, credentials, or unrelated modules.

## Implementation Notes

- The route takes campaign authority only from `:campaign_id`; the request body does not accept campaign or demand ids.
- `draft.demand_entry_id` is persisted only as audit metadata on campaign record links and is never used as `demands.id`.
- The service uses existing `runLinkedMutation` idempotency, auth, archive, link, event, and capacity patterns in one immediate SQLite transaction.
- Exact idempotency replay returns the original response after reauthorization; same key with changed body returns `IDEMPOTENCY_KEY_REUSED`.
- The transaction creates a real demand, real proposal, demand/proposal knowledge archives, business links, archive links, activity rows, one existing-compatible link event, and completed idempotency evidence.
- M3 campaign confirmations use a stable idempotency key for the same body, clear linked confirmation state on reset/navigation/new analysis/superseding generation, and hand off campaign/customer/opportunity plus real demand/proposal ids and `demand_entry_id` to M4.

## RED Evidence

- `node --test --test-name-pattern "campaign proposal confirmation" tests/campaign_record_integration.test.js`
  - Initial result: 3 failing tests, all `404 Not found` before the route/service existed.
- `node --test --test-name-pattern "proposal route forwards controls and latest M3 uses AI draft then explicit confirmation" tests/latest_ui_proposal_flow.test.js`
  - Initial result: 1 failing source-contract test because M3 saved through the old proposal/customer paths and did not call `/campaigns/:campaign_id/proposal-confirmations`.

## GREEN Evidence

- `node --test --test-name-pattern "campaign proposal confirmation" tests/campaign_record_integration.test.js`
  - Result: 3 pass, 0 fail.
- `node --test --test-name-pattern "linked demand and proposal archives project only committed immutable rows with canonical JSON and scalar-safe summaries|proposal route forwards controls and latest M3 uses AI draft then explicit confirmation" tests/campaign_record_integration.test.js tests/latest_ui_proposal_flow.test.js`
  - Result: 2 pass, 0 fail.

## Focused Checks

- `node --check server.js`
- `node --check services\campaign_link_service.js`
- `node --check ..\app.js`
- `git diff --check`
  - Result: pass; Git reported only LF/CRLF working-copy warnings for touched files.
- Replacement-character scan over touched Task 6A files.
  - Result: no matches.
- Focused secret scan over the Task 6A diff.
  - Result: no matches.

## Residual Risk

- Existing schema triggers constrain `proposal.create.linked` to one `proposal_link` event without migrations. Task 6A creates both demand and proposal links/archives, but records one existing-compatible campaign event for the transaction.

## REQUEST_CHANGES Follow-up

### Fixes

- Captured immutable confirmation attempt state in M3 before awaiting the campaign confirmation response: generation sequence, pending key/body identity, attempt sequence, and submitted `demand_entry_id`.
- Applied `lastLinkedProposalConfirmation` only when the submitted attempt is still current; stale successes after reset or navigation no longer restore UI linkage or borrow newer draft audit globals.
- Restored the current confirm button to a retryable state when a stale success completes after reset, navigation, or an in-flight edit.
- Invalidated confirmed linkage and rotated the next pending idempotency attempt only when editor content actually changes; no-op editor sync during save preserves unchanged retry keys.
- Preserved M3 to M4 handoff by copying confirmed context before navigation and passing an explicit handoff-preservation option.
- Kept the single schema-compatible `proposal.create.linked` event, and encoded the composite audit identity in trigger-approved metadata fields: `relation_types` includes demand, knowledge, and proposal; `link_ids` contains the real demand link, proposal link, demand archive link, and proposal archive link.

### Follow-up RED Evidence

- `node --test --test-name-pattern "campaign proposal confirmation|campaign proposal confirmation reuses|stale proposal confirmation|proposal influencer handoff" tests/campaign_record_integration.test.js tests/latest_ui_proposal_flow.test.js`
  - Corrected RED result before production fixes: 8 tests, 5 pass, 3 fail.
  - Failures: missing composite event metadata, editing after success did not clear linked UI state, stale reset/navigation success restored linked UI state and borrowed newer `demand_entry_id`.
- `node --test --test-name-pattern "stale proposal confirmation success after reset or navigation cannot restore linked UI state" tests/latest_ui_proposal_flow.test.js`
  - Self-review RED result before button-state fix: 1 test, 0 pass, 1 fail.
  - Failure: stale completion left `confirmProposalBtn.disabled` as `true`.

### Follow-up GREEN Evidence

- `node --test --test-name-pattern "campaign proposal confirmation|campaign proposal confirmation reuses|stale proposal confirmation|proposal influencer handoff" tests/campaign_record_integration.test.js tests/latest_ui_proposal_flow.test.js`
  - Result: 8 tests, 8 pass, 0 fail.
- `node --test --test-name-pattern "stale proposal confirmation success after reset or navigation cannot restore linked UI state" tests/latest_ui_proposal_flow.test.js`
  - Result: 1 test, 1 pass, 0 fail.
- `node --test --test-name-pattern "linked demand and proposal archives project only committed immutable rows with canonical JSON and scalar-safe summaries|proposal route forwards controls and latest M3 uses AI draft then explicit confirmation" tests/campaign_record_integration.test.js tests/latest_ui_proposal_flow.test.js`
  - Result: 2 tests, 2 pass, 0 fail.

### Follow-up Residual Risk

- The campaign event trigger still permits only five metadata keys for `link_attached`; composite auditability therefore dereferences the event `link_ids` through `campaign_record_links` rather than embedding nested record objects directly in event metadata.
