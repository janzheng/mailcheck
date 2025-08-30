## MailCheck — Real‑Person Email Verifier (Groq)

Verify that email addresses belong to real people using lightweight web + LLM signals. Upload/paste lists, run concurrent checks, and export annotated results.

## Features
- Upload CSV/JSON or paste text; inline edit and delete rows
- Jobs sidebar with autosave (localStorage)
- Per‑email verification with concurrency and live row updates
  - Syntax check (invalid → spam)
  - Academic domain detection (institution annotation)
  - Role/alias heuristic (flags generic addresses)
  - Web + LLM assessments consolidated by a final judge into one decision
- Allowlist/Blocklist with domains, exact emails, or regex
- Export CSV/JSON (preserves original columns + `bg_*` fields)

## How it works

### UI (index.html)
The app is a single HTML page (`index.html`) that serves a light client built with Alpine.js and Tailwind. It lets you:
- Paste or upload emails, edit rows inline, and run checks.
- Provide an optional system prompt to steer LLM behavior.
- Configure an Allowlist/Blocklist (one rule per line; supports domains, exact emails, and regex).
- Kick off background jobs and download results as CSV/JSON.

### Decision pipeline
For each email, MailCheck performs a staged evaluation and collapses results into a single status and message:

1) Pre‑assessors (fast short‑circuits)
- Syntax guard: invalid formats → `spam`.
- Allowlist: immediate `whitelist` with rule annotation.
- Blocklist: immediate `spam` with rule annotation.
- Academic detector: annotate institution; enables leniency downstream.
- Role heuristic: flags role/alias locals (e.g., `info`, `noreply`).

2) Full assessors (run in parallel)
- Compound LLM (model: `compound-beta`): returns strict JSON with
  - `status` in `{ person_high, person_low, person_none, spam }`
  - `message`, `explanation_short`, and `evidence[]`
  The prompt prefers identity‑first summaries and concrete evidence (role/title, org, city) and penalizes vague name‑only matches.
- Browser Search (model: `openai/gpt-oss-20b` + `browser_search` tool): performs targeted queries (quoted email, handle+domain, site:linkedin, site:github, org/staff pages). Produces an analysis that is converted to JSON with status/message/explanation/evidence.

3) Final judge (model: `openai/gpt-oss-120b`)
Consolidates assessor outputs + heuristics (academic, role, domain). Policy:
- Severity order: `spam > person_none > person_low > person_high`.
- Credible anti‑abuse signals → `spam`.
- Plausible identity from reputable sources, no negatives → promote to `person_high`.
- Leniency: non‑generic org/academic domains with weak but plausible signals may prefer `person_low` over `person_none`.
The judge produces a single status/message, a short identity‑first summary, and deduplicated evidence bullets suitable for the UI.

### Labels & messages
Statuses map to compact UI labels (e.g., `person_low` → “possible person”). Where assessors supply explanations, we derive a short identity‑first one‑liner for readability.

## Statuses
- `person_high`
- `person_low`
- `person_none`
- `spam`
- `whitelist` (short‑circuit on allowlist)

## Requirements
- Deno 1.40+
- Groq API key

## Quick Start
1) Install Deno: https://deno.land/#installation
2) Start the dev server:
```sh
deno task serve
```
This runs: `deno serve --port 8013 --allow-sys --allow-read --allow-import --allow-env --allow-write --allow-net --reload=https://esm.town ./main.js`.

Open http://localhost:8013. If the server doesn’t have `GROQ_API_KEY`, add a user key in the UI.

## Configuration
- `GROQ_API_KEY`: Groq key (server). The UI also supports a per‑user key.

## API Reference

### Single check
POST `/api/check/background`
  - body
    ```json
    {
      "email": "someone@example.com",
      "systemPrompt": "optional extra guidance",
      "userApiKey": "<optional if server GROQ_API_KEY is set>",
      "whitelist": [
        "@company.com",
        "*@partner.org",
        "/^first\\.last@org\\.edu$/i"
      ],
      "blacklist": [
        "@temp-mail.com",
        "*@noidem",
        "/^[a-z]{2,}\\d{2,4}@gmail\\.com$/i"
      ]
    }
    ```
  - notes
    - `whitelist` (UI label: Allowlist) and `blacklist` (UI label: Blocklist) accept strings:
      - exact email: `"user@example.com"`
      - domain tokens: `"@example.com"`, `"*@example.com"`, or bare `"example.com"`
      - regex tokens: strings wrapped with slashes, e.g. `"/^first\\.last@company\\.com$/i"`
        - regexes are tested against the full raw email; for convenience we also test local‑part + `@`
    - If an allowlist rule matches, the request short‑circuits with status `whitelist`.
    - If a blocklist rule matches, the request short‑circuits with status `spam` and `bg_blacklist_*` fields.
    - If neither matches, the flow proceeds to heuristics + model assessors.
  - returns
    ```json
    {
      "email": "someone@example.com",
      "status": "person_low | person_high | person_none | spam | whitelist",
      "message": "short description",
      "fields": { "bg_*": "diagnostic fields for UI" }
    }
    ```

### Async jobs
Create a job to process many emails concurrently.

- Create job
  - POST `/api/jobs`
  - body
  ```json
  {
    "items": ["a@example.com", {"email": "b@example.com"}],
    "systemPrompt": "",
    "concurrency": 8,
    "userApiKey": "<optional>"
  }
  ```
  - response: job summary `{ id, running, total, completed, items: [{ id, email, status }] }`

- Get status: GET `/api/jobs/:id`
- Cancel: POST `/api/jobs/:id/cancel`

> Tip: If you want per‑job allowlist/blocklist, they can be added to the job payload and threaded into the runner.

## Notes
- Focuses on real‑person verification, not SMTP deliverability.
- The UI is a thin client over the API—use the endpoint directly if preferred.
- Lists in the UI are “One per line”; for API requests pass arrays of strings.
- Regex tips: escape dots in domains (`gmail\.com`), anchor when needed (`^...$`).

Powered by Groq — get a key at https://groq.com.
