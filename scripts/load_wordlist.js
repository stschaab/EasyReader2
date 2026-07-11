// load_wordlist.js (v2 – Bulk Multi-Row)
// Lädt Hingston-Wortliste (10000 Wörter) in D1 words-Tabelle.
// Strategie: Multi-Row-INSERT à 50 Wörter pro Statement = ~200 Calls.

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = "f056e85f7c4bb3879769d11d80c376d6";
const D1_UUID = "a9a23a10-3618-43da-a52a-9ab249e81db5";
const API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT_ID + "/d1/database/" + D1_UUID + "/query";
const LANG_ID = 1;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function rankToCefr(rank) {
  if (rank <= 780) return "A1";
  if (rank <= 1300) return "A2";
  if (rank <= 2300) return "B1";
  if (rank <= 10000) return "B2";
  return "C1";
}

function esc(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

async function d1(sql) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const j = await res.json();
      if (j.success) return j.result[0];
      throw new Error("SQL: " + JSON.stringify(j.errors));
    } catch (e) {
      if (String(e.message).startsWith("SQL:")) throw e;
      if (attempt < 7) { await sleep(2000); continue; }
      throw e;
    }
  }
}

async function main() {
  if (!TOKEN) { console.error("CLOUDFLARE_API_TOKEN nicht gesetzt"); process.exit(1); }

  // Wortliste laden (aus dem Projektverzeichnis)
  const raw = fs.readFileSync(path.join(__dirname, "10000-russian-words.txt"), "utf8");
  const words = raw.split(/\r?\n/).map((w) => w.trim()).filter((w) => w.length > 0);
  console.log("Wortliste: " + words.length + " Wörter");

  // Status
  const cnt = await d1("SELECT COUNT(*) c FROM words WHERE language_id = " + LANG_ID);
  console.log("Bereits in DB: " + cnt.results[0].c);
  if (cnt.results[0].c >= words.length) {
    console.log("✓ bereits vollständig");
    return;
  }

  // Multi-Row-INSERT: 50 Wörter pro Statement (4 Spalten × 50 = 200 Variablen, sicher)
  const BATCH = 50;
  let inserted = 0;
  let errors = 0;
  for (let i = 0; i < words.length; i += BATCH) {
    const batch = words.slice(i, i + BATCH);
    const values = batch.map((w, j) => {
      const rank = i + j + 1;
      return `(${LANG_ID}, ${esc(w)}, ${rank}, ${esc(rankToCefr(rank))})`;
    }).join(",");
    try {
      await d1(`INSERT OR IGNORE INTO words (language_id, lemma, rank, cefr_level) VALUES ${values}`);
      inserted += batch.length;
      if ((Math.floor(i / BATCH) + 1) % 20 === 0) {
        console.log("  " + inserted + "/" + words.length + " (" + Math.round(inserted / words.length * 100) + "%)");
      }
    } catch (e) {
      errors++;
      if (errors <= 3) console.log("  ✗ Batch ab " + (i + 1) + ": " + e.message.substring(0, 80));
    }
  }

  console.log("\n✓ " + inserted + " Wörter eingefügt (" + errors + " Fehler)");

  // Verteilung
  const stats = await d1(
    "SELECT cefr_level, COUNT(*) c FROM words WHERE language_id = " + LANG_ID +
    " GROUP BY cefr_level ORDER BY cefr_level"
  );
  console.log("\nVerteilung:");
  stats.results.forEach((r) => console.log("  " + r.cefr_level + ": " + r.c));
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
