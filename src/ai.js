/**
 * Pocket Mentor - AI Content Analysis & Generation engine.
 *
 * Provider "local-engine" (default): a deterministic, on-device NLP pipeline.
 *   tokenise -> stopword filter -> TF scoring + bigrams -> topic extraction
 *   -> extractive summarisation -> important points -> definition-aware
 *   flashcards -> cloze + definition multiple-choice quizzes.
 *
 * Provider "openai"/"anthropic": the same JSON contract is produced by a real
 * LLM through callLLM(). The rest of the app is provider-agnostic.
 *
 * The public API is a single async function: analyseMaterial(text, title).
 */

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been
before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during
each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself
him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my
myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll
she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they
they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were
weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd
you'll you're you've your yours yourself yourselves also may many make makes made used using use one two three first
second third new like well often however therefore thus hence etc within without upon among across based given such
able various several different includes including include e.g i.e`.split(/\s+/).filter(Boolean));

const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n{2,}|\n(?=[-*•]\s)/;

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) || []);
}

export function splitSentences(text) {
  return text
    .replace(/\r/g, '')
    .split(SENT_SPLIT)
    .map((s) => s.replace(/^\s*[-*•\d.)\]]+\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 25 && /[a-zA-Z]/.test(s) && s.split(' ').length >= 4);
}

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Term-frequency keyword extraction with bigram n-grams. */
export function extractKeywords(text, limit = 18) {
  const words = tokenize(text);
  const freq = new Map();
  for (const w of words) {
    if (STOPWORDS.has(w) || w.length < 4) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  // bigrams
  const bigrams = new Map();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b) || a.length < 4 || b.length < 4) continue;
    const key = a + ' ' + b;
    bigrams.set(key, (bigrams.get(key) || 0) + 1);
  }
  const scored = [];
  for (const [t, c] of freq) if (c > 1) scored.push({ term: t, score: c });
  for (const [t, c] of bigrams) if (c > 1) scored.push({ term: t, score: c * 1.8 });
  scored.sort((x, y) => y.score - x.score || x.term.localeCompare(y.term));
  const out = [];
  const used = new Set();
  for (const s of scored) {
    const head = s.term.split(' ')[0];
    if (s.term.includes(' ') && used.has(s.term)) continue;
    if (!s.term.includes(' ') && used.has(head)) continue;
    out.push({ term: s.term, weight: s.score });
    s.term.split(' ').forEach((w) => used.add(w));
    if (out.length >= limit) break;
  }
  return out;
}

/** Group keywords into a small set of topics and weight them. */
export function extractTopics(text, keywords) {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 60);
  const topics = [];
  for (const kw of keywords) {
    if (topics.length >= 6) break;
    const term = kw.term;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const supporting = paras.filter((p) => re.test(p));
    if (!supporting.length) continue;
    const evidence = supporting[0]
      .split(/(?<=[.!?])\s+/)
      .find((s) => re.test(s)) || supporting[0];
    topics.push({
      name: titleCase(term),
      weight: Number((kw.weight * (1 + Math.min(supporting.length, 5) / 10)).toFixed(2)),
      mentions: supporting.length,
      evidence: evidence.slice(0, 320),
    });
  }
  return topics.slice(0, 6);
}

/** Extractive summariser: 3 ranked sentences, restored to reading order. */
export function generateSummary(text, keywords, sentences) {
  const kw = new Map(keywords.map((k) => [k.term, k.weight]));
  const scored = sentences.map((s, i) => {
    const low = s.toLowerCase();
    let score = 0;
    for (const [term, w] of kw) if (low.includes(term)) score += w;
    score += Math.max(0, 3 - i) * 0.35;                 // lead bias
    if (/^[A-Z][a-z]+ .{0,40}( is | are | refers to | means )/.test(s)) score += 1.2; // definitions
    if (s.length > 380) score -= 1.5;                   // penalise run-ons
    score /= Math.sqrt(s.split(' ').length);            // length normalisation
    return { i, s, score };
  });
  const picked = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(4, Math.max(3, Math.round(sentences.length * 0.2))))
    .sort((a, b) => a.i - b.i);
  const body = picked.map((p) => p.s.replace(/\s+/g, ' ').trim()).join(' ');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const readMin = Math.max(1, Math.round(wordCount / 200));
  return { text: body, sourceSentences: picked.length, readMinutes: readMin, wordCount };
}

/** Top-ranked standalone statements = "Important Points". */
export function generateImportantPoints(sentences, keywords, limit = 6) {
  const kw = keywords.map((k) => k.term);
  const scored = sentences.map((s, i) => {
    const low = s.toLowerCase();
    let hits = 0;
    for (const t of kw) if (low.includes(t)) hits++;
    let score = hits * 1.5 + Math.max(0, 2 - i) * 0.4;
    if (/\d/.test(s)) score += 0.5;                       // numbers = examinable facts
    if (s.length > 60 && s.length < 300) score += 0.6;
    return { i, s, score };
  });
  const seen = new Set();
  const out = [];
  for (const c of scored.sort((a, b) => b.score - a.score)) {
    const key = c.s.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Definition / cloze aware Q&A flashcard generation. */
export function generateFlashcards(sentences, keywords, topics, limit = 12) {
  const cards = [];
  const seen = new Set();
  const push = (question, answer, topic) => {
    const k = question.toLowerCase();
    if (seen.has(k) || answer.length < 3) return;
    seen.add(k);
    cards.push({ question, answer: answer.slice(0, 400), topic: topic || 'General' });
  };

  // 1) "X is / are / refers to / means Y" definitions
  for (const s of sentences) {
    const m = s.match(/^([A-Z][\w\s-]{2,60}?)\s+(?:is|are|refers to|means|can be defined as)\s+(.{10,300})$/);
    if (m) {
      const term = m[1].trim();
      const topic = topics.find((t) => new RegExp(t.name, 'i').test(term))?.name || term.split(' ')[0];
      push(`What is ${term}?`, m[2].trim(), topic);
    }
  }
  // 2) Cloze deletion on the highest-weight keywords
  for (const s of sentences) {
    if (cards.length >= limit) break;
    if (s.length < 60 || s.length > 320) continue;
    for (const k of keywords) {
      const re = new RegExp(`\\b${k.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!re.test(s)) continue;
      const question = s.replace(re, '________');
      const topic = topics.find((t) => t.name.toLowerCase() === k.term)?.name || titleCase(k.term);
      push(question, titleCase(k.term), topic);
      break;
    }
  }
  // 3) Fill-out if the source is short
  for (const s of sentences) {
    if (cards.length >= limit) break;
    const words = s.split(' ');
    if (words.length < 10 || words.length > 40) continue;
    push(`Complete the statement: ${words.slice(0, 6).join(' ')} ... ?`, s, 'General');
  }
  return cards.slice(0, limit);
}

/** Multiple-choice quiz: cloze stems with same-document distractors. */
export function generateQuiz(sentences, keywords, topics, limit = 8) {
  const vocab = [...new Set(keywords.map((k) => titleCase(k.term)))];
  const questions = [];
  const used = new Set();

  const candidates = sentences
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.length >= 60 && s.length <= 300)
    .sort((a, b) => a.i - b.i);

  for (const { s } of candidates) {
    if (questions.length >= limit) break;
    let target = null;
    for (const k of keywords) {
      const re = new RegExp(`\\b${k.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(s) && !used.has(k.term)) { target = k.term; break; }
    }
    if (!target) continue;
    used.add(target);

    const correct = titleCase(target);
    const pool = vocab.filter((v) => v !== correct);
    const distractors = [];
    while (distractors.length < 3 && pool.length) {
      const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      distractors.push(pick);
    }
    if (distractors.length < 3) break;

    const options = [correct, ...distractors].sort(() => Math.random() - 0.5);
    const stem = s.replace(
      new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
      '________'
    );
    const topicName =
      topics.find((t) => new RegExp(t.name, 'i').test(s))?.name || titleCase(target);
    questions.push({
      topic: topicName,
      question: `Fill in the blank: ${stem}`,
      options,
      correctIndex: options.indexOf(correct),
      answer: correct,
      explanation: `The source material states: "${s}"`,
    });
  }
  return questions;
}

/* ------------------------------------------------------------ LLM path ---- */

async function callLLM(text, title, cfg) {
  const prompt = `You are an academic study-assistant. Analyse the study material below and reply with
STRICT JSON only, matching this schema:
{"summary":string,"importantPoints":string[],"topics":[{"name":string,"weight":number,"mentions":number,"evidence":string}],
"flashcards":[{"question":string,"answer":string,"topic":string}],
"quiz":[{"topic":string,"question":string,"options":[string,string,string,string],"correctIndex":number,"answer":string,"explanation":string}]}
Material title: ${title}
--- MATERIAL START ---
${text.slice(0, 14000)}
--- MATERIAL END ---`;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM provider error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '{}';
  return JSON.parse(content);
}

/* -------------------------------------------------------------- facade ---- */

export async function analyseMaterial(text, title, cfg = { provider: 'local-engine' }) {
  const clean = (text || '').replace(/\u0000/g, '').trim();
  if (clean.length < 200) {
    throw new Error(
      'Extracted text is too short (<200 characters). The file may be scanned/image-only or empty.'
    );
  }

  let result;
  if (cfg.provider && cfg.provider !== 'local-engine' && cfg.apiKey) {
    const raw = await callLLM(clean, title, cfg);
    const sentences = splitSentences(clean);
    const keywords = extractKeywords(clean);
    const topics = (raw.topics || extractTopics(clean, keywords)).map((t) => ({
      name: t.name,
      weight: Number(t.weight) || 1,
      mentions: Number(t.mentions) || 1,
      evidence: t.evidence || '',
    }));
    result = {
      summary: String(raw.summary || ''),
      importantPoints: (raw.importantPoints || []).map(String),
      topics,
      flashcards: (raw.flashcards || []).map((f) => ({
        question: f.question,
        answer: f.answer,
        topic: f.topic || 'General',
      })),
      quiz: (raw.quiz || []).map((q) => ({
        topic: q.topic || 'General',
        question: q.question,
        options: q.options,
        correctIndex: q.correctIndex,
        answer: q.options?.[q.correctIndex] || q.answer,
        explanation: q.explanation || '',
      })),
      engine: 'llm:' + cfg.provider,
      sentences,
      keywords,
    };
  } else {
    const sentences = splitSentences(clean);
    const keywords = extractKeywords(clean);
    const topics = extractTopics(clean, keywords);
    const summary = generateSummary(clean, keywords, sentences);
    const importantPoints = generateImportantPoints(sentences, keywords);
    result = {
      summary: summary.text,
      summaryStats: { sourceSentences: summary.sourceSentences, readMinutes: summary.readMinutes, wordCount: summary.wordCount },
      importantPoints,
      topics,
      flashcards: generateFlashcards(sentences, keywords, topics),
      quiz: generateQuiz(sentences, keywords, topics),
      engine: 'local-engine',
      sentences,
      keywords,
    };
  }

  if (!result.flashcards?.length) result.flashcards = [];
  if (!result.quiz?.length) {
    result.quiz = generateQuiz(result.sentences || splitSentences(clean), result.keywords || extractKeywords(clean), result.topics, 6);
  }
  return result;
}
