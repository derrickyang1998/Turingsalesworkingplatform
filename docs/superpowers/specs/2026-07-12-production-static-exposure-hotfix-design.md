# Production Static Exposure Hotfix Design

## Context

The production Express server currently mounts the entire `platform/` directory with `express.static`. Anonymous requests can therefore read backend source, the SQLite database and WAL file, and deployment scripts. The production UI itself only needs `index.html`, `app.js`, `ppt.js`, and the JSON files under `platform/data/`.

## Approved Scope

Use the minimal production-safe approach approved by the user:

- Replace broad static serving with an explicit browser-asset allowlist.
- Return `404` for private directories and non-public top-level files before the SPA fallback.
- Add an Nginx deny layer for the same private paths.
- Preserve the current UI, PPT build marker, APIs, uploads, and business behavior.
- Back up the existing Nginx config before installation.
- Invalidate all existing server sessions after deployment so exposed session records cannot be reused.
- Verify the fix against the public production URL, not only locally.

## Public Surface

The Express server may expose only:

- `/` and SPA routes, served as `index.html`.
- `/index.html`.
- `/app.js`.
- `/ppt.js`.
- `/data/*`, constrained to `platform/data/` with dotfiles denied and path traversal protection supplied by `express.static`.
- `/api/*`, handled by authenticated or public API routes as already defined.

Private directories such as `/server`, `/uploads`, `/tmp`, `/backups`, `/node_modules`, `/docs`, and `/nginx` must return `404`. Root implementation, deployment, package, and documentation files must also return `404` rather than falling through to the SPA document.

## Defense In Depth

Express is the source-of-truth policy so local and production behavior match. Nginx repeats the private-path deny rules before proxying to Express. The deployment script uploads the versioned Nginx config, backs up the previous live config, runs `nginx -t`, and reloads Nginx only after all application syntax checks pass.

## Verification

- A real child-process integration test starts `server/server.js` and checks public and private paths with HTTP `HEAD` requests.
- Static tests confirm the Nginx deny rules and deployment wiring exist.
- The complete server test suite and JavaScript syntax checks must pass.
- Production checks must prove sensitive paths return `404`, public assets remain `200`, `/api/health` remains healthy, the PPT marker is unchanged, and all sessions were deleted.
- An independent code reviewer and security reviewer must approve before final reporting.

## Out Of Scope

- UI redesign or business workflow changes.
- Moving all browser assets into a new `public/` directory.
- Changing the PPT rendering implementation.
- Inventing new account passwords. Password rotation remains a separate credential-governance action after the exposure is closed.
