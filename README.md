# ShiftSync

A web app for Dubai/GCC hospitality shift scheduling: **"WhatsApp-to-App" parsing**, AI voice, UAE MOHRE legal-compliance tracking, and service-charge pools.

ShiftSync replaces the double-friction workflow (Excel → static image → WhatsApp → manual reconciliation) with a frictionless parser, one-click revocable live share links, and an automated compliance audit trail.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS recommended)
- npm (bundled with Node.js)

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Start the Vite dev server
npm run dev
```

Then open http://localhost:5173 in your browser.

### Available Scripts

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `npm run dev`      | Start the Vite dev server            |
| `npm run build`    | Type-check and build for production  |
| `npm run preview`  | Preview the production build         |
| `npm run lint`     | Run ESLint                           |
| `npm run typecheck`| Run TypeScript type-checking         |
| `npm run swarm`    | Run claude-flow swarm orchestration  |
| `npm run sparc`    | Run claude-flow SPARC workflows      |
| `npm run reach`    | Run agent-reach research             |
| `npm run local`    | Run local Ollama offloading          |

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
