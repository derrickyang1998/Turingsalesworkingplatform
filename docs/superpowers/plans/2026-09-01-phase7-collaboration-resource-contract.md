# Phase 7 Collaboration Resource Contract Implementation Plan

**Goal:** Make every M4 collaboration order store and display a clear resource definition: cooperation type, project, product, deliverable, quoted price, and contract or PO reference.

**Scope:** This is a small production slice. It does not add a migration, alter campaign lifecycle transitions, enable Feishu Bitable writes, or change AI/PPT workflows.

## Contract

- A resource that explicitly declares `turingmarket.collaboration-order.v1` is server-validated as the new order contract.
- Supported resource types are `paid`, `affiliate`, `gifting`, and `retainer`.
- `quoted_price` uses the platform's existing non-negative whole-dollar cost unit and is authoritative when `resource` is provided. A conflicting `cost_quoted` is rejected before data or idempotency records are written.
- Canonical resource JSON remains in the existing `proposal_notes` storage column for migration-free backward compatibility.
- Requests without a resource schema retain the historical resource and free-form proposal-notes behavior. New v1 orders may use bounded scalar extension fields under `extensions`.

## Delivery Steps

1. Add contract tests for canonicalization, unsupported types/fields, safe price handling, and quote conflicts.
2. Reuse the contract in both legacy and campaign-linked collaboration creates.
3. Send the same `resource` payload from both M4 order paths.
4. Separate cooperation type, delivery, contract/PO reference, and notes in the M4 execution table.
5. Run release-scoped tests, independent review, guarded production deploy, online smoke, and version records before the next slice.
