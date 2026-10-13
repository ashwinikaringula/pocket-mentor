/**
 * Pocket Mentor — end-to-end API test.
 * Boots the real HTTP server against a throwaway SQLite file and exercises
 * every route, asserting that rows are actually written to and read from the DB.
 *
 * Run:  npm run test:api
 */
import fs from 'node:fs';
import path from 'node:path';

const TMP = path.resolve('./data/test-pocket-mentor.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.DB_PATH = TMP;
process.env.PORT = '4123';
process.env.PM_SILENT = '1';

const { server, db } = await import('../src/server.js');
const base = 'http://127.0.0.1:4123';

await new Promise((r) => server.listen(4123, '127.0.0.1', r));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const j = async (p, o) => {
  const r = await fetch(base + p, o);
  return { status: r.status, body: await r.json() };
};

console.log('\nPocket Mentor API test suite\n' + '─'.repeat(46));

/* 1. health ---------------------------------------------------------------- */
const health = await j('/api/health');
check('GET /api/health', health.status === 200 && health.body.data.status === 'ok',
  `engine=${health.body.data.engine}`);

/* 2. dashboard (seed data present) ---------------------------------------- */
let dash = await j('/api/dashboard');
check('GET /api/dashboard', dash.body.ok && Array.isArray(dash.body.data.materials));
check('seed material exists in SQLite', dash.body.data.materials.length >= 1,
  `${dash.body.data.materials.length} material(s)`);
const seedMaterial = dash.body.data.materials[0];
check('seed material has generated flashcards', seedMaterial.card_count > 0, `${seedMaterial.card_count} cards`);
check('seed material has generated quiz questions', seedMaterial.question_count > 0, `${seedMaterial.question_count} questions`);

/* 3. upload .txt through the full pipeline -------------------------------- */
const txt = `Quantum computing is a field of computing that uses quantum mechanical phenomena such as superposition and entanglement to process information.
A qubit is the basic unit of quantum information and can exist in a superposition of the zero and one states simultaneously.
Superposition allows a quantum computer to evaluate many possible states at the same time, which is the source of its potential advantage.
Entanglement is a quantum correlation in which the state of one particle cannot be described independently of the state of another particle.
A quantum gate is an operation that changes the state of one or more qubits, and quantum circuits are sequences of quantum gates.
Decoherence is the loss of quantum behaviour caused by interaction with the environment, and it is the main obstacle to building large quantum computers.
Quantum error correction encodes logical qubits across many physical qubits so that errors can be detected and corrected.
Shor's algorithm is a quantum algorithm that factors integers exponentially faster than the best known classical algorithm.
Grover's algorithm provides a quadratic speedup for searching an unsorted database of items using amplitude amplification.
Quantum supremacy is the demonstration that a programmable quantum device can solve a problem beyond the practical reach of classical computers.`;
const up = await fetch(base + '/api/materials', {
  method: 'POST',
  headers: { 'x-filename': encodeURIComponent('quantum_computing_notes.txt'), 'x-title': encodeURIComponent('Quantum Computing Basics'), 'content-type': 'text/plain' },
  body: Buffer.from(txt, 'utf8'),
});
const upBody = await up.json();
check('POST /api/materials (upload + analyse)', up.status === 201 && upBody.ok,
  `id=${upBody.data?.material?.id}`);
const newId = upBody.data.material.id;
check('summary generated & persisted', (upBody.data.summary?.summary_text || '').length > 80,
  `${upBody.data.summary.summary_text.length} chars`);
const pointsArr = JSON.parse(upBody.data.summary.important_points || '[]');
check('important points generated', pointsArr.length > 0, `${pointsArr.length} points`);
check('flashcards generated', upBody.data.flashcards.length > 0, `${upBody.data.flashcards.length} cards`);
check('topics extracted', upBody.data.topics.length > 0,
  upBody.data.topics.map(t => t.name).slice(0, 4).join(', '));
check('quiz questions generated', upBody.data.quiz.questions.length > 0,
  `${upBody.data.quiz.questions.length} MCQs`);

/* 4. read back ------------------------------------------------------------- */
const detail = await j(`/api/materials/${newId}`);
check('GET /api/materials/:id (DB read-back)', detail.body.data.material.title === 'Quantum Computing Basics');
check('read-back returns same flashcard count',
  detail.body.data.flashcards.length === upBody.data.flashcards.length);

/* 5. DOCX round-trip (real OOXML zip built in-process) -------------------- */
const { buildTestDocx } = await import('./make-docx.js');
const docxBuf = buildTestDocx(
  'Organic Chemistry — Alkanes and Alkenes',
  [`Alkanes are saturated hydrocarbons in which every carbon atom is bonded to the maximum possible number of hydrogen atoms through single covalent bonds.
Alkenes are unsaturated hydrocarbons that contain at least one carbon to carbon double bond, which makes them more reactive than alkanes.
The general formula of a straight chain alkane is CnH2n+2, whereas the general formula of an alkene is CnH2n.
Addition reaction is a reaction in which two reactant molecules combine to form a single product molecule, and it is characteristic of alkenes.
Bromine water is used as a test for unsaturation because it is decolourised rapidly by alkenes but remains orange in the presence of alkanes.
A homologous series is a family of organic compounds with the same functional group and similar chemical properties that differ by one CH2 unit.
Isomers are compounds that have the same molecular formula but different structural arrangements of atoms, which gives them different physical properties.
Cracking is the process of breaking large alkane molecules into smaller, more useful alkenes and alkanes using heat and a catalyst.`]
);
const docxUp = await fetch(base + '/api/materials', {
  method: 'POST',
  headers: { 'x-filename': encodeURIComponent('organic_chemistry.docx'), 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  body: docxBuf,
});
const docxBody = await docxUp.json();
check('POST /api/materials (.docx parsed & analysed)', docxUp.status === 201 && docxBody.ok,
  docxBody.ok ? `${docxBody.data.material.word_count} words extracted` : docxBody.error);
check('docx flashcards generated', (docxBody.data?.flashcards?.length ?? 0) > 0,
  `${docxBody.data?.flashcards?.length ?? 0} cards`);
check('docx quiz generated', (docxBody.data?.quiz?.questions?.length ?? 0) > 0,
  `${docxBody.data?.quiz?.questions?.length ?? 0} MCQs`);

/* 6. flashcard review writes to DB --------------------------------------- */
const cardId = upBody.data.flashcards[0].id;
const rv = await j(`/api/flashcards/${cardId}/review`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ correct: true }),
});
check('POST /api/flashcards/:id/review', rv.body.data.times_reviewed === 1 && rv.body.data.times_correct === 1,
  `reviewed=${rv.body.data.times_reviewed}`);

/* 7. quiz submission ----------------------------------------------------- */
const quiz = upBody.data.quiz;
const answers = quiz.questions.map((q, i) => (i < 3 ? q.correct_index : (q.correct_index + 1) % 4));
const sub = await j(`/api/quizzes/${quiz.quiz.id}/submit`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }),
});
check('POST /api/quizzes/:id/submit', sub.status === 201 && sub.body.data.attempt.score >= 3,
  `score ${sub.body.data.attempt.score}/${sub.body.data.attempt.total} (${sub.body.data.attempt.percentage}%)`);
check('attempt persisted + weak topics computed',
  Array.isArray(sub.body.data.attempt.weak_topics) && sub.body.data.topicPerformance.length > 0,
  `weak=[${sub.body.data.attempt.weak_topics.join(', ')}]`);

/* 8. performance + revision plan ----------------------------------------- */
const attempts = await j('/api/attempts');
check('GET /api/attempts', attempts.body.data.length >= 1, `${attempts.body.data.length} attempt(s)`);
dash = await j('/api/dashboard');
check('dashboard stats reflect new material', dash.body.data.stats.materials >= 3,
  `materials=${dash.body.data.stats.materials}, avg=${dash.body.data.stats.avgScore}%`);
const plan = await j('/api/revision-plan');
check('GET /api/revision-plan', plan.body.data.plan.length >= 1,
  `${plan.body.data.focusCount} focus topic(s)`);

/* 9. sample ingest ------------------------------------------------------- */
const smp = await j('/api/materials/sample', { method: 'POST' });
check('POST /api/materials/sample', smp.status === 201 && smp.body.data.flashcards.length > 0,
  `${smp.body.data.flashcards.length} cards`);

/* 10. reanalyse + delete -------------------------------------------------- */
const ra = await j(`/api/materials/${newId}/reanalyse`, { method: 'POST' });
check('POST /api/materials/:id/reanalyse', ra.body.ok);
const del = await j(`/api/materials/${newId}`, { method: 'DELETE' });
check('DELETE /api/materials/:id', del.body.data.deleted === newId);
const after = await j('/api/materials');
check('deleted material gone from DB', !after.body.data.some(m => m.id === newId));

/* 11. error handling ----------------------------------------------------- */
const bad = await j('/api/materials', {
  method: 'POST', headers: { 'x-filename': encodeURIComponent('notes.xyz'), 'content-type': 'text/plain' },
  body: Buffer.from('nope'),
});
check('unsupported extension rejected', bad.status === 400 && /Unsupported/.test(bad.body.error));
const tiny = await j('/api/materials', {
  method: 'POST', headers: { 'x-filename': encodeURIComponent('tiny.txt'), 'content-type': 'text/plain' },
  body: Buffer.from('too short'),
});
check('too-short document rejected', tiny.status === 400);
const nf = await j('/api/materials/99999');
check('missing material -> 404', nf.status === 404);
const nf2 = await j('/api/nope');
check('unknown route -> 404', nf2.status === 404);

/* 12. frontend served ----------------------------------------------------- */
const page = await fetch(base + '/');
const html = await page.text();
check('GET / serves the SPA', page.status === 200 && html.includes('Pocket Mentor'));
const js = await fetch(base + '/app.js');
check('GET /app.js served', js.status === 200 && (await js.text()).includes('api/dashboard'));

console.log('─'.repeat(46));
console.log(`  ${pass} passed, ${fail} failed\n`);

server.close();
if (db && typeof db.close === 'function') {
  try { db.close(); } catch {}
}
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) {
  if (fs.existsSync(f)) {
    try { fs.unlinkSync(f); } catch {}
  }
}
process.exit(fail ? 1 : 0);
