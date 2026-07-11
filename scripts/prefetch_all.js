// prefetch_all.js
// Generiert ALLE Vereinfachungen (Chunks × Levels) über den Worker
// und trägt sie in data.js ein. Mit Rate-Limit-Schutz und Validierung.
//
// Nutzung: node scripts/prefetch_all.js
//
// Strategie:
//   - Nur fehlende Vereinfachungen generieren (vorhandene überspringen)
//   - Zwischen Anfragen 1.5s Pause (Rate-Limit-Schutz)
//   - Bei Rate-Limit-Fehler: länger warten, dann nochmal
//   - Jede Antwort validieren (nur kyrillisch, B2/B1/A2 kürzer als Original)
//   - Fortschritt in data.js zwischenspeichern (alle 5 Chunks)

const fs = require("fs");
const path = require("path");

const WORKER_URL = "https://bitter-bush-c665.st-schaab.workers.dev/";
const LEVELS = ["C1", "B2", "B1", "A2"];
const PAUSE_MS = 1500;          // Pause zwischen Anfragen
const RETRY_PAUSE_MS = 10000;   // Pause nach Rate-Limit-Fehler
const MAX_RETRIES = 5;          // max. Wiederholungen pro Anfrage
const SAVE_EVERY = 5;           // alle N Chunks speichern

const dataPath = path.join(__dirname, "..", "data.js");

function loadBook() {
  delete require.cache[require.resolve(dataPath)];
  return require(dataPath);
}

function saveBook(book) {
  const js =
    "// Auto-generiert von fetch_text.js + prefetch_all.js am " +
    new Date().toISOString().slice(0, 10) + "\n" +
    "// Quelle: " + book.meta.source + "\n" +
    "// Alle Vereinfachungen vorgefertigt (GLM-4.5-flash)\n\n" +
    "const BOOK = " + JSON.stringify(book, null, 2) + ";\n\n" +
    "if (typeof window !== \"undefined\") window.BOOK = BOOK;\n" +
    "if (typeof module !== \"undefined\" && module.exports) module.exports = BOOK;\n";
  fs.writeFileSync(dataPath, js, "utf-8");
}

function validate(level, text, original) {
  // Kyrillisch-Check (kein Latein/CJK)
  if (/[A-Za-z\u4e00-\u9fff]/.test(text)) {
    return "enthält lateinische/chinesische Zeichen";
  }
  // B2/B1/A2 sollten nicht DRAMATISCH länger sein als Original
  if (level !== "C1") {
    const origW = original.split(/\s+/).length;
    const newW = text.split(/\s+/).length;
    // Toleranz: bis zu 1.5x darf B1/A2 länger sein (kurze Sätze brauchen mehr Wörter)
    if (newW > origW * 1.5) {
      return level + " ist deutlich länger als Original (" + newW + " > " + origW + " Wörter)";
    }
  }
  return null; // kein Fehler
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callWorker(text, level) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ text, level }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.simplified.trim();
}

async function generateOne(original, level) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await callWorker(original, level);
      const err = validate(level, result, original);
      if (err) throw new Error("Validierung: " + err);
      return result;
    } catch (e) {
      const msg = e.message || "";
      // Rate-Limit → länger warten, nochmal
      if (msg.includes("Rate-Limit") || msg.includes("1302") || msg.includes("rate")) {
        console.log("    ⏳ Rate-Limit, warte " + (RETRY_PAUSE_MS / 1000) + "s...");
        await sleep(RETRY_PAUSE_MS);
        continue;
      }
      // Anderer Fehler → 2x probieren, dann aufgeben
      if (attempt < MAX_RETRIES - 1) {
        console.log("    ⚠️ " + msg + ", Versuch " + (attempt + 2) + "/" + MAX_RETRIES);
        await sleep(RETRY_PAUSE_MS);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Max retries erreicht");
}

async function main() {
  const book = loadBook();
  console.log("Buch: " + book.meta.title);
  console.log("Chunks gesamt: " + book.paragraphs.length);
  console.log("");

  // Zählen was fehlt
  let total = 0, missing = 0;
  for (const p of book.paragraphs) {
    for (const lvl of LEVELS) {
      total++;
      if (!p[lvl] || !p[lvl].trim()) missing++;
    }
  }
  console.log("Vereinfachungen: " + (total - missing) + " vorhanden, " + missing + " fehlen");
  console.log("Geschätzte Zeit: ~" + Math.round((missing * PAUSE_MS) / 60000) + " Min");
  console.log("");

  let done = 0;
  let sinceSave = 0;

  for (let i = 0; i < book.paragraphs.length; i++) {
    const p = book.paragraphs[i];

    for (const lvl of LEVELS) {
      if (p[lvl] && p[lvl].trim()) continue; // schon vorhanden

      process.stdout.write(
        "  Chunk " + p.id + " " + lvl + " ... "
      );

      try {
        const result = await generateOne(p.original, lvl);
        p[lvl] = result;
        done++;
        sinceSave++;
        console.log("✓ (" + result.split(/\s+/).length + " Wörter)");
      } catch (e) {
        console.log("✗ " + e.message);
        console.log("    Überspringe, fahre fort...");
      }

      await sleep(PAUSE_MS);
    }

    // Zwischenspeichern
    if (sinceSave >= SAVE_EVERY) {
      saveBook(book);
      console.log("  💾 Zwischengespeichert (" + done + " neue Vereinfachungen)");
      sinceSave = 0;
    }
  }

  // Endgültig speichern
  saveBook(book);
  console.log("");
  console.log("✓ Fertig! " + done + " Vereinfachungen generiert.");
  console.log("→ data.js aktualisiert");

  // Fehlende zählen
  const b2 = loadBook();
  let stillMissing = 0;
  for (const p of b2.paragraphs) {
    for (const lvl of LEVELS) {
      if (!p[lvl] || !p[lvl].trim()) stillMissing++;
    }
  }
  if (stillMissing > 0) {
    console.log("⚠️ Noch " + stillMissing + " fehlend – Skript nochmal ausführen.");
  } else {
    console.log("✅ Alle " + total + " Vereinfachungen vollständig!");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
