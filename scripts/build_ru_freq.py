#!/usr/bin/env python
# build_ru_freq.py
#
# Erzeugt eine lemmatisierte Lemma-Liste mit rank + ipm fuer Russisch,
# analog zu build_es_freq.py / build_de_freq.py.
#
# Eingabe:  scripts/freqlists/ru_full.txt (oder ru_50k.txt als Fallback)
#           hermitdave/OpenSubtitles 2018, Format: "form count\n", sortiert
# Ausgabe:  scripts/freqlists/ru_lemmas.json
#           Format: [{lemma, rank, ipm, pos}, ...] sortiert nach ipm absteigend
#
# Modell:   ru_core_news_lg (beste Lemmatisierung, Cyrillic, mit pymorphy3-Backend).
#
# Russisch hat keine grammatikalische Gross-/Kleinschreibung wie Deutsch.
# Lemmata werden wie von spaCy geliefert behalten (meist lowercase). Die
# Frontend-Map wird in lowercase abgelegt.
#
# Aufruf:  py scripts/build_ru_freq.py

import sys
import json
import spacy
import os

print("Lade spaCy-Modell...", flush=True)
nlp = spacy.load("ru_core_news_lg", disable=["parser", "ner"])

SRC_DIR = "scripts/freqlists"
# Bevorzuge ru_full.txt, fallback auf ru_50k.txt (bis VPN-Download verfuegbar)
SRC_FULL = os.path.join(SRC_DIR, "ru_full.txt")
SRC_50K = os.path.join(SRC_DIR, "ru_50k.txt")
SRC = SRC_FULL if os.path.exists(SRC_FULL) else SRC_50K
OUT = "scripts/freqlists/ru_lemmas.json"
print("Quelle: " + SRC + (" (volle Liste)" if SRC == SRC_FULL else " (50k-Fallback)"), flush=True)

# 1. Rohe Liste einlesen
entries = []
total = 0
with open(SRC, encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split()
        if len(parts) == 2 and parts[1].isdigit():
            c = int(parts[1])
            entries.append((parts[0], c))
            total += c
print(f"  {len(entries)} Formen, Gesamt-Count: {total:,}", flush=True)

# 2. Lemmatisieren: Top 100k (oder weniger bei 50k-Fallback)
LIMIT = min(100000, len(entries))
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
