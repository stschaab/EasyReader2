#!/usr/bin/env node
// build_es_form_ranks.js
//
// Erzeugt eine {form: rank}-Map für das "Film Rang"-Badge im Wörterbuch-Popup
// (gebeugte Form / Oberflächenform, NICHT lemmatisiert).
//
// Quelle: scripts/freqlists/es_full.txt
//   - hermitdave/FrequencyWords, basierend auf OpenSubtitles 2018
//   - Format: "form count\n" pro Zeile, bereits nach Häufigkeit absteigend sortiert
//   - Top 100.000 Oberflächenformen (ungebeugt: jede Form eigener Eintrag)
//     genommen aus der vollen Liste (1,2 Mio Formen).
//
// Ausgabe: es_form_ranks.json (im EasyReader2-Root)
//   - Map {form: rank}, lowercase-Keys
//   - rank = 1-basierte Zeilenposition (1 = häufigste Form im Untertitel-Korpus)
//
// Im Gegensatz zu es_ranks.json (Lemma-Rang aus es_lemmas.json) spiegelt diese
// Liste die Häufigkeit der KONKRETEN Beugung wider. Dadurch stehen simple
// Verbformen (es, son) weiter vorn als komplexe (sea, fuera). Komplementär
// zum Lemma-Rang. Gleiche Basis (Top-100k aus es_full.txt) wie die Lemma-Liste.
//
// Aufruf:  node scripts/build_es_form_ranks.js

"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "freqlists", "es_full.txt");
const OUT = path.join(__dirname, "..", "es_form_ranks.json");
const LIMIT = 100000;

console.log("Lese " + SRC + " ...");
const raw = fs.readFileSync(SRC, "utf8");

const map = {};
let rank = 0;
let skipped = 0;
for (const line of raw.split(/\r?\n/)) {
  if (rank >= LIMIT) break;
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
    if (line.trim()) skipped++;
    continue;
  }
  rank++;
  const form = parts[0].toLowerCase();
  // Erste Vorkommens gewinnt (Liste ist absteigend sortiert, also die
  // häufigste Schreibweise bekommt den besten Rang bei Duplikaten).
  if (map[form] === undefined) map[form] = rank;
}

console.log("  " + rank + " gültige Zeilen, " + Object.keys(map).length +
  " eindeutige Formen (" + skipped + " übersprungen).");

const json = JSON.stringify(map);
fs.writeFileSync(OUT, json, "utf8");
console.log("Schreibe " + OUT + " (" + Math.round(json.length / 1024) + " KB).");

// Stichprobe
console.log("\nTop 10:");
const sample = Object.entries(map).slice(0, 10);
for (const [form, r] of sample) {
  console.log("  " + String(r).padStart(5) + " | " + form);
}
