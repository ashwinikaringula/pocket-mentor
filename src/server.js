/**
 * Pocket Mentor - HTTP + REST API server.
 * Zero npm dependencies: node:http router, node:sqlite storage, local static.
 *
 * Run:  npm start        ->  http://localhost:4000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDatabase, q, seedIfEmpty, persistAnalysis } from './db.js';
import { extractTextFromBuffer } from './docx.js';
import { analyseMaterial } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const db = openDatabase(config.dbPath);
const user = seedIfEmpty(db);

/* ----------------------------------------------------- bootstrap analysis -- */
// Give the seeded sample material its summary / flashcards / quiz on first boot.
(async function bootstrapSeedAnalysis() {
  try {
    const rows = db.prepare(`
      SELECT m.id, m.title, m.raw_text FROM materials m
      LEFT JOIN summaries s ON s.material_id = m.id
      WHERE s.id IS NULL
    `).all();
    for (const r of rows) {
      const analysis = await analyseMaterial(r.raw_text, r.title, config.ai);
      persistAnalysis(db, r.id, analysis);
    }
    if (rows.length) console.log(`  ↳ generated study resources for ${rows.length} seeded material(s)`);
  } catch (e) {
    console.error('  ↳ seed analysis skipped:', e.message);
  }
})();

/* ----------------------------------------------------------------- utils -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-filename,x-title',
    ...headers,
  });
  res.end(payload);
}
const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, status, message) => send(res, status, { ok: false, error: message });

function readBody(req, limit = config.maxUploadBytes + 1024 * 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`Payload exceeds limit of ${Math.round(limit / 1048576)} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return readBody(req, 1024 * 512).then((b) => {
    if (!b.length) return {};
    try { return JSON.parse(b.toString('utf8')); } catch { throw new Error('Invalid JSON body'); }
  });
}

function cleanTitle(name) {
  return decodeURIComponent(String(name))
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled Material';
}

function logSession(materialId, activity) {
  db.prepare('INSERT INTO study_sessions (user_id, material_id, activity) VALUES (?, ?, ?)')
    .run(user.id, materialId ?? null, activity);
}

/* ------------------------------------------------------------- AI engine -- */
// Synchronous pipeline (works for both local-engine and LLM providers).

async function buildMaterial({ title, filename, mimeType, buffer }) {
  const ext = path.extname(filename).toLowerCase();
  if (!config.allowedExtensions.includes(ext)) {
    throw new Error(`Unsupported extension "${ext}". Allowed: ${config.allowedExtensions.join(', ')}`);
  }
  if (buffer.length > config.maxUploadBytes) {
    throw new Error(`File too large. Max ${Math.round(config.maxUploadBytes / 1048576)} MB.`);
  }

  const { text, kind } = extractTextFromBuffer(buffer, filename);
  if (!text || text.replace(/\s/g, '').length < 200) {
    throw new Error(
      'Could not extract enough text. The document may be a scanned/image-only PDF, protected, or empty.'
    );
  }

  const info = db.prepare(`
    INSERT INTO materials (user_id, title, filename, mime_type, size_bytes, source_kind, raw_text, word_count, engine, status)
    VALUES (?,?,?,?,?,?,?,?,?, 'analysing')
  `).run(
    user.id, title, filename, mimeType || 'application/octet-stream', buffer.length, kind,
    text, text.split(/\s+/).filter(Boolean).length, config.ai.provider
  );
  const materialId = Number(info.lastInsertRowid);

  const analysis = await analyseMaterial(text, title, config.ai);
  persistAnalysis(db, materialId, analysis);
  db.prepare("UPDATE materials SET status = 'ready', engine = ? WHERE id = ?")
    .run(analysis.engine || config.ai.provider, materialId);
  logSession(materialId, 'upload');

  return {
    material: q.getMaterial(db, materialId, user.id),
    summary: q.getSummary(db, materialId),
    topics: q.getTopics(db, materialId),
    flashcards: q.getFlashcards(db, materialId),
    quiz: q.getQuizWithQuestions(db, materialId),
  };
}

/* --------------------------------------------------------------- routes --- */

function materialPayload(materialId) {
  const material = q.getMaterial(db, materialId, user.id);
  if (!material) return null;
  const summary = q.getSummary(db, materialId);
  const topics = q.getTopics(db, materialId);
  const flashcards = q.getFlashcards(db, materialId);
  const quiz = q.getQuizWithQuestions(db, materialId);
  const attempts = db.prepare(
    'SELECT * FROM attempts WHERE quiz_id = ? ORDER BY id DESC'
  ).all(quiz?.quiz.id ?? -1);
  const topicPerformance = q.weakTopics(db, user.id);
  return {
    material,
    summary: summary
      ? { ...summary, important_points: JSON.parse(summary.important_points || '[]') }
      : null,
    topics,
    flashcards,
    quiz: quiz
      ? {
          ...quiz.quiz,
          questions: quiz.questions.map((qq) => ({ ...qq, options: JSON.parse(qq.options) })),
        }
      : null,
    attempts,
    topicPerformance,
  };
}

const routes = {
  'GET /api/health': async () => ({
    status: 'ok',
    service: 'pocket-mentor',
    engine: config.ai.provider,
    database: path.basename(config.dbPath),
    time: new Date().toISOString(),
  }),

  'GET /api/me': async () => ({ user, engine: config.ai.provider }),

  'GET /api/dashboard': async () => ({
    stats: q.dashboardStats(db, user.id),
    materials: q.listMaterials(db, user.id),
    weakTopics: q.weakTopics(db, user.id),
    attempts: q.listAttempts(db, user.id, 6),
  }),

  'GET /api/materials': async () => q.listMaterials(db, user.id),

  'GET /api/attempts': async () => q.listAttempts(db, user.id, 50),

  'GET /api/weak-topics': async () => q.weakTopics(db, user.id),

  'GET /api/revision-plan': async () => {
    const weak = q.weakTopics(db, user.id).filter((t) => t.status !== 'strong');
    const plan = weak.map((t, i) => {
      const cards = db.prepare(`
        SELECT f.id, f.question, f.answer, f.topic, m.title AS material_title, m.id AS material_id
        FROM flashcards f JOIN materials m ON m.id = f.material_id
        WHERE m.user_id = ? AND f.topic = ? ORDER BY f.times_reviewed ASC LIMIT 5
      `).all(user.id, t.topic);
      return {
        step: i + 1,
        topic: t.topic,
        accuracy: t.accuracy,
        status: t.status,
        reason:
          t.status === 'weak'
            ? `Accuracy ${t.accuracy}% - below the 50% mastery threshold`
            : `Accuracy ${t.accuracy}% - close to mastery, needs one more pass`,
        suggestedCards: cards,
      };
    });
    return {
      generatedAt: new Date().toISOString(),
      focusCount: plan.length,
      plan: plan.length
        ? plan
        : [{ step: 0, topic: 'All topics', accuracy: 100, status: 'strong',
             reason: 'No attempt history yet - take a quiz to generate a personalised plan.', suggestedCards: [] }],
    };
  },
};

/* ------------------------------------------------------------ dispatcher -- */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // exact routes
  const exact = routes[`${req.method} ${p}`];
  if (exact) return ok(res, await exact(url));

  // POST /api/materials  (raw binary body + X-Filename header)
  if (req.method === 'POST' && p === '/api/materials') {
    const filename = req.headers['x-filename'];
    if (!filename) return fail(res, 400, 'X-Filename header is required');
    const buffer = await readBody(req);
    if (!buffer.length) return fail(res, 400, 'Empty request body');
    const title = req.headers['x-title']
      ? cleanTitle(req.headers['x-title'])
      : cleanTitle(filename);
    const result = await buildMaterial({
      title,
      filename: decodeURIComponent(String(filename)),
      mimeType: req.headers['content-type'],
      buffer,
    });
    return send(res, 201, { ok: true, data: result });
  }

  // POST /api/materials/sample  (re-ingest a built-in sample through the full pipeline)
  if (req.method === 'POST' && p === '/api/materials/sample') {
    const { sampleText } = await import('./samples.js');
    const result = await buildMaterial({
      title: 'Sample: Photosynthesis & Plant Biology',
      filename: 'photosynthesis_sample.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(sampleText, 'utf8'),
    });
    return send(res, 201, { ok: true, data: result });
  }

  let m;
  if ((m = p.match(/^\/api\/materials\/(\d+)$/))) {
    const id = Number(m[1]);
    if (req.method === 'GET') {
      const payload = materialPayload(id);
      return payload ? ok(res, payload) : fail(res, 404, 'Material not found');
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM materials WHERE id = ? AND user_id = ?').run(id, user.id);
      return ok(res, { deleted: id });
    }
  }

  if ((m = p.match(/^\/api\/materials\/(\d+)\/quiz$/)) && req.method === 'GET') {
    const payload = materialPayload(Number(m[1]));
    return payload?.quiz ? ok(res, payload.quiz) : fail(res, 404, 'No quiz for this material');
  }

  if ((m = p.match(/^\/api\/materials\/(\d+)\/reanalyse$/)) && req.method === 'POST') {
    const id = Number(m[1]);
    const material = q.getMaterial(db, id, user.id);
    if (!material) return fail(res, 404, 'Material not found');
    const analysis = await analyseMaterial(material.raw_text, material.title, config.ai);
    persistAnalysis(db, id, analysis);
    return ok(res, materialPayload(id));
  }

  if ((m = p.match(/^\/api\/quizzes\/(\d+)\/submit$/)) && req.method === 'POST') {
    const quizId = Number(m[1]);
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
    if (!quiz) return fail(res, 404, 'Quiz not found');
    const body = await readJson(req);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const questions = db.prepare(
      'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id'
    ).all(quizId);

    let score = 0;
    const perTopic = new Map();
    const detail = questions.map((qq, i) => {
      const chosen = Number.isInteger(answers[i]) ? answers[i] : -1;
      const isCorrect = chosen === qq.correct_index;
      if (isCorrect) score++;
      const t = qq.topic || 'General';
      const cur = perTopic.get(t) || { correct: 0, total: 0 };
      cur.total++; if (isCorrect) cur.correct++;
      perTopic.set(t, cur);
      return { question_id: qq.id, topic: t, chosen_index: chosen, is_correct: isCorrect,
               correct_index: qq.correct_index, options: JSON.parse(qq.options) };
    });

    const total = questions.length;
    const percentage = total ? Number(((score / total) * 100).toFixed(1)) : 0;
    const weakTopics = []; const strongTopics = [];
    for (const [t, v] of perTopic) {
      const acc = v.correct / v.total;
      (acc >= 0.6 ? strongTopics : weakTopics).push(t);
    }

    db.exec('BEGIN');
    let attemptId;
    try {
      const info = db.prepare(`
        INSERT INTO attempts (quiz_id, user_id, score, total, percentage, weak_topics, strong_topics)
        VALUES (?,?,?,?,?,?,?)
      `).run(quizId, user.id, score, total, percentage,
             JSON.stringify(weakTopics), JSON.stringify(strongTopics));
      attemptId = Number(info.lastInsertRowid);
      const ai = db.prepare(`INSERT INTO attempt_answers (attempt_id, question_id, topic, chosen_index, is_correct)
                             VALUES (?,?,?,?,?)`);
      for (const d of detail) ai.run(attemptId, d.question_id, d.topic, d.chosen_index, d.is_correct ? 1 : 0);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    const materialId = quiz.material_id;
    logSession(materialId, 'quiz_attempt');

    return send(res, 201, {
      ok: true,
      data: {
        attempt: { id: attemptId, quiz_id: quizId, score, total, percentage,
                   weak_topics: weakTopics, strong_topics: strongTopics },
        detail,
        topicPerformance: q.weakTopics(db, user.id),
        revisionPlanHint: weakTopics.length
          ? `Focus next on: ${weakTopics.join(', ')}`
          : 'Excellent - no weak topics detected in this attempt.',
      },
    });
  }

  if ((m = p.match(/^\/api\/flashcards\/(\d+)\/review$/)) && req.method === 'POST') {
    const id = Number(m[1]);
    const body = await readJson(req);
    const correct = body.correct ? 1 : 0;
    const card = db.prepare(`
      SELECT f.* FROM flashcards f JOIN materials m ON m.id = f.material_id
      WHERE f.id = ? AND m.user_id = ?
    `).get(id, user.id);
    if (!card) return fail(res, 404, 'Flashcard not found');
    db.prepare(`UPDATE flashcards SET times_reviewed = times_reviewed + 1,
                times_correct = times_correct + ?, last_reviewed_at = datetime('now') WHERE id = ?`)
      .run(correct, id);
    if (card.material_id) logSession(card.material_id, 'flashcard_review');
    return ok(res, db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id));
  }

  // static assets
  if (req.method === 'GET') {
    const rel = p === '/' ? '/index.html' : p;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      return send(res, 200, fs.readFileSync(filePath), { 'content-type': MIME[ext] || 'application/octet-stream' });
    }
  }
  return fail(res, 404, `No route for ${req.method} ${p}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[error]', req.method, req.url, '-', err.message);
    if (!res.headersSent) fail(res, 400, err.message);
  });
});

if (process.env.PM_SILENT !== '1') {
  server.listen(config.port, config.host, () => {
    console.log(`\n  Pocket Mentor - AI Study & Revision Assistant`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  Server   : http://localhost:${config.port}`);
    console.log(`  Database : ${path.resolve(config.dbPath)}`);
    console.log(`  AI engine: ${config.ai.provider}`);
    console.log(`  User     : ${user.name} <${user.email}>\n`);
  });
}

export { server, db, handle };
