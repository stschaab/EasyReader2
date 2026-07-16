#!/usr/bin/env node
// build_de_form_ranks.js — Form-Rang-Map fürs Frontend (Deutsch, ungebeugt).
// Quelle: scripts/freqlists/de_full.txt (Top-100k aus der vollen OpenSubtitles-Liste)
// Ausgabe: de_form_ranks.json (Map {form: rank}, lowercase-Keys)
// Aufruf:  node scripts/build_de_form_ranks.js
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "freqlists", "de_full.txt");
const OUT = path.join(__dirname, "..", "de_form_ranks.json");
const LIMIT = 100000;
const raw = fs.readFileSync(SRC, "utf8");
const map = {};
let rank = 0;
for (const line of raw.split(/\r?\n/)) {
  if (rank >= LIMIT) break;
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) continue;
  rank++;
  const form = parts[0].toLowerCase();
  if (map[form] === undefined) map[form] = rank;
}
const json = JSON.stringify(map);
fs.writeFileSync(OUT, json, "utf8");
console.log("Schreibe " + OUT + ": " + Object.keys(map).length + " Formen (" + Math.round(json.length / 1024) + " KB).");
