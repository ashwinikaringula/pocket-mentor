/**
 * Pure-Node document text extraction (no external npm dependencies).
 *
 *  - .txt / .md  -> utf8 decode
 *  - .docx       -> ZIP central-directory parse + inflate + OOXML strip
 *  - .pdf        -> best-effort FlateDecode stream scan for Tj / TJ text ops
 *
 * Everything runs inside the process, so the platform stays dependency-free.
 */
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ ZIP ---- */

function readZipEntries(buf) {
  let eocd = -1;
  // End Of Central Directory record: scan backwards (comment can be up to 64 KB)
  const lowest = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP/OOXML container');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('Unsupported ZIP compression method ' + entry.method);
}

/* ---------------------------------------------------------------- text ---- */

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Convert OOXML document.xml into readable plain text. */
function ooxmlToText(xml) {
  let s = xml;
  s = s.replace(/<w:tab\b[^>]*\/>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<\/w:tc>/g, '\t');
  s = s.replace(/<\/w:tr>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeXmlEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDocx(buf) {
  const entries = readZipEntries(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('word/document.xml not found inside .docx');
  return ooxmlToText(readZipEntry(buf, doc).toString('utf8'));
}

/* ----------------------------------------------------------------- PDF ---- */

/**
 * Best-effort PDF text extraction. Works for PDFs with uncompressed or
 * FlateDecode content streams and standard Tj/TJ text operators.
 * Scanned (image-only) PDFs return '' -> caller reports it needs OCR.
 */
export function extractPdf(buf) {
  const chunks = [];
  const marker = Buffer.from('stream');
  let idx = 0;
  while (true) {
    const at = buf.indexOf(marker, idx);
    if (at === -1) break;
    let s = at + marker.length;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const end = buf.indexOf(Buffer.from('endstream'), s);
    if (end === -1) break;
    const raw = buf.subarray(s, end);
    idx = end + 9;
    let txt = null;
    try {
      txt = zlib.inflateSync(raw).toString('latin1');
    } catch {
      const asStr = raw.toString('latin1');
      if (/[A-Za-z]{3}/.test(asStr) && /(?:Tj|TJ)/.test(asStr)) txt = asStr;
    }
    if (!txt) continue;
    if (!/(?:Tj|TJ|Td|TD)/.test(txt)) continue;
    chunks.push(txt);
  }

  const out = [];
  for (const c of chunks) {
    // (text) Tj
    const re = /\((?:\\.|[^\\()])*\)\s*Tj|\[((?:\((?:\\.|[^\\()])*\)|[^\]])*)\]\s*TJ/g;
    let m;
    while ((m = re.exec(c))) {
      const seg = m[0];
      const parts = seg.match(/\((?:\\.|[^\\()])*\)/g) || [];
      const joined = parts
        .map((p) => p.slice(1, -1))
        .join('')
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ');
      if (joined.trim()) out.push(joined);
      if (/Tj/.test(seg)) out.push('\n');
    }
    if (out.length) out.push('\n\n');
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------- facade ---- */

export function extractTextFromBuffer(buf, filename) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (ext === 'docx') return { text: extractDocx(buf), kind: 'docx' };
  if (ext === 'pdf') return { text: extractPdf(buf), kind: 'pdf' };
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    return { text: buf.toString('utf8'), kind: 'text' };
  }
  // Unknown: try utf8 if it looks like text, otherwise fail loudly.
  const asText = buf.toString('utf8');
  const printable = asText.replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, '');
  if (printable.length / Math.max(1, asText.length) > 0.85) {
    return { text: asText, kind: 'text' };
  }
  throw new Error(
    `Unsupported file type ".${ext || 'unknown'}". Supported: .txt, .md, .docx, .pdf`
  );
}
