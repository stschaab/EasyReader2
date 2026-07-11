// fetch_text.js
// Holt «Война и мир» (erster Entwurf, komplett russisch) von lib.ru,
// extrahiert die ersten N Kapitel und teilt sie in ~50-Wort-Chunks.
// Erzeugt data.js für SimpleReader.
//
// Nutzung: node scripts/fetch_text.js [anzahlKapitel]   (Default: 2)

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const URL = "http://az.lib.ru/t/tolstoj_lew_nikolaewich/text_0073.shtml";
const MAX_WORDS_PER_CHUNK = 55;   // Zielgröße, Referenz = Chunk 1 mit 61 Wörtern
const CHAPTERS_TO_FETCH = parseInt(process.argv[2] || "2", 10);

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
  });
}

// Windows-1251 -> UTF-8 (lib.ru liefert in 1251)
function decode1251(buf) {
  // Node hat keine eingebaute 1251-Decode; wir nutzen TextDecoder falls verfügbar
  try {
    return new TextDecoder("windows-1251").decode(buf);
  } catch (e) {
    // Fallback: roh zurückgeben
    return buf.toString("latin1");
  }
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
  });
}

// Konvertiert römische Zahl in arabische (I=1, II=2, ...)
function romanToInt(roman) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let result = 0;
  for (let i = 0; i < roman.length; i++) {
    const cur = map[roman[i]];
    const next = map[roman[i + 1]];
    if (next && cur < next) result -= cur;
    else result += cur;
  }
  return result;
}

// Extrahiert Kapitel aus dem HTML
// Struktur: <b>ЧАСТЬ ПЕРВАЯ</b> ... <b>I</b> ... <b>II</b> ...
function extractChapters(html) {
  // HTML-Tags entfernen, Entitäten decodieren
  const clean = html
    .replace(/<dd>&nbsp;&nbsp;&nbsp;/g, "\n\n")  // Absatzumbrüche
    .replace(/<[^>]+>/g, " ")                      // alle Tags raus
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/--[ ]/g, "— ")                       // lib.ru nutzt -- für —
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .trim();

  // Finde alle Kapitel-Überschriften: isolierte römische Zahlen
  // Muster: eine Zeile die NUR aus römischen Ziffern besteht
  const lines = clean.split("\n");
  const chapterStarts = []; // {roman, arabic, lineIndex}
  let currentPart = "ЧАСТЬ ПЕРВАЯ";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Teil-Marker
    if (/^ЧАСТЬ [А-ЯЁ]+$/.test(line)) {
      currentPart = line;
    }
    // Kapitel-Marker: Zeile besteht nur aus römischen Ziffern
    if (/^[IVXLCDM]+$/.test(line) && line.length <= 5) {
      chapterStarts.push({
        roman: line,
        arabic: romanToInt(line),
        lineIndex: i,
        part: currentPart,
      });
    }
  }

  // Kapitel-Texte extrahieren (von einem Marker bis zum nächsten)
  const chapters = [];
  for (let i = 0; i < chapterStarts.length; i++) {
    const start = chapterStarts[i];
    const end = chapterStarts[i + 1];
    const textLines = lines.slice(start.lineIndex + 1, end ? end.lineIndex : start.lineIndex + 2000);
    const text = textLines.join("\n").trim();
    chapters.push({
      roman: start.roman,
      arabic: start.arabic,
      part: start.part,
      text: text,
    });
    if (chapters.length >= 50) break; // Sicherheitslimit
  }

  return chapters;
}

// Teilt Text in Chunks von ~MAX_WORDS_PER_CHUNK Wörtern
// versucht, an Satzenden zu trennen – schneidet NIE mitten im Satz ab
function chunkText(text) {
  const words = text.split(/\s+/);
  const chunks = [];
  let current = [];
  let currentLen = 0;
  const HARD_LIMIT = 75; // absolut: danach notfalls mitten im Satz (Schutz)

  for (const word of words) {
    current.push(word);
    currentLen++;
    const endsSentence = /[.!?…»]$/.test(word);
    // Ab Mindestlänge UND Satzende: sauber trennen
    if (currentLen >= 30 && endsSentence) {
      chunks.push(current.join(" "));
      current = [];
      currentLen = 0;
    }
    // Hard limit: weiter bis Satzende, aber spätestens bei HARD_LIMIT
    else if (currentLen >= MAX_WORDS_PER_CHUNK && endsSentence) {
      chunks.push(current.join(" "));
      current = [];
      currentLen = 0;
    } else if (currentLen >= HARD_LIMIT) {
      // Notfall: sehr langer Satz, hier trennen
      chunks.push(current.join(" "));
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join(" "));
  return chunks;
}

// russischer Teilname -> kompakt
function partShort(part) {
  const map = {
    "ЧАСТЬ ПЕРВАЯ": "Ч. 1",
    "ЧАСТЬ ВТОРАЯ": "Ч. 2",
    "ЧАСТЬ ТРЕТЬЯ": "Ч. 3",
  };
  return map[part] || part;
}

async function main() {
  console.log("Lade Text von lib.ru ...");
  const buf = await fetchBuffer(URL);
  const html = decode1251(buf);
  console.log("Geladen: " + (html.length / 1024).toFixed(0) + " KB");

  const chapters = extractChapters(html);
  console.log("Gefundene Kapitel gesamt: " + chapters.length);
  console.log("Nehme erste " + CHAPTERS_TO_FETCH + " Kapitel (Teil 1)\n");

  // Nur Kapitel aus ЧАСТЬ ПЕРВАЯ, die ersten N
  const part1 = chapters.filter((c) => c.part === "ЧАСТЬ ПЕРВАЯ");
  const selected = part1.slice(0, CHAPTERS_TO_FETCH);

  const out = {
    meta: {
      title: "Война и мир",
      author: "Лев Толстой",
      edition: "Первый вариант романа (russischsprachig)",
      source: "http://az.lib.ru/t/tolstoj_lew_nikolaewich/text_0073.shtml",
      part: "Том 1 · Часть первая",
    },
    paragraphs: [],
  };

  let chunkId = 1;
  selected.forEach((ch) => {
    const chunks = chunkText(ch.text);
    chunks.forEach((chunkTextStr) => {
      out.paragraphs.push({
        id: chunkId++,
        bookRef: "Т.1 · " + partShort(ch.part) + " · Гл. " + ch.roman,
        chapter: ch.arabic,
        original: chunkTextStr,
        C1: "",
        B2: "",
        B1: "",
        A2: "",
      });
    });
    console.log(
      "  Гл. " + ch.roman + ": " + chunks.length + " Chunks (" +
      ch.text.split(/\s+/).length + " Wörter)"
    );
  });

  console.log("\nInsgesamt: " + out.paragraphs.length + " Chunks");

  // Wortzahl-Statistik
  const wordCounts = out.paragraphs.map((p) => p.original.split(/\s+/).length);
  const maxW = Math.max(...wordCounts);
  const minW = Math.min(...wordCounts);
  const avgW = Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length);
  console.log("Chunk-Statistik: min " + minW + ", max " + maxW + ", Ø " + avgW + " Wörter");

  // data.js schreiben
  const js = "// Auto-generiert von scripts/fetch_text.js am " +
    new Date().toISOString().slice(0, 10) + "\n" +
    "// Quelle: " + out.meta.source + "\n" +
    "// Chunk-Logik: ~" + MAX_WORDS_PER_CHUNK + " Wörter max, Trennung an Satzenden\n\n" +
    "const BOOK = " + JSON.stringify(out, null, 2) + ";\n\n" +
    "if (typeof window !== \"undefined\") window.BOOK = BOOK;\n" +
    "if (typeof module !== \"undefined\" && module.exports) module.exports = BOOK;\n";

  const outPath = path.join(__dirname, "..", "data.js");
  fs.writeFileSync(outPath, js, "utf-8");
  console.log("\n→ data.js geschrieben: " + outPath);
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exit(1);
});
