#!/usr/bin/env node
// build_ru_form_ranks.js — Form-Rang-Map fürs Frontend (Russisch, ungebeugt).
// Quelle: scripts/freqlists/ru_full.txt oder ru_50k.txt (Top-100k OpenSubtitles 2018)
// Ausgabe: ru_form_ranks.json (Map {form: rank}, lowercase-Keys)
"use strict";
const fs = require("fs");
const path = require("path");
const SRC_FULL = path.join(__dirname, "freqlists", "ru_full.txt");
const SRC_50K = path.join(__dirname, "freqlists", "ru_50k.txt");
const SRC = fs.existsSync(SRC_FULL) ? SRC_FULL : SRC_50K;
const OUT = path.join(__dirname, "..", "ru_form_ranks.json");
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
