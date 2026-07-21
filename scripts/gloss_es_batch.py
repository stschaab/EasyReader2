#!/usr/bin/env python
# gloss_es_batch.py
# Setzt englische Inline-Glossen in spanische Texte ein.
# Glossen werden NUR an Wörter gesetzt, deren Lemma im Glossen-Dict steht
# (das Dict enthält Lemma -> englische Übersetzung der >2000-Wörter).
# Eigennamen (PROPN) werden nie geglossed.
#
# Aufruf:  py -3.13 gloss_es_batch.py
# stdin:   JSON-Objekt {"texts": [...], "glosses": {"lemma": "english"}}
# stdout:  JSON-Array von Strings (ein geglosseter Text pro Eingabetext)
#
# Die Glossierung nutzt spaCy-Token-Offsets, sodass Whitespace und
# Zeichensetzung exakt erhalten bleiben. Beispiel:
#   "muralla" (Lemma in glosses) -> "muralla (wall)"

import sys
import json
import spacy

nlp = spacy.load("es_core_news_sm", disable=["ner"])


def gloss_text(text, glosses):
    if not text:
        return text
    doc = nlp(text)
    out = []
    last_end = 0
    for tok in doc:
        # Lücke zwischen vorigem Token und diesem (Whitespace/Sonderzeichen)
        out.append(text[last_end:tok.idx])
        # das Token selbst (Originalform, inkl. Akzente)
        tok_text = text[tok.idx:tok.idx + len(tok.text)]
        out.append(tok_text)
        last_end = tok.idx + len(tok.text)
        # Glosse nur bei Bedeutungsträgern > Rang 2000, nie bei Eigennamen
        lemma = (tok.lemma_ or tok.text).lower()
        if tok.pos_ != "PROPN" and lemma in glosses:
            out.append(" (" + glosses[lemma] + ")")
    # Text nach dem letzten Token
    out.append(text[last_end:])
    return "".join(out)


def main():
    payload = json.loads(sys.stdin.read())
    texts = payload["texts"]
    glosses = payload["glosses"]
    result = [gloss_text(t, glosses) for t in texts]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
