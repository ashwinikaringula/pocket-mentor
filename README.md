# Pocket Mentor — AI Study & Revision Assistant

A complete, runnable full-stack web application built from the *Pocket Mentor* project abstract.

Students upload study notes → AI analyses the content → the app generates a **summary**, **important points**,
**Q&A flashcards** and a **topic-based quiz** → the student practises → **performance analysis** finds weak
topics → a **personalised revision plan** is produced. Every step is persisted in a SQLite database.

```
Student → Upload Notes → AI Analysis → Summary / Flashcards / Quiz → Dashboard
        → Quiz Practice → Performance → Personalised Revision
```

---

## Stack

| Layer     | Technology                                                                 |
|-----------|----------------------------------------------------------------------------|
| Frontend  | Vanilla JS single-page app (HTML + CSS + JS) served by the API — no build step |
| Backend   | Node.js 22 `node:http` REST API (zero npm dependencies)                     |
| Database  | SQLite via built-in `node:sqlite` (10 tables, foreign keys, WAL)            |
| AI engine | On-device NLP pipeline (`local-engine`); optional OpenAI/LLM passthrough    |

**No `npm install` required.** The app has zero third-party dependencies.

---

## Quick start

```bash
cd pocket-mentor
cp .env.example .env          # optional — sensible defaults are built in
npm start                     # → http://localhost:4000
```

Open <http://localhost:4000>. A seeded sample material (*Cell Biology Fundamentals*) is analysed on first
boot so the dashboard is never empty.

Other commands:

```bash
npm run migrate     # create/verify the schema only
npm run test:api    # 34-assertion end-to-end API + database test suite
npm run dev         # auto-restart on file change
```

> Requires Node.js **≥ 22.5** (for `node:sqlite`).

---

## Project structure

```
pocket-mentor/
├── package.json
├── .env.example
├── README.md
├── data/                        # SQLite file is created here on first run
├── src/
│   ├── server.js                # HTTP server, REST router, upload pipeline
│   ├── db.js                    # schema (10 tables), queries, seed data
│   ├── ai.js                    # AI analysis: summary, points, flashcards, quiz
│   ├── docx.js                  # dependency-free .docx / .pdf / .txt extraction
│   ├── samples.js               # built-in photosynthesis sample material
│   └── config.js                # .env loader + typed config
├── public/
│   ├── index.html               # 7-view SPA shell
│   ├── styles.css               # dark dashboard theme
│   └── app.js                   # SPA logic, fetch calls, quiz/flashcard UI
└── test/
    ├── api.test.js              # full API + DB round-trip test suite
    └── make-docx.js             # builds a real .docx fixture in-process
```

---

## Database schema

Ten normalised tables with `ON DELETE CASCADE` foreign keys:

| Table             | Purpose                                                        |
|-------------------|----------------------------------------------------------------|
| `users`           | Student accounts (demo student seeded automatically)           |
| `materials`       | Uploaded documents + extracted full text, word count, engine, status |
| `summaries`       | AI summary + important points (JSON) — 1:1 with material       |
| `topics`          | Weighted topics extracted per material, with source evidence    |
| `flashcards`      | Generated Q/A cards + review/correct counters for spaced repetition |
| `quizzes`         | One generated quiz per material                                |
| `quiz_questions`  | MCQ rows: options (JSON), correct index, explanation, position  |
| `attempts`        | One row per quiz submission: score, %, weak/strong topic lists  |
| `attempt_answers` | Per-question answer detail (chosen index, correct flag, topic)   |
| `study_sessions`  | Activity log (upload / quiz_attempt / flashcard_review)         |

---

## REST API

Base URL `http://localhost:4000`.

| Method | Endpoint                            | Description                                              |
|--------|-------------------------------------|----------------------------------------------------------|
| GET    | `/api/health`                       | Service status, active AI engine, database file          |
| GET    | `/api/me`                           | Current user + engine                                    |
| GET    | `/api/dashboard`                    | Stats, materials, weak topics, recent attempts           |
| GET    | `/api/materials`                    | All materials with card/question counts + best score     |
| POST   | `/api/materials`                    | **Upload** raw file (header `X-Filename`) → full analysis |
| POST   | `/api/materials/sample`             | Ingest the built-in sample through the full pipeline      |
| GET    | `/api/materials/:id`                | Material + summary + topics + flashcards + quiz + attempts |
| DELETE | `/api/materials/:id`                | Delete a material (cascades to all generated resources)  |
| POST   | `/api/materials/:id/reanalyse`      | Re-run AI generation on the stored text                  |
| GET    | `/api/materials/:id/quiz`           | Quiz + questions only                                    |
| POST   | `/api/quizzes/:id/submit`           | Submit `{"answers":[...]}` → scored attempt, weak topics |
| POST   | `/api/flashcards/:id/review`        | Mark a card `{"correct":true}` — feeds the revision plan |
| GET    | `/api/attempts`                     | Attempt history                                          |
| GET    | `/api/weak-topics`                  | Accuracy per topic with strong/review/weak status        |
| GET    | `/api/revision-plan`                | Personalised plan with the exact flashcards to review    |

### Upload example

```bash
curl -X POST http://localhost:4000/api/materials \
  -H "X-Filename: biology_notes.pdf" \
  -H "X-Title: Biology Unit 3" \
  -H "Content-Type: application/pdf" \
  --data-binary @biology_notes.pdf
```

---

## The AI engine

`src/ai.js` runs a deterministic six-stage NLP pipeline **entirely on-device** (no API key, no network):

1. **Tokenise & normalise** — sentences split, stopword corpus filtered.
2. **Keyword extraction** — term frequency + bigram n-grams with weight scoring.
3. **Topic extraction** — keywords grouped by paragraph co-occurrence, weighted by mentions, with an evidence sentence.
4. **Extractive summarisation** — sentences ranked by keyword density, lead bias, definition patterns, and length normalisation; restored to reading order.
5. **Flashcard generation** — definition-aware (`"X is Y"` → *What is X?*) plus cloze deletion on the highest-weight terms.
6. **Quiz generation** — cloze multiple-choice stems with same-document distractors, per-question topic tagging (8 MCQs).

### Swapping in a real LLM

Set these in `.env` and the identical JSON contract is produced by an external model:

```env
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
AI_BASE_URL=https://api.openai.com/v1
```

The database schema, API routes and frontend are provider-agnostic — nothing else changes.

---

## Supported upload formats

| Format | Extraction method                                                     |
|--------|-----------------------------------------------------------------------|
| `.docx`| Pure-Node ZIP central-directory parse → `inflateRaw` → OOXML strip     |
| `.pdf` | Best-effort `FlateDecode` stream scan for `Tj`/`TJ` text operators     |
| `.txt`, `.md` | Direct UTF-8 decode                                            |

Scanned/image-only PDFs contain no text layer; the API returns a clear
"could not extract enough text" error instead of producing empty resources.

---

## Performance model

Quiz submissions are stored per question with its topic, so accuracy is computed
per topic across the student's whole history:

- **≥ 80 %** → `strong`
- **50–79 %** → `review`
- **< 50 %** → `weak`

The revision plan takes every non-strong topic, explains the reason (accuracy vs.
the mastery threshold), and attaches the 5 least-reviewed flashcards for that topic.

---

## Test suite

```bash
npm run test:api
```

Boots the real HTTP server against a throwaway SQLite file and asserts **34 checks**:
health, seeded analysis, `.txt` and `.docx` upload → generation → DB read-back,
flashcard review counters, quiz submission with computed weak topics, dashboard
statistics, revision plan, re-analysis, cascade delete, and error handling
(unsupported extension, too-short document, 404s).

---

## Deploying to a live host

The app is a single Node process serving both the API and the static frontend.

- **Render / Railway / Fly.io** — start command `npm start`, Node ≥ 22, attach a persistent disk mounted at `./data` so the SQLite file survives restarts.
- **Docker** — `node:22-slim`, `EXPOSE 4000`, `CMD ["npm","start"]`, volume-mount `/app/data`.
- **VPS** — `npm start` behind Nginx/Caddy for TLS, or a `systemd` unit with `Restart=always`.

Set `PORT`, `DB_PATH`, `SESSION_SECRET` and (optionally) the `AI_*` variables as environment variables in your host's dashboard.
