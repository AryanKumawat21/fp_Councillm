# CounciLLM

CounciLLM is a local multi-model AI council orchestrating specialized models for routing, general reasoning, coding, and visual understanding.

## Project Layout

- `frontend/` — Static HTML & local authentication UI (`index.html`, `auth.js`).
- `config/council.json` — Council model definitions (`qwen3-router`, `qwen3-general`, `granite-coding`, `qwen3-vision`).
- `work/` — Persistent workspace state (`state.json`).

## Running Locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.
