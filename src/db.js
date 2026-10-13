/**
 * Pocket Mentor - SQLite data layer (node:sqlite, zero npm dependencies).
 *
 * Tables
 *   users            - students
 *   materials        - uploaded study documents + extracted raw text
 *   summaries        - AI generated summary + important points (1:1 material)
 *   topics           - weighted topics extracted per material
 *   flashcards       - generated Q/A cards (+ spaced-repetition counters)
 *   quizzes          - one generated quiz per material
 *   quiz_questions   - MCQ rows belonging to a quiz
 *   attempts         - one row per quiz submission (score, weak topics)
 *   attempt_answers  - per-question answer detail
 *   study_sessions   - activity log powering the dashboard streak
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export function openDatabase(dbPath) {
  const abs = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER DEFAULT 0,
    source_kind TEXT,
    raw_text TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    engine TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
    summary_text TEXT NOT NULL,
    important_points TEXT NOT NULL DEFAULT '[]',
    read_minutes INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    weight REAL DEFAULT 1,
    mentions INTEGER DEFAULT 1,
    evidence TEXT
  );

  CREATE TABLE IF NOT EXISTS flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    topic TEXT,
    times_reviewed INTEGER DEFAULT 0,
    times_correct INTEGER DEFAULT 0,
    last_reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    topic TEXT,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_index INTEGER NOT NULL,
    explanation TEXT,
    position INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    percentage REAL NOT NULL,
    weak_topics TEXT NOT NULL DEFAULT '[]',
    strong_topics TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attempt_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
    topic TEXT,
    chosen_index INTEGER,
    is_correct INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS study_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
    activity TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_materials_user ON materials(user_id);
  CREATE INDEX IF NOT EXISTS idx_flashcards_material ON flashcards(material_id);
  CREATE INDEX IF NOT EXISTS idx_questions_quiz ON quiz_questions(quiz_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
  CREATE INDEX IF NOT EXISTS idx_topics_material ON topics(material_id);
  `);
  return db;
}

/* ------------------------------------------------------------- queries ---- */

export const q = {
  getOrCreateUser(db, name = 'Demo Student', email = 'student@pocketmentor.app') {
    let row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(name, email);
      row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }
    return row;
  },

  listMaterials(db, userId) {
    return db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM flashcards f WHERE f.material_id = m.id) AS card_count,
        (SELECT COUNT(*) FROM quiz_questions qq
           JOIN quizzes qz ON qz.id = qq.quiz_id WHERE qz.material_id = m.id) AS question_count,
        (SELECT MAX(percentage) FROM attempts a
           JOIN quizzes qz2 ON qz2.id = a.quiz_id
          WHERE qz2.material_id = m.id AND a.user_id = m.user_id) AS best_score
      FROM materials m
      WHERE m.user_id = ?
      ORDER BY m.created_at DESC, m.id DESC
    `).all(userId);
  },

  getMaterial(db, id, userId) {
    return db.prepare('SELECT * FROM materials WHERE id = ? AND user_id = ?').get(id, userId);
  },

  getSummary(db, materialId) {
    return db.prepare('SELECT * FROM summaries WHERE material_id = ?').get(materialId);
  },

  getTopics(db, materialId) {
    return db.prepare('SELECT * FROM topics WHERE material_id = ? ORDER BY weight DESC').all(materialId);
  },

  getFlashcards(db, materialId) {
    return db.prepare('SELECT * FROM flashcards WHERE material_id = ? ORDER BY id').all(materialId);
  },

  getQuizWithQuestions(db, materialId) {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE material_id = ?').get(materialId);
    if (!quiz) return null;
    const questions = db.prepare(
      'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id'
    ).all(quiz.id);
    return { quiz, questions };
  },

  listAttempts(db, userId, limit = 20) {
    return db.prepare(`
      SELECT a.*, m.title AS material_title
      FROM attempts a
      JOIN quizzes qz ON qz.id = a.quiz_id
      JOIN materials m ON m.id = qz.material_id
      WHERE a.user_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `).all(userId, limit);
  },

  weakTopics(db, userId) {
    const rows = db.prepare(`
      SELECT aa.topic AS topic,
             SUM(aa.is_correct) AS correct,
             COUNT(*) AS total
      FROM attempt_answers aa
      JOIN attempts a ON a.id = aa.attempt_id
      WHERE a.user_id = ? AND aa.topic IS NOT NULL
      GROUP BY aa.topic
      HAVING COUNT(*) > 0
      ORDER BY (CAST(SUM(aa.is_correct) AS REAL) / COUNT(*)) ASC, COUNT(*) DESC
    `).all(userId);
    return rows.map((r) => ({
      topic: r.topic,
      accuracy: Number(((r.correct / r.total) * 100).toFixed(1)),
      attempts: r.total,
      status: r.correct / r.total >= 0.8 ? 'strong' : r.correct / r.total >= 0.5 ? 'review' : 'weak',
    }));
  },

  dashboardStats(db, userId) {
    const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p) || {})[0] ?? 0;
    return {
      materials: one('SELECT COUNT(*) FROM materials WHERE user_id = ?', userId),
      flashcards: one(`SELECT COUNT(*) FROM flashcards f JOIN materials m ON m.id = f.material_id WHERE m.user_id = ?`, userId),
      quizzes: one(`SELECT COUNT(*) FROM quizzes qz JOIN materials m ON m.id = qz.material_id WHERE m.user_id = ?`, userId),
      attempts: one('SELECT COUNT(*) FROM attempts WHERE user_id = ?', userId),
      avgScore: Number(one('SELECT COALESCE(AVG(percentage),0) FROM attempts WHERE user_id = ?', userId).toFixed ? Number(one('SELECT COALESCE(AVG(percentage),0) FROM attempts WHERE user_id = ?', userId)).toFixed(1) : 0),
      bestScore: Number(one('SELECT COALESCE(MAX(percentage),0) FROM attempts WHERE user_id = ?', userId)),
      reviewedCards: one(`SELECT COALESCE(SUM(times_reviewed),0) FROM flashcards f JOIN materials m ON m.id = f.material_id WHERE m.user_id = ?`, userId),
      weakTopicCount: q.weakTopics(db, userId).filter((t) => t.status === 'weak').length,
    };
  },
};

/* ---------------------------------------------------------------- seed ---- */

const SEED_TEXT = `Cell Biology Fundamentals is the study of the basic structural and functional units of living organisms. The cell is the smallest unit of life capable of independent existence, and all living organisms are composed of one or more cells.
Prokaryotic cells are simple cells that lack a membrane-bound nucleus and membrane-bound organelles. Bacteria and archaea are prokaryotes, and their genetic material floats freely in the cytoplasm within a region called the nucleoid.
Eukaryotic cells are complex cells that contain a true nucleus enclosed by a nuclear membrane and numerous membrane-bound organelles. Plants, animals, fungi and protists are eukaryotes. Eukaryotic cells are generally ten to one hundred times larger than prokaryotic cells.
The cell membrane is a selectively permeable phospholipid bilayer that controls the movement of substances into and out of the cell. Small nonpolar molecules diffuse directly across the membrane, while ions and large polar molecules require transport proteins.
Mitochondria are the powerhouse of the cell because they carry out cellular respiration and produce adenosine triphosphate, abbreviated ATP, which is the main energy currency of the cell. Mitochondria have their own circular DNA and a double membrane, the inner layer of which is folded into cristae.
Ribosomes are the sites of protein synthesis and are found in both prokaryotic and eukaryotic cells. Ribosomes translate messenger RNA into polypeptide chains using the genetic code.
Chloroplasts are found only in plant cells and some algae, and they carry out photosynthesis. Chlorophyll is the green pigment inside chloroplasts that absorbs light energy and converts carbon dioxide and water into glucose and oxygen.
The nucleus contains the genetic material of the cell and controls all cellular activities by regulating gene expression. Inside the nucleus, DNA is packaged with histone proteins into structures called chromosomes.
The cell cycle describes the series of stages a cell passes through in order to divide. Interphase, comprising gap one, synthesis and gap two, accounts for about ninety percent of the cell cycle, while mitosis is the phase in which the nucleus divides.
Osmosis is the movement of water across a selectively permeable membrane from a region of lower solute concentration to a region of higher solute concentration. Osmosis helps maintain the water balance of the cell.
Enzymes are biological catalysts that speed up chemical reactions by lowering the activation energy. Enzymes are highly specific, and each enzyme has an active site whose shape is complementary to its substrate.`;

export function seedIfEmpty(db) {
  const user = q.getOrCreateUser(db);
  const count = db.prepare('SELECT COUNT(*) AS c FROM materials WHERE user_id = ?').get(user.id).c;
  if (count > 0) return user;

  const words = SEED_TEXT.split(/\s+/).filter(Boolean).length;
  const info = db.prepare(`
    INSERT INTO materials (user_id, title, filename, mime_type, size_bytes, source_kind, raw_text, word_count, engine, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
  `).run(
    user.id,
    'Sample: Cell Biology Fundamentals',
    'cell_biology_fundamentals.txt',
    'text/plain',
    SEED_TEXT.length,
    'text',
    SEED_TEXT,
    words,
    'local-engine'
  );
  db.prepare(`INSERT INTO study_sessions (user_id, material_id, activity) VALUES (?, ?, 'seed')`)
    .run(user.id, info.lastInsertRowid);
  return user;
}

export function persistAnalysis(db, materialId, analysis) {
  const tx = () => {
    const existing = db.prepare('SELECT id FROM summaries WHERE material_id = ?').get(materialId);
    if (!existing) {
      db.prepare(`INSERT INTO summaries (material_id, summary_text, important_points, read_minutes)
                  VALUES (?, ?, ?, ?)`)
        .run(materialId, analysis.summary, JSON.stringify(analysis.importantPoints || []),
             analysis.summaryStats?.readMinutes ?? 1);
    }
    db.prepare('DELETE FROM topics WHERE material_id = ?').run(materialId);
    const ti = db.prepare('INSERT INTO topics (material_id, name, weight, mentions, evidence) VALUES (?,?,?,?,?)');
    for (const t of analysis.topics || []) ti.run(materialId, t.name, t.weight, t.mentions, t.evidence || '');

    db.prepare('DELETE FROM flashcards WHERE material_id = ?').run(materialId);
    const fi = db.prepare('INSERT INTO flashcards (material_id, question, answer, topic) VALUES (?,?,?,?)');
    for (const f of analysis.flashcards || []) fi.run(materialId, f.question, f.answer, f.topic || 'General');

    const oldQuiz = db.prepare('SELECT id FROM quizzes WHERE material_id = ?').get(materialId);
    if (oldQuiz) db.prepare('DELETE FROM quizzes WHERE id = ?').run(oldQuiz.id);
    db.prepare('INSERT INTO quizzes (material_id, title) VALUES (?, ?)')
      .run(materialId, 'Topic Quiz');
    const quizId = db.prepare('SELECT id FROM quizzes WHERE material_id = ?').get(materialId).id;
    const qi = db.prepare(`INSERT INTO quiz_questions (quiz_id, topic, question, options, correct_index, explanation, position)
                           VALUES (?,?,?,?,?,?,?)`);
    (analysis.quiz || []).forEach((qq, i) =>
      qi.run(quizId, qq.topic || 'General', qq.question, JSON.stringify(qq.options),
             qq.correctIndex, qq.explanation || '', i));
  };
  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
