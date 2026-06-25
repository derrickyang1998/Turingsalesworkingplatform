# Phase 2 Acceptance Checklist

Scope: CRM collaboration, team visibility, public pool, and customer permissions

## Data scopes

- `my`: shows only customers assigned to the current user.
- `team`: shows customers assigned to users in the current user's department.
- `all`: admin-only full customer view; non-admin requests fall back to `my`.
- `pool`: shows public unassigned customers only.

## Manual acceptance

1. Login as `admin`:
   - `全部客户` is visible.
   - Customer totals match the selected scope.
   - Public pool count matches the pool tab.
2. Login as a normal user:
   - `全部客户` is not available as a visible admin control.
   - `我的客户` shows only owned customers.
   - `团队客户` shows same-department customers.
   - `公海池` shows only public unassigned customers.
3. Customer detail permissions:
   - Own customer detail opens.
   - Same-department customer detail opens.
   - Public pool customer detail opens.
   - Other-department customer detail is forbidden.
4. Customer write permissions:
   - Normal users can update only owned customers.
   - Same-department read-only customers cannot be edited by non-owners.
   - Admin can update and delete all customers.

## Automated acceptance

Run from `platform/server` while the local server is running:

```bash
node phase2_permissions_test.js
```

Expected result:

```text
Phase 2 permissions acceptance passed
```

## Regression guard

- `node ../tests/phase1_acceptance.js` still passes.
- `node smoke_test.js` still passes.
- `node -c server.js`, `node -c routes.js`, and `node -c routes_customers.js` still pass.
