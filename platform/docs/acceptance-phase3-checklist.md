# Phase 3 Acceptance Checklist

Scope: AI strategy and proposal artifacts become reusable customer and knowledge assets.

## Product behavior

- AI strategy output can be saved to the current customer record.
- Generated proposal output can be saved to the current customer record.
- Saved strategy/proposal artifacts create customer activity timeline entries.
- Saved strategy/proposal artifacts are searchable in the knowledge base.

## Manual acceptance

1. Open a customer detail panel and click `生成策略`.
2. Generate an AI strategy.
3. Click `保存到客户记录和知识库`.
4. Reopen customer detail:
   - Activity contains the saved strategy entry.
5. Open customer detail and click `写方案`.
6. Generate a proposal and click `保存到客户记录和知识库`.
7. Reopen customer detail:
   - Activity contains the saved proposal entry.
8. Search the knowledge base by brand or artifact title:
   - The saved strategy and proposal can be found.

## Automated acceptance

Run from `platform/server` while the local server is running:

```bash
node phase3_artifacts_test.js
```

Expected result:

```text
Phase 3 artifact acceptance passed
```

## Regression guard

- `node ../tests/phase1_acceptance.js` still passes.
- `node phase2_permissions_test.js` still passes.
- `node smoke_test.js` still passes.
