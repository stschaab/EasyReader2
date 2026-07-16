#!/usr/bin/env node
// build_de_ranks.js — Lemma-Rang-Map fürs Frontend (Deutsch).
// Quelle: scripts/freqlists/de_lemmas.json (spaCy-lg lemmatisiert aus de_full.txt)
// Ausgabe: de_ranks.json (Map {lemma: rank})
//
// WICHTIG Gross-/Kleinschreibung: Anders als bei Spanisch werden die Keys hier
// NICHT lowercased. Deutsch hat grammatikalische Grossschreibung (Bruder != bruder,
// Weg != weg). spaCy liefert Substantive gross, Verben/Adjektive klein — das bleibt
// erhalten. Der Frontend-Lookup macht erst case-sensitiv, dann lowercase-Fallback.
//
// Aufruf:  node scripts/build_de_ranks.js
"use strict";
const fs = require("fs");
const path = require("path");
const lemmas = JSON.parse(fs.readFileSync(path.join(__dirname, "freqlists", "de_lemmas.json"), "utf8"));
const map = {};
for (const e of lemmas) map[e.lemma] = e.rank;  // Original-Casing bewahren
const json = JSON.stringify(map);
const OUT = path.join(__dirname, "..", "de_ranks.json");
fs.writeFileSync(OUT, json, "utf8");
console.log("Schreibe " + OUT + ": " + Object.keys(map).length + " Lemmata (case-erhalten, " + Math.round(json.length / 1024) + " KB).");
