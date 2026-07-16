#!/usr/bin/env node
// build_ru_ranks.js — Lemma-Rang-Map fürs Frontend (Russisch).
// Quelle: scripts/freqlists/ru_lemmas.json (spaCy-lg lemmatisiert aus ru_full/50k.txt)
// Ausgabe: ru_ranks.json (Map {lemma: rank}, lowercase-Keys)
// Russisch hat keine grammatikalische Gross-/Kleinschreibung → lowercase OK.
"use strict";
const fs = require("fs");
const path = require("path");
const lemmas = JSON.parse(fs.readFileSync(path.join(__dirname, "freqlists", "ru_lemmas.json"), "utf8"));
const map = {};
for (const e of lemmas) map[e.lemma.toLowerCase()] = e.rank;
const json = JSON.stringify(map);
const OUT = path.join(__dirname, "..", "ru_ranks.json");
fs.writeFileSync(OUT, json, "utf8");
console.log("Schreibe " + OUT + ": " + Object.keys(map).length + " Lemmata (" + Math.round(json.length / 1024) + " KB).");
