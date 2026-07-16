#!/usr/bin/env python
# build_es_freq.py
# Wandelt die rohe FrequencyWords-Liste (Oberflächenformen + Counts) in eine
# LEMMATISIERTE Lemma-Liste mit rank + ipm um, analog zu kelly-words.json.
#
# Eingabe:  scripts/freqlists/es_50k.txt   Format: "de 12218247\n" (form count)
# Ausgabe:  scripts/freqlists/es_lemmas.json
#           Format: [{lemma, rank, ipm, pos}, ...] sortiert nach ipm absteigend
#
# Umwandlung:
#   - spaCy lemmatisiert jede Form
#   - Counts gleicher Lemmata werden aufaddiert (konsolidiert)
#   - ipm = count / total_count * 1_000_000
#   - rank = Position nach ipm absteigend (1 = häufigstes Lemma)
#   - pos = spaCy-POS des häufigsten Vertreters

import sys
import json
import spacy

print("Lade spaCy-Modell...", flush=True)
# lg statt sm/md: beste Lemmatisierung, auch fuer seltene Woerter.
# sm lemmatisierte losa->lós, mariposa->maripós (falsch); lg macht es richtig.
nlp = spacy.load("es_core_news_lg", disable=["parser", "ner"])

SRC = "scripts/freqlists/es_full.txt"
OUT = "scripts/freqlists/es_lemmas.json"

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

# 2. Lemmatisieren: batching für Geschwindigkeit
#    Top 100000 aus der vollen es_full.txt (1,2 Mio Formen). Erweitert von 50k,
#    damit Plurale und seltenere Beugungen (z.B. losas) Coverage bekommen.
LIMIT = 100000
forms = [e[0] for e in entries[:LIMIT]]
counts = [e[1] for e in entries[:LIMIT]]
print(f"Lemmatisiere oberste {len(forms)} Formen...", flush=True)

lemma_count = {}    # lemma -> summed count
lemma_pos = {}      # lemma -> pos (des häufigsten Vertreters)
lemma_forms = {}    # lemma -> [formen] (für Debug)
BATCH = 500
for i in range(0, len(forms), BATCH):
    docs = list(nlp.pipe(forms[i:i+BATCH]))
    for j, doc in enumerate(docs):
        idx = i + j
        form = forms[idx]
        cnt = counts[idx]
        # Lemma: nimm den ersten Token-Lemma. Bei mehrteiliger Form: ersten Token.
        toks = [t for t in doc if not t.is_space]
        if not toks:
            lemma = form.lower()
            pos = "X"
        else:
            lemma = toks[0].lemma_.lower() or form.lower()
            pos = toks[0].pos_
        lemma_count[lemma] = lemma_count.get(lemma, 0) + cnt
        # POS merken, wenn dieser Vertreter häufiger ist als bisheriger
        if lemma not in lemma_pos or cnt > lemma_count.get(lemma, 0) - cnt:
            lemma_pos[lemma] = pos
        lemma_forms.setdefault(lemma, []).append(form)
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
    del r["count"]   # count nicht speichern, nur ipm/rank

print(f"Fertig: {len(result)} Lemmata. Schreibe {OUT}", flush=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

# Stichprobe
print("\nErste 20 Lemmata:")
for r in result[:20]:
    print(f"  {r['rank']:4} | {r['lemma']:12} | {r['pos']:6} | ipm={r['ipm']:8.1f}")
