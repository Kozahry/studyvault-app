# StudyVault — AI-Powered Exam Prep

Upload past exam papers, AI extracts every question with LaTeX math, tags them hierarchically, and gives you analytics, a smart study planner, and custom practice paper generation.

## Quick Start (3 commands)

**Prerequisites:** [Node.js](https://nodejs.org/) v18+ installed.

```bash
# 1. Install dependencies
npm install

# 2. Add your API key (pick ONE method)

#    Method A: Create .env file (recommended)
cp .env.example .env
#    Then edit .env and paste your Anthropic API key

#    Method B: Skip this — paste your key in the app sidebar instead

# 3. Run
npm run dev
```

Opens at **http://localhost:3000**

## Getting an API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Create a new API key
3. Either:
   - Paste it in the `.env` file as `VITE_ANTHROPIC_API_KEY=sk-ant-...`
   - Or paste it in the 🔑 API Key field at the bottom of the app sidebar

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | React 18 (Vite) |
| Charts | Recharts |
| Math Rendering | KaTeX (loaded from CDN) |
| PDF Viewing | PDF.js (loaded from CDN) |
| PDF Generation | jsPDF (loaded from CDN) |
| AI | Anthropic Claude API (Sonnet) |
| Persistence | localStorage |
| Fonts | Outfit, JetBrains Mono, Fraunces |

## Features

- **Upload & Scan** — Drop PDFs, AI extracts every question with LaTeX math
- **Hierarchical Tags** — Parent topics > specific tags, sorted by frequency
- **Smart Filtering** — By tag, topic, question number, difficulty, paper, semester
- **Built-in PDF Viewer** — Native iframe + rendered pages with toggle
- **AI Solver** — One-click step-by-step solutions with LaTeX
- **Analytics Dashboard** — Topic trends, difficulty comparison, semester filtering
- **Study Planner** — Topics ranked by reward score (frequency × marks / difficulty)
- **Exam Weighting** — Linear/exponential decay to prioritize recent exams
- **PDF Generator** — Create custom practice papers from filtered questions
- **Standardized Naming** — Auto-detects course code, year level, semester from filenames
- **Persistent Storage** — Everything saved to localStorage, survives browser restarts

## Build for Production

```bash
npm run build
```

Output in `dist/` — deploy to any static host (Vercel, Netlify, GitHub Pages, etc.)
