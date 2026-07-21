#!/usr/bin/env python
# lemmatize_es_batch.py
# Lemmatisiert VIELE spanische Texte in einem Aufruf (spaCy wird nur einmal geladen).
# Aufruf:  py -3.13 lemmatize_es_batch.py
# Eingabe: JSON-Array von Strings ueber stdin
# Ausgabe: JSON-Array von Arrays; ein inneres Array pro Text,
#          Eintrag pro Token: {"token","lemma","is_name","pos"}
#          - is_name = true bei PROPN (Eigennamen, Orte, Fremde Namen)
#          - Satzzeichen und reine Leerzeichen ausgelassen

import sys
import json
import spacy

nlp = spacy.load("es_core_news_sm", disable=["ner"])


def lemmatize(text):
    out = []
    for tok in nlp(text):
        if tok.is_space or tok.is_punct:
            continue
        out.append({
            "token": tok.text,
            "lemma": (tok.lemma_ or tok.text).lower(),
            "is_name": tok.pos_ == "PROPN",
            "pos": tok.pos_,
        })
    return out


def main():
    texts = json.loads(sys.stdin.read())
    result = [lemmatize(t) for t in texts]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
