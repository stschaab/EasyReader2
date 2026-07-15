// build_en_a1.js
// Assembliert EN-A1-Level für Zalacaín aus der Satz-Map.
// Für jeden Chunk: alle englischen Satz-Übersetzungen aus book-2-sentences.json
// aneinanderreihen → Feld "EN-A1" pro Chunk in book-2.json.
// Keine GLM-Calls — die Daten liegen schon vor.

const fs = require("fs");
const path = require("path");

const BOOK_PATH = path.join(__dirname, "..", "book-2.json");
const SENT_PATH = path.join(__dirname, "..", "book-2-sentences.json");

const b = JSON.parse(fs.readFileSync(BOOK_PATH, "utf8"));
const sentences = JSON.parse(fs.readFileSync(SENT_PATH, "utf8"));

const sentByChunk = {};
for (const e of sentences) sentByChunk[e.chunk_id] = e.sentences || [];

let added = 0, empty = 0;
for (const c of b.chunks) {
  const sents = sentByChunk[c.id] || [];
  if (sents.length > 0 && sents.some(s => s.en)) {
    c["EN-A1"] = sents.map(s => s.en).join(" ");
    added++;
  } else {
    c["EN-A1"] = "";
    empty++;
  }
}

// levels um EN-A1 ergänzen (nach EN, falls nicht schon drin)
if (!b.book.levels.includes("EN-A1")) {
  const enIdx = b.book.levels.indexOf("EN");
  if (enIdx >= 0) b.book.levels.splice(enIdx + 1, 0, "EN-A1");
  else b.book.levels.push("EN-A1");
}

fs.writeFileSync(BOOK_PATH, JSON.stringify(b, null, 2), "utf8");
console.log("EN-A1 für " + added + "/" + b.chunks.length + " Chunks assembliert (" + empty + " leer)");
console.log("levels:", b.book.levels.join(","));
console.log("");
console.log("Stichprobe Chunk 1:");
const c = b.chunks[0];
console.log("A1     :", c.A1.substring(0, 100));
console.log("EN     :", c.EN.substring(0, 100));
console.log("EN-A1  :", c["EN-A1"].substring(0, 100));
