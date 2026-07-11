// migrate_to_d1.js (v4 – einzelne Statements, abort bei SQL-Fehler)
// Strategie: ein Statement pro Call, aber Batch-VALUES (Multi-Row-INSERT).
// Bei SQL-Fehler: aussteigen (kein Retry). Bei Netzwerkfehler: retry.

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = "f056e85f7c4bb3879769d11d80c376d6";
const D1_UUID = "a9a23a10-3618-43da-a52a-9ab249e81db5";
const API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT_ID + "/d1/database/" + D1_UUID + "/query";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
      // SQL-Fehler (nicht Netzwerk) → nicht retry, aussteigen
      throw new Error("SQL: " + JSON.stringify(j.errors));
    } catch (e) {
      // Netzwerkfehler (ECONNRESET, fetch failed) → retry
      if (String(e.message).startsWith("SQL:")) throw e;
      if (attempt < 7) { await sleep(2000); continue; }
      throw e;
    }
  }
}

function esc(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

async function main() {
  if (!TOKEN) { console.error("CLOUDFLARE_API_TOKEN nicht gesetzt"); process.exit(1); }

  const dataPath = path.join(__dirname, "..", "data.js");
  delete require.cache[require.resolve(dataPath)];
  const book = require(dataPath);

  console.log("Migration: " + book.meta.title + " (" + book.paragraphs.length + " Chunks)");

  // 1. Sprache (OR IGNORE falls Duplikat)
  console.log("\n[1/3] Sprache...");
  await d1("INSERT OR IGNORE INTO languages (code, name, tts_lang, wiktionary_lang, level_system, word_regex) VALUES ('ru', 'Русский', 'ru-RU', 'ru', 'CEFR', '[А-Яа-яЁё]+')");
  console.log("  ✓");

  // 2. Buch
  console.log("[2/3] Buch...");
  await d1(`INSERT OR IGNORE INTO books (language_id, title, author, source_url, edition) VALUES (1, ${esc(book.meta.title)}, ${esc(book.meta.author)}, ${esc(book.meta.source)}, ${esc(book.meta.edition)})`);
  console.log("  ✓");

  // Kapitel
  await d1("INSERT OR IGNORE INTO chapters (book_id, volume, part, chapter_num) VALUES (1, 1, 1, 1)");
  await d1("INSERT OR IGNORE INTO chapters (book_id, volume, part, chapter_num) VALUES (1, 1, 1, 2)");
  console.log("  ✓ Kapitel 1+2");

  // Chunks (Multi-Row, 25 pro Statement)
  console.log("\n[3/3] Chunks...");
  const CHUNKS_PER = 25;
  for (let i = 0; i < book.paragraphs.length; i += CHUNKS_PER) {
    const batch = book.paragraphs.slice(i, i + CHUNKS_PER);
    const values = batch.map((p) => {
      const ch = p.chapter === 2 ? 2 : 1;
      const wc = p.original.split(/\s+/).length;
      return `(1, ${ch}, ${p.id}, ${esc(p.original)}, ${wc})`;
    }).join(",");
    await d1(`INSERT INTO chunks (book_id, chapter_id, order_index, original_text, word_count) VALUES ${values}`);
    console.log("  +" + batch.length + " (gesamt " + (i + batch.length) + ")");
  }

  // Vereinfachungen (chunk_id == order_index bei sauberer Auto-Increment-Folge)
  // Sicherheitscheck: Mapping holen
  const idMap = {};
  const rows = await d1("SELECT id, order_index FROM chunks WHERE book_id = 1");
  for (const r of rows.results) idMap[r.order_index] = r.id;

  console.log("\nVereinfachungen...");
  const LEVELS = ["C1", "B2", "B1", "A2"];
  const SIMPS_PER = 6;
  let total = 0;
  for (const lvl of LEVELS) {
    const all = [];
    for (const p of book.paragraphs) {
      const text = p[lvl];
      if (!text || !text.trim()) continue;
      const cid = idMap[p.id] || p.id;
      all.push(`(${cid}, ${esc(lvl)}, ${esc(text)}, 'zeroshot', 'glm-4.5-flash')`);
    }
    for (let i = 0; i < all.length; i += SIMPS_PER) {
      const batch = all.slice(i, i + SIMPS_PER);
      try {
        await d1(`INSERT OR IGNORE INTO simplifications (chunk_id, level, simplified_text, method, model) VALUES ${batch.join(",")}`);
        total += batch.length;
      } catch (e) {
        console.log("  ✗ " + lvl + " batch: " + e.message.substring(0, 80));
      }
    }
    console.log("  " + lvl + ": " + all.length + " eingefügt");
  }

  const cnt = await d1("SELECT (SELECT COUNT(*) FROM chunks) c, (SELECT COUNT(*) FROM simplifications) s");
  console.log("\n════════════════════════");
  console.log("✓ Fertig! Chunks: " + cnt.results[0].c + ", Vereinfach.: " + cnt.results[0].s);
  console.log("════════════════════════");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
