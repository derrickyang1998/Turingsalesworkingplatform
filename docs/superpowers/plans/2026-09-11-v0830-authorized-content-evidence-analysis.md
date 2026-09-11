# TuringMarket v0.8.30 Authorized Content Evidence Analysis

## Goal

Add one production-ready Phase 7B slice to the existing Performance Dashboard: an operator can select a campaign publication, provide authorized caption/transcript and optional human-observed visual notes, receive an evidence-bound AI analysis, edit it, and archive the approved conclusion into the current campaign knowledge base.

## Fixed Boundaries

- Keep the existing metadata-only campaign AI review unchanged.
- Do not fetch, download, retain, or index raw video, images, audio, or frames.
- Treat submitted text as transient provider input. Persist only a canonical evidence hash, evidence types and lengths, rights/acquisition metadata, the AI result, and the human-approved conclusion.
- Require an explicit rights attestation and one approved acquisition mode: `client_supplied` or `creator_supplied`. Public-access evidence remains disabled until the server can verify a durable approval record.
- Never claim visual, hook, CTA, or style findings unless the corresponding submitted evidence exists.
- Keep web search disabled. Use only confirmed campaign methodology from the knowledge base.
- Preserve AI draft -> human edit/confirm -> campaign knowledge archive.

## Implementation

1. Add focused tests for input/rights validation, transient evidence handling, evidence-bound JSON protocol, campaign permissions, approval replay, and knowledge lineage.
2. Add `performance_content_analysis_service.js` for canonical evidence hashing, safe prompt construction, validated AI output rendering, retained-result verification, and approval/archive logic.
3. Extend the linked AI service with an internal, source-restricted provider-message override so raw evidence reaches the model but the stored user message contains only the evidence fingerprint and governance metadata.
4. Register two protected JSON endpoints:
   - `POST /api/campaigns/:id/performance/content-analysis-draft`
   - `POST /api/campaigns/:id/performance/content-analysis-draft/approve`
5. Add a compact section to the existing Performance Dashboard with publication selection, evidence fields, acquisition mode, rights confirmation, draft review, visibility selection, and archive action.
6. Add a dedicated knowledge artifact mapping for confirmed content analysis while retaining the same campaign performance methodology entry class.

## Focused Verification

- New service and route tests.
- Linked AI persistence/privacy regression tests.
- Existing performance AI review, campaign RAG, frontend contract, campaign contract, and knowledge archive tests.
- JavaScript syntax, static secret scan, and production online smoke after immediate deployment.

## Production Gate

This feature may deploy when the focused suite passes, one independent reviewer finds no unresolved blocker, the production database backup restores successfully, and online authenticated smoke confirms the new UI/API without regressing the existing review and report path.
