#!/usr/bin/env node
// build_es_ranks.js
//
// Erzeugt die {lemma: rank}-Map für das Lemma-Rang-Badge im Wörterbuch-Popup.
//
// Quelle: scripts/freqlists/es_lemmas.json
//   - spaCy-lemmatisiert aus es_50k.txt (siehe build_es_freq.py)
//   - Format: [{lemma, ipm, pos, rank}, ...] sortiert nach ipm absteigend
//
// Ausgabe: es_ranks.json (im EasyReader2-Root)
//   - Map {lemma: rank}, lowercase-Keys
//   - rank = Positionsindex aus es_lemmas.json (1 = häufigstes Lemma)
//
// Aufruf:  node scripts/build_es_ranks.js

"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "freqlists", "es_lemmas.json");
const OUT = path.join(__dirname, "..", "es_ranks.json");

const lemmas = JSON.parse(fs.readFileSync(SRC, "utf8"));
const map = {};
for (const e of lemmas) {
  map[e.lemma.toLowerCase()] = e.rank;
}

const json = JSON.stringify(map);
fs.writeFileSync(OUT, json, "utf8");
console.log("Schreibe " + OUT + ": " + Object.keys(map).length +
  " Lemmata (" + Math.round(json.length / 1024) + " KB).");
