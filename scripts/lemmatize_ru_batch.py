#!/usr/bin/env python
# lemmatize_ru_batch.py
# Lemmatisiert VIELE russische Texte in einem Aufruf (pymorphy3 wird nur einmal geladen).
# Aufruf:  py -3.13 lemmatize_ru_batch.py
# Eingabe: JSON-Array von Strings ueber stdin
# Ausgabe: JSON-Array von Arrays; ein inneres Array pro Text,
#          Eintrag pro Token: {"token","lemma","is_name"}
#          - is_name = true, wenn pymorphy3 den Tag 'Name' setzt (Eigenname)

import sys
import json
import re
import pymorphy3

morph = pymorphy3.MorphAnalyzer()


def tokenize(text):
    # Kyrillische Wort-Token, inkl. ё/Ё. Groß/Klein bleibt erhalten
    # (pymorphy3 nutzt Großschreibung bei der Namens-Erkennung).
    return re.findall(r"[А-Яа-яЁё]+", text or "")


def lemmatize_token(tok):
    parses = morph.parse(tok)
    if not parses:
        return {"token": tok, "lemma": tok.lower(), "is_name": False}
    p = parses[0]
    is_name = "Name" in str(p.tag)
    return {"token": tok, "lemma": p.normal_form.lower(), "is_name": is_name}


def lemmatize(text):
    return [lemmatize_token(tok) for tok in tokenize(text)]


def main():
    texts = json.loads(sys.stdin.read())
    result = [lemmatize(t) for t in texts]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
