# Phase 1 Acceptance Checklist

Scope: CRM -> Strategy -> Demand Proposal -> Influencer Matching

## Current focus

- Customer detail can launch downstream modules with carried context.
- AI demand analysis can continue into proposal generation without losing state.
- Influencer matching filters align with the visible page fields.

## Manual acceptance

1. Open a customer detail panel and verify these actions exist:
   - `品牌洞察`
   - `生成策略`
   - `写方案`
   - `匹配达人`
2. From customer detail, click `生成策略`:
   - Strategy page opens.
   - AI input area is prefilled with customer context.
   - Industry and budget selectors are prefilled when possible.
3. From customer detail, click `写方案`:
   - Demand page opens.
   - Manual fields are prefilled.
   - AI analysis button is enabled without uploading a file.
4. On the demand page, run AI analysis and click next:
   - Template step opens.
   - Selecting a template and clicking generate produces content in `proposalOutput`.
5. After proposal generation, click `去匹配达人`:
   - Influencer page opens.
   - Product/platform/region/tags filters are prefilled when context exists.
6. On influencer matching, filter by:
   - project
   - product
   - tags
   - platform
   - region
   Verify list refreshes without JS errors.

## API acceptance

1. `GET /api/influencers` accepts:
   - `project_name`
   - `product_name`
   - `tags`
   - `search`
2. Export with `mode=filtered` includes the same filters used by the page.

## Regression guard

- `platform/app.js` parses successfully in Node.
- `platform/server/server.js` parses successfully in Node.
- `platform/server/routes.js` parses successfully in Node.
