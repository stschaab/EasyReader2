#!/usr/bin/env python
# build_de_freq.py
#
# Erzeugt eine lemmatisierte Lemma-Liste mit rank + ipm fuer Deutsch,
# analog zu build_es_freq.py.
#
# Eingabe:  scripts/freqlists/de_full.txt (hermitdave/OpenSubtitles 2018, voll)
#           Format: "form count\n", nach Haeufigkeit absteigend sortiert
# Ausgabe:  scripts/freqlists/de_lemmas.json
#           Format: [{lemma, rank, ipm, pos}, ...] sortiert nach ipm absteigend
#
# Modell:   de_core_news_lg (beste Lemmatisierung, auch fuer seltene Woerter).
#
# Achtung Gross-/Kleinschreibung: Deutsch ist grammatikalisch relevant
# (Weg vs weg,rootsaetze). Lemmata werden wie von spaCy geliefert behalten
# (Substantive gross, Verben/Adjektive klein). Die Frontend-Map wird in
# lowercase abgelegt und der Lookup erfolgt via toLowerCase() — das kann
# bei Homografen (Weg/weg) zu Mehrfachmatch fuehren; das kleine Modell
# bevorzugt dann die haeufigere Variante (Liste ist sortiert).
#
# Aufruf:  py scripts/build_de_freq.py

import sys
import json
import spacy

print("Lade spaCy-Modell...", flush=True)
nlp = spacy.load("de_core_news_lg", disable=["parser", "ner"])

SRC = "scripts/freqlists/de_full.txt"
OUT = "scripts/freqlists/de_lemmas.json"

# 1. Rohe Liste einlesen
print("Lese " + SRC + "...", flush=True)
entries = []  # [(form, count)]
total = 0
with open(SRC, encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split()
        if len(parts) == 2 and parts[1].isdigit():
            c = int(parts[1])
            entries.append((parts[0], c))
            total += c
print(f"  {len(entries)} Formen, Gesamt-Count: {total:,}", flush=True)

# 2. Lemmatisieren: Top 100k aus der vollen Liste
LIMIT = 100000
forms = [e[0] for e in entries[:LIMIT]]
counts = [e[1] for e in entries[:LIMIT]]
print(f"Lemmatisiere oberste {len(forms)} Formen...", flush=True)

lemma_count = {}
lemma_pos = {}
BATCH = 500
for i in range(0, len(forms), BATCH):
    docs = list(nlp.pipe(forms[i:i+BATCH]))
    for j, doc in enumerate(docs):
        idx = i + j
        form = forms[idx]
        cnt = counts[idx]
        toks = [t for t in doc if not t.is_space]
        if not toks:
            lemma = form.lower()
            pos = "X"
        else:
            lemma = toks[0].lemma_ or form.lower()
            pos = toks[0].pos_
        lemma_count[lemma] = lemma_count.get(lemma, 0) + cnt
        if lemma not in lemma_pos or cnt > lemma_count.get(lemma, 0) - cnt:
            lemma_pos[lemma] = pos
    if (i // BATCH) % 10 == 0:
        print(f"  ... {i+len(docs)}/{len(forms)}", flush=True)

# 3. ipm berechnen, sortieren, rank vergeben
print("Berechne ipm und vergebe Ränge...", flush=True)
result = []
for lemma, cnt in lemma_count.items():
    ipm = round(cnt / total * 1_000_000, 4)
    result.append({"lemma": lemma, "count": cnt, "ipm": ipm, "pos": lemma_pos.get(lemma, "X")})
result.sort(key=lambda x: x["ipm"], reverse=True)
for i, r in enumerate(result, 1):
    r["rank"] = i
    del r["count"]

print(f"Fertig: {len(result)} Lemmata. Schreibe {OUT}", flush=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print("\nErste 20 Lemmata:")
for r in result[:20]:
    print(f"  {r['rank']:4} | {r['lemma']:12} | {r['pos']:6} | ipm={r['ipm']:8.1f}")
