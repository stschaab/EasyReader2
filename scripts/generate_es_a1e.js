// generate_es_a1e.js
// Erzeugt "A1e" — den A1-Text mit englischen Inline-Glossen für alle
// Lemmata mit Rang > 2000. Strategie:
//   1. Deterministisch: lemmatisiere A1-Text, identifiziere >2000-Lemmata.
//      (gleiche Methodik wie die KPI-Skripte)
//   2. GLM übersetzt diese Lemmata (gebatcht, persistent gecacht in
//      es_gloss_cache.json, damit teure Wörter nur einmal übersetzt werden).
//   3. Python (spaCy) setzt die (english)-Glossen an exakten Wortpositionen ein.
//
// So ist garantiert, dass GENAU die >2000-Wörter geglossed werden — nicht mehr,
// nicht weniger. GLM entscheidet nur über die Übersetzung, nicht über die Auswahl.
//
// Aufruf:
//   node scripts/generate_es_a1e.js [LIMIT]   LIMIT = Anzahl Chunks (Default: 50)
//   node scripts/generate_es_a1e.js all       alle Chunks

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const GLM_KEY = process.env.GLM_API_KEY || "1db0c25e87d244948c7e38869b9024a9.uBKxTepsiqkRgLQ3";
const MODEL = "glm-4.6";
const RANK_LIMIT = 2000;
const GLOSS_BATCH_SIZE = 60;   // Lemmata pro GLM-Aufruf
const OUT = path.join(__dirname, "..", "book-2.json");
const CACHE = path.join(__dirname, "es_gloss_cache.json");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Frequenzliste ---
const es = JSON.parse(fs.readFileSync(path.join(__dirname, "freqlists", "es_lemmas.json"), "utf8"));
const rankOf = {};
for (const w of es) rankOf[w.lemma] = w.rank;

// --- Lemmatisierung (Batch, wie in KPI-Skripten) ---
function lemmatizeBatch(texts) {
  return JSON.parse(execFileSync(
    "py", ["-3.13", path.join(__dirname, "lemmatize_es_batch.py")],
    { input: JSON.stringify(texts), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  ).trim());
}

// --- Glossierung (Batch, spaCy kennt exakte Token-Offsets) ---
function glossBatch(texts, glosses) {
  return JSON.parse(execFileSync(
    "py", ["-3.13", path.join(__dirname, "gloss_es_batch.py")],
    { input: JSON.stringify({ texts, glosses }), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  ).trim());
}

// --- GLM: übersetzt eine Liste spanischer Lemmata ins Englische ---
async function translateLemmas(lemmas) {
  if (lemmas.length === 0) return {};
  const prompt = {
    system:
      "You are a bilingual Spanish/English dictionary. " +
      "Given a list of Spanish word lemmas, return a JSON object mapping each lemma " +
      "to its most common English translation (single word or short phrase, max 3 words). " +
      "Choose the everyday meaning; ignore rare senses. Return ONLY the JSON object, " +
      "no explanation.",
    user:
      "Translate these Spanish lemmas to English. Return a JSON object {lemma: english}.\n\n" +
      lemmas.map((l, i) => `${i + 1}. ${l}`).join("\n"),
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      const res = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": GLM_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 3000,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const errText = await res.text();
        if (/rate|429|1302/i.test(errText) || res.status === 429) {
          console.log("    Rate-Limit, warte 15s...");
          await sleep(15000);
          continue;
        }
        throw new Error("HTTP " + res.status + ": " + errText.substring(0, 80));
      }
      const data = await res.json();
      const content = (data.content || [])
        .filter(p => p.type === "text")
        .map(p => p.text)
        .join("")
        .trim();
      // JSON aus der Antwort extrahieren (GLM packt manchmal Prosa drumherum)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("kein JSON in Antwort: " + content.substring(0, 80));
      const parsed = JSON.parse(jsonMatch[0]);
      // Normalisieren: Keys lower-case, Werte trimmen, leere Werte verwerfen
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        const val = String(v).trim().toLowerCase();
        if (val && /^[a-z\s'-]+$/.test(val)) out[k.toLowerCase()] = val;
      }
      return out;
    } catch (e) {
      if (attempt < 3) {
        console.log("    ↻ Übersetzung " + (attempt + 1) + "/4: " + e.message.substring(0, 50));
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Übersetzung fehlgeschlagen nach 4 Versuchen");
}

async function main() {
  let limit;
  if (process.argv[2] === "all") limit = 99999;
  else limit = parseInt(process.argv[2] || "50");

  const book2 = JSON.parse(fs.readFileSync(OUT, "utf8"));
  for (const c of book2.chunks) if (c.A1e === undefined) c.A1e = "";

  // „A1e" in levels aufnehmen (direkt nach A1)
  if (!book2.book.levels.includes("A1e")) {
    const a1idx = book2.book.levels.indexOf("A1");
    if (a1idx >= 0) book2.book.levels.splice(a1idx + 1, 0, "A1e");
    else book2.book.levels.push("A1e");
  }

  // Glossen-Cache laden
  let glosses = {};
  try { glosses = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (e) { /* neu anlegen */ }
  const cacheStartCount = Object.keys(glosses).length;

  // Sicherheitsfilter: Cache-Einträge entfernen, deren Lemma laut aktueller
  // Frequenzliste Rang ≤ RANK_LIMIT hat (z.B. weil die Liste zwischenzeitlich
  // andere Lemmatisierungsregeln hatte). Verhindert, dass hochfrequente Wörter
  // wie "él" (Rang 5) fälschlich geglossed werden.
  let purged = 0;
  for (const lemma of Object.keys(glosses)) {
    const r = rankOf[lemma];
    if (r != null && r <= RANK_LIMIT) { delete glosses[lemma]; purged++; }
  }
  if (purged > 0) console.log("Cache bereinigt: " + purged + " Einträge mit Rang ≤ " + RANK_LIMIT + " entfernt.");

  limit = Math.min(limit, book2.chunks.length);
  const targets = book2.chunks.slice(0, limit);
  const alreadyA1e = targets.filter(c => c.A1e).length;

  console.log("A1e-Generierung: Zalacaín el Aventurero");
  console.log("Modell: " + MODEL + " · Glossen für Lemmata > Rang " + RANK_LIMIT);
  console.log("Chunks: " + limit + "/" + book2.chunks.length + " · bereits mit A1e: " + alreadyA1e);
  console.log("Glossen-Cache: " + cacheStartCount + " vorhandene Übersetzungen");
  console.log("Start: " + new Date().toLocaleTimeString() + "\n");

  // Schritt 1: alle Ziel-Chunks lemmatisieren, >2000-Lemmata sammeln
  console.log("Schritt 1/3: Lemmatisierung der A1-Texte...");
  const a1Texts = targets.map(c => c.A1 || "");
  const toksAll = lemmatizeBatch(a1Texts);
  const missingForChunk = [];   // pro Chunk: Set der noch nicht gecachten >2000-Lemmata
  for (let i = 0; i < targets.length; i++) {
    const missing = new Set();
    for (const t of toksAll[i]) {
      if (t.is_name) continue;
      const r = rankOf[t.lemma];
      if (r == null) continue;
      if (r > RANK_LIMIT && !glosses[t.lemma]) missing.add(t.lemma);
    }
    missingForChunk.push(missing);
  }

  // Schritt 2: alle fehlenden Lemmata in Batches übersetzen
  const allMissing = [...new Set(missingForChunk.flatMap(s => [...s]))];
  console.log("Schritt 2/3: " + allMissing.length + " neue Lemmata übersetzen (Batch à " + GLOSS_BATCH_SIZE + ")...");
  for (let i = 0; i < allMissing.length; i += GLOSS_BATCH_SIZE) {
    const batch = allMissing.slice(i, i + GLOSS_BATCH_SIZE);
    const translated = await translateLemmas(batch);
    for (const [lemma, en] of Object.entries(translated)) glosses[lemma] = en;
    // Lemmata ohne Rückgabe aus GLM markieren mit "", damit sie nicht immer wieder angefragt werden
    for (const lemma of batch) if (!(lemma in glosses)) glosses[lemma] = "";
    const done = Math.min(i + GLOSS_BATCH_SIZE, allMissing.length);
    console.log("  " + done + "/" + allMissing.length + " übersetzt, Cache: " + Object.keys(glosses).length);
    fs.writeFileSync(CACHE, JSON.stringify(glosses, null, 2), "utf8");
    if (done < allMissing.length) await sleep(1200);
  }
  // Cache speichern
  fs.writeFileSync(CACHE, JSON.stringify(glosses, null, 2), "utf8");
  console.log("  Cache gespeichert: " + CACHE + " (" + Object.keys(glosses).length + " Einträge)\n");

  // Schritt 3: Glossen in A1-Texte einsetzen (Batch über alle Chunks)
  console.log("Schritt 3/3: Glossen in Texte einsetzen...");
  // Nur mit nicht-leeren Glossen glossieren; leere Cache-Einträge weglassen
  const activeGlosses = {};
  for (const [k, v] of Object.entries(glosses)) if (v) activeGlosses[k] = v;
  const glossed = glossBatch(a1Texts, activeGlosses);

  // Statistik pro Chunk + speichern
  let totalGlosses = 0;
  for (let i = 0; i < targets.length; i++) {
    targets[i].A1e = glossed[i];
    // Anzahl Glossen in diesem Text
    const g = (glossed[i].match(/ \([^)]+\)/g) || []).length;
    totalGlosses += g;
  }

  fs.writeFileSync(OUT, JSON.stringify(book2, null, 2), "utf8");
  const avgGlossesPerChunk = (totalGlosses / targets.length).toFixed(1);
  console.log("\n✓ " + targets.length + " Chunks mit A1e versehen");
  console.log("  Ø " + avgGlossesPerChunk + " Glossen/Chunk (" + totalGlosses + " gesamt)");
  console.log("  " + (Object.keys(glosses).length - cacheStartCount) + " neue Übersetzungen");
  console.log("Ende: " + new Date().toLocaleTimeString());
  console.log("Gespeichert: " + OUT + " (" + Math.round(fs.statSync(OUT).size / 1024) + " KB)");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
