# ShiftSync

A web app for Dubai/GCC hospitality shift scheduling: **"WhatsApp-to-App" parsing**, AI voice, UAE MOHRE legal-compliance tracking, and service-charge pools.

ShiftSync replaces the double-friction workflow (Excel → static image → WhatsApp → manual reconciliation) with a frictionless parser, one-click revocable live share links, and an automated compliance audit trail.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS recommended)
- npm (bundled with Node.js)
- [Docker Desktop](https://docs.docker.com/desktop/) (for the local Postgres — nothing else runs in Docker)
- Git Bash on Windows (the DB helper scripts shell out to `bash`)

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Start + provision the local database (Docker Postgres, migrated, seeded,
#    plus this branch's own schema). Idempotent — re-run any time.
npm run db:setup

# 3. Start the API + the Vite dev server together
npm run dev:all
```

Then open http://localhost:5173 in your browser.

That's the whole setup: **no cloud accounts, no tokens, no `.env` editing.**
`db:setup` copies `.env.example` (which ships real, working local-only
credentials) to `.env` if you don't have one, starts the `shiftsync-dev-postgres`
container from `docker-compose.yml`, waits for it, runs `prisma generate` +
`prisma migrate deploy`, seeds test data, and bootstraps a `dev_<branch>`
schema for the branch you're on. Every DB-touching npm script is scoped to that
branch schema automatically (`scripts/with-branch-schema.mjs`), so several
worktrees can share the one container without stepping on each other.

> **Replaces the old workflow.** Pulling `DATABASE_URL` from Vercel
> (`vercel env pull`) or any other shared cloud database is **no longer needed
> or expected for local development**. The Vercel-hosted database is for
> deployed environments only.

Port already taken? `POSTGRES_PORT=5433 npm run db:setup`, and change the port
in your `.env`'s `DATABASE_URL` to match. Wipe the local data completely with
`docker compose down -v`.

### Available Scripts

| Command                 | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `npm run db:setup`      | Start local Postgres, migrate, seed, bootstrap this branch's schema |
| `npm run dev:all`       | Start the API (port 4000) and the Vite dev server together      |
| `npm run dev`           | Start the Vite dev server only                                  |
| `npm run server:dev`    | Start the API only (branch-schema scoped)                       |
| `npm run build`         | Type-check and build for production                             |
| `npm run preview`       | Preview the production build                                    |
| `npm run lint`          | Run ESLint                                                      |
| `npm run typecheck`     | Run TypeScript type-checking (frontend)                         |
| `npm run server:typecheck` | Run TypeScript type-checking (API)                           |
| `npm test`              | Frontend unit tests (no DB needed)                              |
| `npm run test:server`   | API integration tests against the branch schema                 |
| `npm run test:e2e`      | Playwright end-to-end suite (starts both servers itself)        |
| `npm run prisma:migrate`| `prisma migrate dev` against the branch schema                  |
| `npm run prisma:studio` | Prisma Studio against the branch schema                         |
| `npm run db:seed`       | Re-seed test data into the branch schema                        |
| `npm run swarm`         | Run claude-flow swarm orchestration                             |
| `npm run sparc`         | Run claude-flow SPARC workflows                                 |
| `npm run local`         | Run local Ollama offloading                                     |

---

## 🗂 Project Structure

```
src/
├── main.tsx            # React entry point
├── App.tsx             # Root app component
├── styles/
│   └── global.css      # Dark Luxury Speakeasy design tokens
├── components/         # UI components (roster grid, parser, share, audit trail)
├── features/           # Feature modules (parser, compliance, service-charge)
├── lib/                # Core logic (parser engine, compliance rules, data model)
└── types/              # Shared domain types
```

---

## 🎨 Theme

ShiftSync uses a **Dark Luxury Speakeasy** palette with a zero-eye-strain dark mode:

| Token              | Value      | Usage                    |
| ------------------ | ---------- | ------------------------ |
| `background`       | `#0F0F12`  | Obsidian/charcoal base   |
| `surface`          | `#1A1A22`  | Card surfaces            |
| `surface-2`        | `#1E1E28`  | Elevated surfaces        |
| `border`           | `#2A2A36`  | Subtle card borders      |
| `text`             | `#E0E0E0`  | Off-white text           |
| `textSecondary`    | `#9CA3AF`  | Muted gray text          |
| `accent`           | `#E5A93C`  | Soft gold                |
| `danger`           | `#E5484D`  | Compliance warnings      |
| `success`          | `#2E9E5B`  | Positive states          |

---

## 🧱 Tech Stack

- **React** 19
- **Vite** 6
- **TypeScript** (strict)
- **ESLint** 9 (typescript-eslint, react-hooks, react-refresh)

---

## 📄 Product Requirements

See `SHIFTSYNC_PRD.md` for the full Master Product Requirements Document.

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
