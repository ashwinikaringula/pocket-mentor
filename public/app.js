/* ─────────────────────────────────────────────────────────────
   Pocket Mentor — frontend application (vanilla JS, no deps)
   Talks to the REST API at /api/* which persists to SQLite.
   ───────────────────────────────────────────────────────────── */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  view: 'dashboard',
  dashboard: null,
  materials: [],
  current: null,          // full material payload
  selectedFile: null,
  quizAnswers: [],
  submitted: false,
  fcIndex: 0,
  fcDeck: [],
  plan: null,
};

/* ───────── api ───────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && typeof opts.body === 'string'
      ? { 'content-type': 'application/json', ...(opts.headers || {}) }
      : opts.headers || {},
    ...opts,
  });
  const json = await res.json().catch(() => ({ ok: false, error: 'Malformed response' }));
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3800);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString() : '—');
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

/* ───────── router ───────── */
function go(view, payload) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'dashboard') renderDashboard();
  if (view === 'library') renderLibrary();
  if (view === 'flashcards') loadFlashcardView(payload);
  if (view === 'quiz') loadQuizView(payload);
  if (view === 'performance') renderPerformance();
  if (view === 'revision') renderPlan();
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-goto]');
  if (el) go(el.dataset.goto);
});

/* ───────── DASHBOARD ───────── */
async function renderDashboard() {
  try {
    const d = await api('/api/dashboard');
    state.dashboard = d;
    state.materials = d.materials;

    const s = d.stats;
    $('#statGrid').innerHTML = [
      ['Materials', s.materials], ['Flashcards', s.flashcards], ['Quizzes', s.quizzes],
      ['Attempts', s.attempts], ['Avg Score', pct(s.avgScore)], ['Best Score', pct(s.bestScore)],
      ['Cards Reviewed', s.reviewedCards], ['Weak Topics', s.weakTopicCount],
    ].map(([lab, val]) => `<div class="stat"><div class="stat-val">${val}</div><div class="stat-lab">${lab}</div></div>`).join('');

    $('#recentMaterials').innerHTML = d.materials.length
      ? d.materials.slice(0, 5).map(m => `
        <div class="row" data-open="${m.id}">
          <div class="row-main">
            <div class="row-title">${esc(m.title)}</div>
            <div class="row-sub">${esc(m.filename)} · ${m.word_count} words · ${fmtDate(m.created_at)}</div>
          </div>
          <div class="chiprow">
            <span class="row-badge">${m.card_count} cards</span>
            <span class="row-badge">${m.question_count} Qs</span>
          </div>
        </div>`).join('')
      : `<div class="empty"><div class="big">📚</div>No materials yet — upload your first document.</div>`;

    const topics = d.weakTopics;
    $('#dashTopics').innerHTML = topics.length
      ? topics.map(t => `
        <div class="topic-row">
          <div class="topic-line"><span class="topic-name">${esc(t.topic)}</span>
            <span class="muted small">${pct(t.accuracy)} · ${t.attempts} answered</span></div>
          <div class="track"><div class="${t.status === 'strong' ? 'ok' : t.status === 'review' ? 'warn' : 'bad'}" style="width:${t.accuracy}%"></div></div>
        </div>`).join('')
      : `<div class="empty">No quiz attempts yet. Take a quiz to build your topic profile.</div>`;

    $('#dashAttempts').innerHTML = d.attempts.length
      ? `<table><thead><tr><th>Material</th><th>Score</th><th>Topics to review</th><th>When</th></tr></thead><tbody>
          ${d.attempts.map(a => `<tr>
            <td>${esc(a.material_title)}</td>
            <td class="num">${a.score}/${a.total} · ${pct(a.percentage)}</td>
            <td>${JSON.parse(a.weak_topics || '[]').map(w => `<span class="chip p">${esc(w)}</span>`).join(' ') || '<span class="chip g">all strong</span>'}</td>
            <td class="muted small">${fmtDate(a.created_at)}</td></tr>`).join('')}
        </tbody></table>`
      : `<div class="empty">No attempts recorded.</div>`;

    $$('[data-open]').forEach(r => r.addEventListener('click', () => openMaterial(r.dataset.open)));
  } catch (e) { toast(e.message, true); }
}

/* ───────── LIBRARY ───────── */
async function renderLibrary() {
  try {
    const list = await api('/api/materials');
    state.materials = list;
    $('#libraryList').innerHTML = list.length
      ? list.map(m => `
        <div class="mcard" data-open="${m.id}">
          <div class="mcard-top">
            <div class="mcard-title">${esc(m.title)}</div>
            <span class="row-badge ${m.status === 'ready' ? 'score' : 'warn'}">${esc(m.status)}</span>
          </div>
          <div class="mcard-meta">${esc(m.filename)} · ${(m.size_bytes / 1024).toFixed(1)} KB · ${m.word_count} words</div>
          <div class="chiprow">
            <span class="chip g">${m.card_count} flashcards</span>
            <span class="chip p">${m.question_count} quiz questions</span>
            ${m.best_score != null ? `<span class="chip">best ${pct(m.best_score)}</span>` : ''}
          </div>
          <div class="mcard-meta">Uploaded ${fmtDate(m.created_at)} · engine ${esc(m.engine || 'local-engine')}</div>
        </div>`).join('')
      : `<div class="empty"><div class="big">📄</div>Nothing uploaded yet.</div>`;
    $$('#libraryList [data-open]').forEach(c => c.addEventListener('click', () => openMaterial(c.dataset.open)));
  } catch (e) { toast(e.message, true); }
}

/* ───────── MATERIAL DETAIL ───────── */
async function openMaterial(id) {
  try {
    const d = await api(`/api/materials/${id}`);
    state.current = d;
    go('material');
    const m = d.material;
    const s = d.summary;
    $('#matTitle').textContent = m.title;
    $('#matMeta').textContent =
      `${m.filename} · ${m.word_count} words · ${m.source_kind.toUpperCase()} · ${fmtDate(m.created_at)} · engine: ${m.engine}`;

    $('#tab-summary').innerHTML = `
      <div class="panel-head"><h2>AI Summary</h2>
        <span class="muted small">${s?.read_minutes ?? 1} min read · condensed from ${m.word_count} words</span></div>
      <p class="summary-text">${esc(s?.summary_text || 'No summary generated.')}</p>`;

    const pts = s?.important_points || [];
    $('#tab-points').innerHTML = `
      <div class="panel-head"><h2>Important Points</h2><span class="muted small">${pts.length} key takeaways</span></div>
      ${pts.map((p, i) => `<div class="point"><div class="point-n">${i + 1}</div><div>${esc(p)}</div></div>`).join('') || '<div class="empty">No points extracted.</div>'}`;

    const maxW = Math.max(1, ...d.topics.map(t => t.weight));
    $('#tab-topics').innerHTML = `
      <div class="panel-head"><h2>Extracted Topics</h2><span class="muted small">weighted by frequency &amp; spread</span></div>
      <div class="topic-list">${d.topics.map(t => `
        <div class="topic-row">
          <div class="topic-line"><span class="topic-name">${esc(t.name)}</span>
            <span class="muted small">weight ${t.weight} · ${t.mentions} section(s)</span></div>
          <div class="track"><div style="width:${(t.weight / maxW) * 100}%"></div></div>
          ${t.evidence ? `<div class="evidence">“${esc(t.evidence)}”</div>` : ''}
        </div>`).join('') || '<div class="empty">No topics found.</div>'}</div>`;

    $('#tab-cards').innerHTML = `
      <div class="panel-head"><h2>Flashcards (${d.flashcards.length})</h2>
        <button class="link" data-goto="flashcards">Practise in study mode →</button></div>
      <div class="fc-wrap">${d.flashcards.map(c => fcHTML(c)).join('') || '<div class="empty">No flashcards.</div>'}</div>`;

    const q = d.quiz;
    $('#tab-quiz').innerHTML = q
      ? `<div class="panel-head"><h2>${esc(q.title)} — ${q.questions.length} questions</h2>
           <button class="link" data-goto="quiz">Open quiz →</button></div>
         <table><thead><tr><th>#</th><th>Topic</th><th>Question</th><th>Answer</th></tr></thead><tbody>
         ${q.questions.map((qq, i) => `<tr><td>${i + 1}</td><td><span class="chip p">${esc(qq.topic)}</span></td>
           <td>${esc(qq.question)}</td><td class="num">${esc(qq.options[qq.correct_index])}</td></tr>`).join('')}
         </tbody></table>`
      : `<div class="empty">No quiz generated.</div>`;

    $('#tab-text').innerHTML = `
      <div class="panel-head"><h2>Extracted Source Text</h2>
        <span class="muted small">${m.raw_text.length.toLocaleString()} characters stored in SQLite</span></div>
      <pre style="white-space:pre-wrap;font-size:13px;line-height:1.75;color:#c9d4ff;max-height:520px;overflow:auto">${esc(m.raw_text)}</pre>`;

    $$('[data-goto]',).forEach(() => {});
    wireFlipCards('#tab-cards', d.flashcards);
    $$('#matTabs .tab').forEach(t => t.onclick = () => {
      $$('#matTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
    });
    $('#matQuizBtn').onclick = () => { state.current = d; go('quiz'); };
    $('#reanalyseBtn').onclick = async () => {
      $('#reanalyseBtn').disabled = true;
      $('#reanalyseBtn').textContent = '↻ Analysing…';
      try { await api(`/api/materials/${id}/reanalyse`, { method: 'POST' }); toast('Re-analysed successfully'); openMaterial(id); }
      catch (e) { toast(e.message, true); }
      finally { $('#reanalyseBtn').disabled = false; $('#reanalyseBtn').textContent = '↻ Re-analyse'; }
    };
  } catch (e) { toast(e.message, true); }
}
window.openMaterial = openMaterial;

function fcHTML(c, i = 0) {
  return `<div class="fc" data-card="${c.id}">
    <div class="fc-inner">
      <div class="fc-face">
        <div><div class="fc-lab">Question · ${esc(c.topic || 'General')}</div>
             <div class="fc-q">${esc(c.question)}</div></div>
        <div class="fc-count">tap to reveal answer ↩</div>
      </div>
      <div class="fc-face fc-back">
        <div><div class="fc-lab">Answer</div><div class="fc-a">${esc(c.answer)}</div></div>
        <div class="fc-actions">
          <button class="good">✓ Got it</button><button class="bad">✗ Review</button>
        </div>
      </div>
    </div></div>`;
}

function wireFlipCards(scope, cards) {
  $$(`${scope} .fc`).forEach(el => {
    el.onclick = (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      el.classList.toggle('flipped');
    };
    const g = el.querySelector('.good'), b = el.querySelector('.bad');
    if (g) g.onclick = async (e) => { e.stopPropagation(); await review(el.dataset.card, true); el.style.opacity = .35; };
    if (b) b.onclick = async (e) => { e.stopPropagation(); await review(el.dataset.card, false); el.style.opacity = .35; };
  });
}
async function review(id, correct) {
  try {
    await api(`/api/flashcards/${id}/review`, { method: 'POST', body: JSON.stringify({ correct }) });
    toast(correct ? 'Marked as known ✓' : 'Queued for revision ↻');
  } catch (e) { toast(e.message, true); }
}

/* ───────── UPLOAD ───────── */
const dz = $('#dropzone'), fi = $('#fileInput');
dz.onclick = () => fi.click();
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault(); dz.classList.remove('over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fi.onchange = () => fi.files[0] && setFile(fi.files[0]);

function setFile(f) {
  const ext = '.' + f.name.split('.').pop().toLowerCase();
  if (!['.pdf', '.docx', '.txt', '.md'].includes(ext)) return toast('Unsupported file type ' + ext, true);
  state.selectedFile = f;
  dz.querySelector('.dz-title').innerHTML = `📎 <strong>${esc(f.name)}</strong> <span class="link">change</span>`;
  dz.querySelector('.dz-sub').textContent = `${(f.size / 1024).toFixed(1)} KB · ready to analyse`;
  $('#uploadBtn').disabled = false;
}

$('#uploadBtn').onclick = async () => {
  const f = state.selectedFile;
  if (!f) return;
  const btn = $('#uploadBtn');
  btn.disabled = true; btn.textContent = 'Analysing…';
  const pr = $('#progress'); pr.hidden = false;
  const steps = [
    ['Uploading document…', 18], ['Extracting text…', 36],
    ['AI content analysis…', 58], ['Generating summary…', 72],
    ['Building flashcards & quiz…', 88], ['Saving to database…', 96],
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (i < steps.length) { $('#progressFill').style.width = steps[i][1] + '%'; $('#progressText').textContent = steps[i][0]; i++; }
  }, 420);
  try {
    const headers = { 'x-filename': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream' };
    if ($('#titleInput').value.trim()) headers['x-title'] = encodeURIComponent($('#titleInput').value.trim());
    const body = await f.arrayBuffer();
    const d = await api('/api/materials', { method: 'POST', headers, body });
    clearInterval(timer);
    $('#progressFill').style.width = '100%';
    $('#progressText').textContent = 'Done — study resources generated.';
    toast('Material processed successfully 🎉');
    $('#uploadResult').innerHTML = `
      <div class="panel">
        <div class="panel-head"><h2>✓ Generated: ${esc(d.material.title)}</h2>
          <button class="btn primary" data-open-new="${d.material.id}">Open material →</button></div>
        <div class="stat-grid">
          <div class="stat"><div class="stat-val">${d.flashcards.length}</div><div class="stat-lab">Flashcards</div></div>
          <div class="stat"><div class="stat-val">${d.quiz?.questions.length ?? 0}</div><div class="stat-lab">Quiz Questions</div></div>
          <div class="stat"><div class="stat-val">${d.topics.length}</div><div class="stat-lab">Topics</div></div>
          <div class="stat"><div class="stat-val">${d.material.word_count}</div><div class="stat-lab">Words Analysed</div></div>
        </div>
        <p class="summary-text" style="margin-top:20px">${esc(d.summary?.summary_text || '')}</p>
      </div>`;
    document.querySelector('[data-open-new]').onclick = () => openMaterial(d.material.id);
    state.selectedFile = null; $('#titleInput').value = '';
    fi.value = ''; btn.textContent = 'Analyse & Generate';
    dz.querySelector('.dz-title').innerHTML = 'Drop your notes here or <span class="link">browse files</span>';
    dz.querySelector('.dz-sub').textContent = 'Max 10 MB · .pdf .docx .txt .md';
  } catch (e) {
    clearInterval(timer);
    pr.hidden = true; btn.disabled = false; btn.textContent = 'Analyse & Generate';
    toast(e.message, true);
    $('#uploadResult').innerHTML = `<div class="panel"><div class="empty"><div class="big">⚠️</div>${esc(e.message)}</div></div>`;
  }
};

$('#sampleBtn').onclick = async () => {
  $('#sampleBtn').disabled = true;
  try {
    const d = await api('/api/materials/sample', { method: 'POST' });
    toast('Sample material generated 🎉');
    openMaterial(d.material.id);
  } catch (e) { toast(e.message, true); }
  finally { $('#sampleBtn').disabled = false; }
};

/* ───────── FLASHCARDS STUDY MODE ───────── */
async function fillSelect(sel, list, preferred) {
  sel.innerHTML = list.map(m => `<option value="${m.id}">${esc(m.title)} (${m.card_count ?? ''}${m.card_count != null ? ' cards' : ''})</option>`).join('');
  if (preferred) sel.value = String(preferred);
}
async function loadFlashcardView(preferredId) {
  const list = await api('/api/materials');
  const sel = $('#fcMaterialSelect');
  if (!list.length) { $('#fcWrap').innerHTML = `<div class="empty"><div class="big">🃏</div>Upload material to generate flashcards.</div>`; sel.innerHTML = ''; return; }
  await fillSelect(sel, list, preferredId || (state.current?.material.id));
  sel.onchange = () => renderDeck(sel.value);
  renderDeck(sel.value);
}
async function renderDeck(id) {
  const d = await api(`/api/materials/${id}`);
  const cards = d.flashcards;
  $('#fcWrap').innerHTML = cards.length
    ? cards.map(c => fcHTML(c)).join('')
    : `<div class="empty">No flashcards for this material.</div>`;
  wireFlipCards('#fcWrap', cards);
}

/* ───────── QUIZ ───────── */
async function loadQuizView(preferredId) {
  const list = await api('/api/materials').then(l => l.filter(m => m.question_count > 0));
  const sel = $('#quizMaterialSelect');
  if (!list.length) { $('#quizBox').innerHTML = `<div class="empty"><div class="big">🎯</div>No quizzes available yet.</div>`; sel.innerHTML = ''; return; }
  await fillSelect(sel, list, preferredId || (state.current?.material.id));
  sel.onchange = () => { state.submitted = false; renderQuiz(sel.value); };
  state.submitted = false;
  renderQuiz(sel.value);
}
async function renderQuiz(id) {
  const d = await api(`/api/materials/${id}`);
  const q = d.quiz;
  if (!q) { $('#quizBox').innerHTML = `<div class="empty">No quiz for this material.</div>`; return; }
  state.current = d;
  state.quizAnswers = new Array(q.questions.length).fill(null);
  state.submitted = false;

  $('#quizBox').innerHTML = `
    <div class="panel-head">
      <h2>${esc(d.material.title)} — ${q.questions.length} questions</h2>
      <button class="btn primary" id="submitQuiz">Submit Answers</button>
    </div>
    ${q.questions.map((qq, i) => `
      <div class="q-card" data-q="${i}">
        <div class="q-num">Question ${i + 1} of ${q.questions.length} · <span class="chip p">${esc(qq.topic)}</span></div>
        <div class="q-text">${esc(qq.question)}</div>
        <div class="opts">${qq.options.map((o, oi) => `
          <div class="opt" data-q="${i}" data-o="${oi}">
            <div class="opt-key">${'ABCD'[oi]}</div><div>${esc(o)}</div></div>`).join('')}</div>
        <div class="explain" data-explain="${i}" hidden></div>
      </div>`).join('')}`;

  $$('#quizBox .opt').forEach(el => el.onclick = () => {
    if (state.submitted) return;
    const qi = +el.dataset.q;
    state.quizAnswers[qi] = +el.dataset.o;
    $$(`#quizBox .opt[data-q="${qi}"]`).forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
  });
  $('#submitQuiz').onclick = () => submitQuiz(q.id);
}
async function submitQuiz(quizId) {
  if (state.quizAnswers.some(a => a === null)) return toast('Answer every question first', true);
  try {
    const r = await api(`/api/quizzes/${quizId}/submit`, {
      method: 'POST', body: JSON.stringify({ answers: state.quizAnswers }),
    });
    state.submitted = true;
    $$('#quizBox .opt').forEach(el => {
      const qi = +el.dataset.q, oi = +el.dataset.o;
      el.classList.remove('sel');
      const det = r.detail[qi];
      el.disabled = true;
      if (oi === det.correct_index) el.classList.add('correct');
      else if (oi === state.quizAnswers[qi]) el.classList.add('wrong');
    });
    r.detail.forEach((det, i) => {
      const ex = $(`[data-explain="${i}"]`);
      ex.hidden = false;
      ex.textContent = det.is_correct ? `✓ Correct — ${r.detail[i].topic}` : `✗ Correct answer: ${det.options[det.correct_index]}`;
    });
    $('#submitQuiz').outerHTML = `<div class="btn-row"><button class="btn primary" id="retakeQuiz">↻ Retake</button>
      <button class="btn" data-goto="performance">View performance →</button>
      <button class="btn" data-goto="revision">Revision plan →</button></div>`;
    $('#retakeQuiz').onclick = () => renderQuiz(state.current.material.id);

    $('#quizBox').insertAdjacentHTML('afterbegin', `
      <div class="panel result-hero">
        <div class="score-ring" style="--pct:${r.attempt.percentage}%"><span>${r.attempt.percentage.toFixed(0)}%</span></div>
        <h2>${r.attempt.score} / ${r.attempt.total} correct</h2>
        <p class="muted" style="margin:10px auto 0">${esc(r.revisionPlanHint)}</p>
        <div class="chiprow" style="justify-content:center;margin-top:16px">
          ${r.attempt.strong_topics.map(t => `<span class="chip g">strong: ${esc(t)}</span>`).join('')}
          ${r.attempt.weak_topics.map(t => `<span class="chip p">needs work: ${esc(t)}</span>`).join('')}
        </div>
      </div>`);
    toast(`Saved to database — ${r.attempt.score}/${r.attempt.total} (${pct(r.attempt.percentage)})`);
  } catch (e) { toast(e.message, true); }
}

/* ───────── PERFORMANCE ───────── */
async function renderPerformance() {
  const [dash, attempts] = await Promise.all([api('/api/dashboard'), api('/api/attempts')]);
  const s = dash.stats;
  $('#perfStats').innerHTML = [
    ['Attempts', s.attempts], ['Average', pct(s.avgScore)], ['Best', pct(s.bestScore)],
    ['Cards Reviewed', s.reviewedCards], ['Weak Topics', s.weakTopicCount],
  ].map(([l, v]) => `<div class="stat"><div class="stat-val">${v}</div><div class="stat-lab">${l}</div></div>`).join('');

  $('#perfTopics').innerHTML = dash.weakTopics.length
    ? dash.weakTopics.map(t => `
      <div class="topic-row" style="margin-bottom:15px">
        <div class="topic-line"><span class="topic-name">${esc(t.topic)}</span>
          <span class="row-badge ${t.status === 'strong' ? 'score' : t.status === 'review' ? 'warn' : 'bad'}">${t.status} · ${pct(t.accuracy)}</span></div>
        <div class="track"><div class="${t.status === 'strong' ? 'ok' : t.status === 'review' ? 'warn' : 'bad'}" style="width:${t.accuracy}%"></div></div>
      </div>`).join('')
    : '<div class="empty">No topic data yet.</div>';

  $('#perfAttempts').innerHTML = attempts.length
    ? `<table><thead><tr><th>#</th><th>Material</th><th>Score</th><th>Date</th></tr></thead><tbody>
      ${attempts.map(a => `<tr><td>${a.id}</td><td>${esc(a.material_title)}</td>
        <td class="num">${a.score}/${a.total} · ${pct(a.percentage)}</td>
        <td class="muted small">${fmtDate(a.created_at)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No attempts yet.</div>';
}

/* ───────── REVISION PLAN ───────── */
async function renderPlan() {
  try {
    const p = await api('/api/revision-plan');
    state.plan = p;
    $('#planBox').innerHTML = p.plan.map(st => `
      <div class="plan-step">
        <div class="plan-head">
          <div><div class="plan-topic">${st.step ? `Step ${st.step}: ` : ''}${esc(st.topic)}</div></div>
          <span class="row-badge ${st.status === 'weak' ? 'bad' : st.status === 'review' ? 'warn' : 'score'}">${esc(st.status)} · ${pct(st.accuracy)}</span>
        </div>
        <div class="plan-reason">${esc(st.reason)}</div>
        ${st.suggestedCards.map(c => `<div class="mini-card">
            <strong>${esc(c.question)}</strong>${esc(c.answer)}
            <div class="muted small" style="margin-top:7px">from ${esc(c.material_title)}</div></div>`).join('')}
      </div>`).join('');
  } catch (e) { toast(e.message, true); }
}
$('#refreshPlan').onclick = renderPlan;

/* ───────── boot ───────── */
(async function boot() {
  try {
    const me = await api('/api/me');
    $('#engineLabel').textContent = me.engine;
    $('#welcome').textContent =
      `Welcome back, ${me.user.name}. Upload notes, let AI build your revision kit, then practise until every topic is strong.`;
  } catch {}
  const h = await api('/api/health').catch(() => null);
  if (h) $('#engineLabel').textContent = h.engine;
  // support deep links (?view=library) so any view can be shared/screenshotted
  const wanted = new URLSearchParams(location.search).get('view');
  go(wanted && document.getElementById('view-' + wanted) ? wanted : 'dashboard');
})();
