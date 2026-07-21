// kpi_zalacain_levels.js
// Misst die 5 Kern-KPIs + Satzstatistik fuer mehrere Levels (Original, A1, A2)
// von Zalacain el Aventurero (book-2.json) und gibt eine Vergleichstabelle aus.
//
// Methodik (identisch mit kpi_a2_compare.js / kpi_book_es.js):
//   - Eigennamen (spaCy PROPN) und nicht-in-Frequenzliste-Wörter ignoriert.
//   - Frequenzliste = scripts/freqlists/es_lemmas.json (OpenSubtitles, spaCy-lemmatisiert).
//   - Wörter mit hohem Rang (z.B. Rang > 2000) bleiben DRIN (zeigen Level-Belastung).
//
// Aufruf:  node scripts/kpi_zalacain_levels.js [N]
//          N = Anzahl Chunks (Default: alle)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const b = require(path.join(__dirname, "..", "book-2.json"));
const N = process.argv[2] ? parseInt(process.argv[2]) : b.chunks.length;
// Spalten von schwer → einfach
const LEVELS = ["original", "A2", "A1"];

// Tausenderpunkte (deutsche Schreibweise) für große Anzahlen
const fmtThousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

// Median eines Zahlen-Arrays
function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- Frequenzliste laden ---
const es = JSON.parse(fs.readFileSync(path.join(__dirname, "freqlists", "es_lemmas.json"), "utf8"));
const ipmOf = {}, rankOf = {};
for (const w of es) { ipmOf[w.lemma] = w.ipm; rankOf[w.lemma] = w.rank; }
const byIpmDesc = [...es].sort((a, x) => x.ipm - a.ipm);
const ipmSortedDesc = byIpmDesc.map(w => w.ipm);
function rankFromIpm(ipm) {
  let lo = 0, hi = ipmSortedDesc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ipmSortedDesc[mid] >= ipm) lo = mid + 1; else hi = mid; }
  return lo || 1;
}

// --- Batch-Lemmatisierung (spaCy nur einmal pro Level laden) ---
function lemmatizeBatch(texts) {
  return JSON.parse(execFileSync(
    "py", ["-3.13", path.join(__dirname, "lemmatize_es_batch.py")],
    { input: JSON.stringify(texts), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  ).trim());
}

function analyzeOne(toks) {
  const entries = [];
  let nameCount = 0, total = 0, missing = 0;
  for (const t of toks) {
    total++;
    if (t.is_name) { nameCount++; continue; }
    const r = rankOf[t.lemma];
    if (r == null) { missing++; continue; }
    entries.push({ lemma: t.lemma, rank: r, ipm: ipmOf[t.lemma] });
  }
  return { entries, total, nameCount, missing };
}

function sentenceLengthsFromText(text) {
  const clean = text.replace(/\[[^\]]*\]|\(\d+\)/g, " ");
  const sentences = clean.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
  return sentences.map(s => (s.toLowerCase().match(/[a-záéíóúñü]+/gi) || []).length).filter(n => n > 0);
}

function kpiForChunk(analysis, text) {
  const e = analysis.entries;
  const n = e.length;
  if (n === 0) return null;
  const avgIpm = e.reduce((s, x) => s + x.ipm, 0) / n;
  const avgRank = e.reduce((s, x) => s + x.rank, 0) / n;
  const over = e.filter(x => x.rank > 2000).length;
  const sl = sentenceLengthsFromText(text);
  return {
    avgIpm: Math.round(avgIpm * 10) / 10,
    avgRank: Math.round(avgRank * 10) / 10,
    rankFromAvgIpm: rankFromIpm(avgIpm),
    pctOver: Math.round(over / n * 1000) / 10,
    unique: new Set(e.map(x => x.lemma)).size,
    sentAvg: sl.length ? Math.round(sl.reduce((a, x) => a + x, 0) / sl.length * 10) / 10 : 0,
    sentMax: sl.length ? Math.max(...sl) : 0,
    namePct: Math.round(analysis.nameCount / analysis.total * 1000) / 10,
    missingPct: Math.round(analysis.missing / analysis.total * 1000) / 10,
  };
}

function aggregate(kpis) {
  const m = (sel) => kpis.reduce((s, r) => s + sel(r), 0) / kpis.length;
  return {
    avgIpm: m(r => r.avgIpm),
    avgRank: m(r => r.avgRank),
    rankFromAvgIpm: m(r => r.rankFromAvgIpm),
    pctOver: m(r => r.pctOver),
    sentAvg: m(r => r.sentAvg),
    sentMax: m(r => r.sentMax),
    namePct: m(r => r.namePct),
    missingPct: m(r => r.missingPct),
    n: kpis.length,
  };
}

// --- Main ---
const chunks = b.chunks.slice(0, N);
console.error(`Vermesse ${chunks.length} Chunks × ${LEVELS.length} Levels...`);

const perLevel = {};
for (const lvl of LEVELS) {
  process.stderr.write(`  Lemmatisiere ${lvl}...`);
  const texts = chunks.map(c => c[lvl] || "");
  const toksAll = lemmatizeBatch(texts);
  const kpis = [];
  const globalLemmas = new Set();   // unique Lemmata über die ganze Version
  const globalRanks = [];           // Rang jedes Worts über die ganze Version
  let totalWords = 0;               // gezählte Wörter über die ganze Version
  for (let i = 0; i < chunks.length; i++) {
    const a = analyzeOne(toksAll[i]);
    for (const e of a.entries) { globalLemmas.add(e.lemma); globalRanks.push(e.rank); }
    totalWords += a.entries.length;
    const k = kpiForChunk(a, texts[i]);
    if (k) kpis.push(k);
  }
  perLevel[lvl] = aggregate(kpis);
  perLevel[lvl].totalWords = totalWords;
  perLevel[lvl].uniqueGlobal = globalLemmas.size;
  perLevel[lvl].density = totalWords > 0 ? globalLemmas.size / totalWords : 0;
  perLevel[lvl].medianRank = Math.round(median(globalRanks));
  process.stderr.write(` ${kpis.length} Chunks ausgewertet\n`);
}

// --- Ausgabe: Tabelle ---
const rows = [
  ["Ø ipm",                  r => r.avgIpm.toFixed(0)],
  ["Ø Rang",                 r => r.avgRank.toFixed(0)],
  ["Median Rang",            r => r.medianRank],
  ["Rang(Øipm)",             r => Math.round(r.rankFromAvgIpm)],
  ["% Wörter > Rang 2000",   r => r.pctOver.toFixed(1) + "%"],
  ["Wörter gesamt",          r => fmtThousands(r.totalWords)],
  ["unique Lemmata gesamt",  r => fmtThousands(r.uniqueGlobal)],
  ["Unique / Total",         r => (r.density * 100).toFixed(1) + "%"],
  ["Ø Wörter/Satz",          r => r.sentAvg.toFixed(1)],
  ["max Wörter/Satz",        r => r.sentMax.toFixed(1)],
  ["% Eigennamen",           r => r.namePct.toFixed(1) + "%"],
  ["% nicht in Frequenzl.",  r => r.missingPct.toFixed(1) + "%"],
];

const colW = [26, 12, 12, 12];
const header = ["KPI", ...LEVELS].map((h, i) => h.padEnd(colW[i])).join(" | ");
const sep = colW.map(w => "-".repeat(w)).join("-|-");
console.log(`\n${"=".repeat(header.length)}`);
console.log(`KPI-Vergleich · Zalacaín el Aventurero · ${chunks.length} Chunks`);
console.log(`(${perLevel[LEVELS[0]].n} ausgewertete Chunks · Frequenzliste: OpenSubtitles)`);
console.log(`${"=".repeat(header.length)}\n`);
console.log(header);
console.log(sep);
for (const [label, fmt] of rows) {
  const cells = [label.padEnd(colW[0]), ...LEVELS.map((lvl, i) => String(fmt(perLevel[lvl])).padStart(colW[i + 1]))];
  console.log(cells.join(" | "));
}
console.log(sep);
console.log("\n--- Zielwerte / Erfolgskriterien ---");
const a1 = perLevel.A1, a2 = perLevel.A2, orig = perLevel.original;
const chk = (cond, txt) => (cond ? "✓ JA" : "✗ NEIN") + "  " + txt;
console.log(chk(a1.sentAvg <= 8,  `A1 Ø Wörter/Satz ≤ 8?    `) + `→ ${a1.sentAvg.toFixed(1)}`);
console.log(chk(a2.sentAvg <= 10, `A2 Ø Wörter/Satz ≤ 10?   `) + `→ ${a2.sentAvg.toFixed(1)}`);
console.log(`Satzverkürzung A1 vs. Orig:  ${((orig.sentAvg - a1.sentAvg) / orig.sentAvg * 100).toFixed(0)}%  (${orig.sentAvg.toFixed(1)} → ${a1.sentAvg.toFixed(1)})`);
console.log(`Satzverkürzung A2 vs. Orig:  ${((orig.sentAvg - a2.sentAvg) / orig.sentAvg * 100).toFixed(0)}%  (${orig.sentAvg.toFixed(1)} → ${a2.sentAvg.toFixed(1)})`);
console.log(`\nBias-Hinweis: Frequenzliste = OpenSubtitles (gesprochene Sprache) →`);
console.log(`Literaturwörter werden systematisch zu selten eingestuft.`);

// Roh-Export für spätere Nutzung
const out = { book: "Zalacaín el Aventurero", chunksMeasured: chunks.length, levels: perLevel };
fs.writeFileSync(path.join(__dirname, "kpi_zalacain_result.json"), JSON.stringify(out, null, 2));
console.log(`\nRohdaten: scripts/kpi_zalacain_result.json`);
