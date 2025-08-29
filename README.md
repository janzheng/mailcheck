### MailCheck — Real‑Person Email Verifier (Groq)

Verify that email addresses belong to real people using lightweight web + LLM signals. Upload/paste lists, run concurrent checks, and export annotated results.

What it does
- Upload CSV/JSON or paste text; inline edit and delete rows
- Jobs sidebar with autosave (localStorage)
- Per‑email verification with concurrency and live row updates
  - Syntax check (invalid → spam)
  - Academic domain detection (institution annotation)
  - Role/alias heuristic (flags generic addresses)
  - Web + LLM assessments consolidated by a final judge into one decision
- Export CSV/JSON (preserves original columns + `bg_*` fields)

Statuses
- person_high
- person_low
- person_none
- spam

Requirements
- Deno 1.40+
- Groq API key

Run locally
```sh
deno run -A main.js
```
Open http://localhost:8000. If the server doesn’t have `GROQ_API_KEY`, set a key in the UI.

Environment
- `GROQ_API_KEY`: Groq key (server). The UI also supports a per‑user key.

API

- POST `/api/check/background`
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

Notes
- Focuses on real‑person verification, not SMTP deliverability.
- The UI is a thin client over the API—use the endpoint directly if preferred.
- Lists in the UI are “One per line”; for API requests pass arrays of strings.
- Regex tips: escape dots in domains (`gmail\.com`), anchor when needed (`^...$`).

Powered by Groq — get a key at https://groq.com.
