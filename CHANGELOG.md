# Changelog - TuringMarket Business Platform

All notable changes to this project will be documented in this file.

---

## v5.1 (2026-06-03) - Codex Handover Baseline

**Source:** master (commit 1c9a99e)

### Included
- Express.js + SQLite backend, JWT multi-user auth (admin + 10 team)
- M1 Industry Brand Hub: industry tree filter + DeepSeek enrichment + CSV export
- M2 Client Strategy: 4 persona types, static rules engine
- M3 Demand & Proposal: structured form + 4 templates + MD export + HTML PPT (reveal.js)
- M4 Influencer Matching: CSV/JSON upload + basic filter + CSV export
- M5 AI Chat: DeepSeek V4 Flash conversational strategy
- Admin Dashboard: user overview, token tracking, activity log, invites

### Known Gaps
- M4 only 5 sample influencers, no real database
- M4/M3 pipeline disconnected
- M2 static rules only, no AI
- No demand status workflow
- Feishu local export only

### Tech Stack
- Frontend: Vanilla HTML/CSS/JS SPA + Notion theme + reveal.js
- Backend: Express 5 + better-sqlite3 + JWT + bcrypt
- AI: DeepSeek API (deepseek-chat)
- Port: 3002

---

## v5.2 (2026-06-03) - Phase 1: Influencer Database + Smart Matching (completed)

**Branch:** codex/phase-1-influencer-db

### Planned
- [x] SQLite influencer table + server API (GET/POST/filter)
- [ ] Seed real influencer data from vault knowledge
- [ ] Smart matching algorithm: budget x followers x engagement x category
- [ ] Collaboration tracking workflow
- [ ] M4 frontend upgrade

### Tech Details
- Table: influencers (platform, handle, followers, engagement, category, region, cost_range, collab_type, past_brands)
- Table: collaborations (demand_id, influencer_id, status, notes, timeline)
- API: CRUD + filter by platform/category/region/followers_range + smart match endpoint
