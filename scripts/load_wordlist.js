// load_wordlist.js
// Lädt die Hingston-Häufigkeitsliste in die D1 words-Tabelle.
// Rang → CEFR-Level:
//   ≤ 780   → A1
//   ≤ 1300  → A2
//   ≤ 2300  → B1
//   ≤ 10000 → B2
//   (Datei hat 10000, also reicht es bis B2; C1/C2 leer)
//
// Nutzung: node scripts/load_wordlist.js
//
// Batch-Insert à 10 Wörter (50 Variablen, unter SQLite-Limit).

const fs = require("fs");

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = "f056e85f7c4bb3879769d11d80c376d6";
const D1_UUID = "a9a23a10-3618-43da-a52a-9ab249e81db5";
const API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT_ID + "/d1/database/" + D1_UUID + "/query";
const LANG_ID = 1; // 'ru' wurde bei Migration angelegt

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function placeholders(n, cols) {
  return Array(n).fill("(" + Array(cols).fill("?").join(",") + ")").join(",");
}

function rankToCefr(rank) {
  if (rank <= 780) return "A1";
  if (rank <= 1300) return "A2";
  if (rank <= 2300) return "B1";
  if (rank <= 10000) return "B2";
  return "C1";
}

async function d1(sql, params) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(params ? { sql, params } : { sql }),
      });
      const j = await res.json();
      if (j.success) return j.result[0];
      throw new Error(JSON.stringify(j.errors));
    } catch (e) {
      attempt++;
      if (attempt % 5 === 0) console.log("  Retry " + attempt);
      await sleep(3000);
    }
  }
}

async function main() {
  if (!TOKEN) { console.error("CLOUDFLARE_API_TOKEN nicht gesetzt"); process.exit(1); }

  // Wortliste laden (CRLF-Strip)
  const raw = fs.readFileSync("/tmp/hingston/10000-russian-words.txt", "utf8");
  const words = raw.split(/\r?\n/).map((w) => w.trim()).filter((w) => w.length > 0);
  console.log("Wortliste geladen: " + words.length + " Wörter");

  // Status quo prüfen
  const cnt = await d1("SELECT COUNT(*) c FROM words WHERE language_id = ?", [LANG_ID]);
  console.log("Bereits in DB: " + cnt.results[0].c);
  if (cnt.results[0].c >= words.length) {
    console.log("✓ Wortliste bereits vollständig, skip.");
    return;
  }

  // Batch-Insert (à 10)
  const BATCH = 10;
  let inserted = 0;
  for (let i = 0; i < words.length; i += BATCH) {
    const batch = words.slice(i, i + BATCH);
    const rank = i + 1; // Rang des ersten Worts in diesem Batch
    const params = [];
    for (let j = 0; j < batch.length; j++) {
      params.push(LANG_ID, batch[j], rank + j, rankToCefr(rank + j));
    }
    const sql =
      "INSERT OR IGNORE INTO words (language_id, lemma, rank, cefr_level) VALUES " +
      placeholders(batch.length, 4);
    try {
      await d1(sql, params);
      inserted += batch.length;
      if ((Math.floor(i / BATCH) + 1) % 100 === 0) {
        console.log("  " + inserted + "/" + words.length + " Wörter...");
      }
    } catch (e) {
      console.log("  ✗ Batch ab " + rank + ": " + e.message.substring(0, 60));
    }
    await sleep(200);
  }

  console.log("✓ " + inserted + " Wörter eingefügt");

  // Statistik
  const stats = await d1(
    "SELECT cefr_level, COUNT(*) c FROM words WHERE language_id = ? GROUP BY cefr_level ORDER BY cefr_level",
    [LANG_ID]
  );
  console.log("\nVerteilung:");
  stats.results.forEach((r) => console.log("  " + r.cefr_level + ": " + r.c + " Wörter"));
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
