# EasyReader2 — Projekt-Dokumentation

> **Wofür:** Diese Datei wird automatisch von ZCode/Claude Code gelesen, wenn ein Agent
> im Projektverzeichnis arbeitet. Sie konserviert Entscheidungen, Architektur und Stand.
> **Letztes Update:** 12. Juli 2026 (v4.0 live)

## Projektidee

Ein HTML-basierter E-Book-Reader für russische Literatur (Tolstois «Война и мир»).
Der Nutzer kann den Text in mehreren Vereinfachungs-Stufen lesen, die für
deutschsprachige Russisch-Lerner gedacht sind. Später auch Spanisch und Chinesisch.

**Betreiber:** Stefan Schaab (58, Maschinenbau-Ingenieur, Deutscher mit guten
Russisch-Kenntnissen, liest aber schlecht). 2 Wochen Bastelzeit in Russland
(Kolomna, bei der Babuschka). Gegen Sanktionen, arbeitet bewusst mit chinesischen
Ressourcen.

---

## Architektur (Stand v4.0)

### Komponenten

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Pages (statisch, zuverlässig aus Russland)       │
│  https://stschaab.github.io/EasyReader2/                 │
│                                                          │
│  index.html      — SPA (Reader, Level-Buttons, TTS)      │
│  book-1.json     — Tolstoi: 97 Chunks × 5 Levels         │
│  library.json    — Buchliste                             │
└─────────────────────────────────────────────────────────┘
         │ optional (Frontend nutzt nur statische JSON)
         ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Worker (easyreader2.st-schaab.workers.dev)   │
│  worker.js — Admin-Endpoints, /api/simplify (cache)      │
│  D1-Datenbank gebunden                                   │
└─────────────────────────────────────────────────────────┘
         ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare D1 (SQLite at edge)                          │
│  Tabellen: languages, books, chapters, chunks (97),      │
│  simplifications (388+), words (Kelly 8535),             │
│  word_forms (640), users, progress, user_words           │
└─────────────────────────────────────────────────────────┘
```

### Lokale Skripte (`scripts/`)

| Skript | Zweck |
|---|---|
| `fetch_text.js` | Holt Text von lib.ru, chunkt zeichenbasiert (~220 Z) |
| `extract_kelly.js` | `ru_m3.xls` → `kelly-words.json` (8535 Lemmata) |
| `load_kelly.js` | Lädt Kelly-Liste via Worker-Admin in D1 |
| `rebuild_book1.js` | D1 Reset + Chunk-Migration für Buch 1 |
| `generate_local.js` | **Haupt-Skript**: Generiert Simplifikationen lokal via Coding-Plan |
| `export_book_json.js` | D1 → `book-1.json` + `library.json` |
| `deploy_worker.js` | Worker-Upload mit Retry (russisches Netzwerk) |
| `build_wordforms.js` | (experimentell, warte auf Nutzung) |
| `stem_remaining.js` | Regel-Stemmer für Lemmatisierung |

### Frontend (`index.html`)

- SPA ohne Build-Step (vanilla JS)
- `VERSION = "4.0"` als Cache-Buster
- `LEVELS = ["original", "4000", "3000", "2000", "1000"]` (Wortanzahl)
- Lädt `book-1.json?v=VERSION` statisch
- TTS: Web Speech API, Marker-Stripping vor dem Vorlesen
- Wörterbuch: Englisch-Wiktionary API
- Lesefortschritt: localStorage (primär) + API (optional)

---

## Levels: Wortanzahl statt CEFR (v4.0)

### Entscheidung
Ursprünglich CEFR (A2/B1/B2/C1). Umgestellt auf **Wortanzahl** (1000/2000/3000/4000),
weil:
- Easy-Reader-Verlage arbeiten so (1200/2000/2500 Wörter)
- Kelly-CEFR war zu großzügig (B2 = 6632 Wörter, Standard = ~4000)
- Frequenz-Rang ist objektiv, CEFR ist geschätzt
- Universeller für andere Sprachen (HSK, RAEO)

### Schema bleibt universell
`simplifications.level` ist TEXT — nimmt `'1000'`, `'2000'`, `'3000'`, `'4000'` auf.
Später `1500`/`2500` ohne Umbau. Chinesisch/Spanisch mit eigener Frequenzliste.

---

## Kelly-Wortliste

- **Quelle:** `https://ssharoff.github.io/kelly/ru_m3.xls` (Serge Sharoff, Leeds)
- **Lizenz:** CC BY-NC-SA 2.0
- **Größe:** 8535 Lemmata, mit echten CEFR-Tags (A1–C2) und `ipm` (Frequenz)
- **Extrahiert in:** `scripts/kelly-words.json` (732 KB)
- **Felder:** `lemma`, `cefr`, `pos`, `ipm`, `rank` (1 = häufigstes Wort)
- **In D1 geladen:** `words`-Tabelle, 8535 Einträge, language_id=1 (ru)

### Wortanzahl-Levels schneiden Kelly nach `rank`:
- Level 1000 = `rank ≤ 1000` (die tausend häufigsten Wörter)
- Level 4000 = `rank ≤ 4000`
- usw.

---

## PCIC ↔ OpenSubtitles — Vergleich (Spanisch)

Der *Plan Curricular del Instituto Cervantes* (PCIC) ist die offiziellste
spanische Referenz mit Niveaustufen A1–C2. `scripts/build_pcic_analysis.js`
vergleicht seinen Wortschatz mit der OpenSubtitles-Lemma-Rangliste
(`es_ranks.json`), um „Lehrbuch-Spanisch" vs. „Filme/Serien-Spanisch" zu
kontrastieren.

- **Quelle:** `https://cvc.cervantes.es/ensenanza/biblioteca_ele/plan_curricular/`
  (6 Inventory-Seiten: Nociones generales + específicas × A1-A2 / B1-B2 / C1-C2)
- **Lizenz:** © Instituto Cervantes. *Reservados todos los derechos.*
  Im Gegensatz zu KELLY (CC BY-NC-SA) **nicht** offen. Daher wird der PCIC
  **nur lokal zur Analyse** geladen — weder Roh-HTML noch die extrahierte
  Lemma→Niveau-Kompilation werden committet (siehe `.gitignore`).
  Committet sind ausschließlich der Analyse-Code und aggregierte Ergebnisse.
- **Aufruf:** `node scripts/build_pcic_analysis.js` (optional `--refetch` für Cache-Erneuerung)
- **Ausgaben (gitignored):**
  - `scripts/pcic_lemmas.json` — `{lemma: niedrigstesNiveau}` (Voll-Kompilation)
  - `scripts/pcic_vs_opensubtitles.csv` — Detailzeilen mit Match-Methode
  - Markdown-Report auf stdout

### Methodik
- **Niveau = niedrigstes Vorkommen** (A1-Wort, das auch bei B1 steht → zählt als A1).
- **Lemma vs. Phrase:** Nur reine Wörter werden mit OS gejoint; Muster wie
  `hacer ~ deporte` oder `tener el pelo ~ rubio` werden nur gezählt.
- **Normalisierungs-Fallback (datengetrieben):** Bei Nicht-Treffer probiert
  das Skript Reflexiv-`-se`-Abstrich (`levantarse→levantar`),
  Plural→Singular (`padres→padre`, `vacaciones→vacación`) sowie
  Tilde-Toleranz. Die verwendete Methode steht je Zeile in der `match`-Spalte
  (`direct` / `norm:…` / `tilde:…` / `none`).

### Ergebnis (Stand Juli 2026)
~6.000 eindeutige PCIC-Lemmata gegen 67.778 OS-Lemmata. Deckung pro Niveau:
A1 99 %, A2 99 %, B1 98 %, B2 97 %, C1 91 %, C2 74 %. D.h. der
Grundwortschatz des PCIC ist in OpenSubtitles fast vollständig vertreten;
jenseits B2 wachsen die Lücken (Fach-/Kulturbegriffe).

---

## GLM-Anbindung: WICHTIG — Anthropic-Endpunkt

### Das ist der Schlüssel-Fund
**Coding-Plan (Max) greift NUR über den Anthropic-kompatiblen Endpunkt:**
```
https://open.bigmodel.cn/api/anthropic/v1/messages
Header: x-api-key: <API-KEY>
        anthropic-version: 2023-06-01
Modell: glm-4.6
```

NICHT `api.z.ai/api/paas/v4/chat/completions` — das ist der Standard-API-Endpunkt,
der **separates Guthaben** braucht (Fehler 1113 „Insufficient balance"). Coding-Plan
und API sind künstlich getrennt (wie bei Claude Pro vs. API).

### Antwort-Format (Anthropic, nicht OpenAI)
```json
{
  "content": [
    {"type": "text", "text": "...die eigentliche Antwort..."}
  ],
  "usage": {"input_tokens": ..., "output_tokens": ...}
}
```
System-Prompt ist separates Feld, nicht Teil von `messages`.

### Performance
- ~1,9–4,5 Sekunden pro Chunk
- Auf Max-Plan: **keine Kosten** (Flatrate)
- Token-Verbrauch: 200–6000 Token pro Chunk (je nach Prompt-Größe)

---

## Credentials / IDs

### Cloudflare
- **Account ID:** `f056e85f7c4bb3879769d11d80c376d6`
- **D1-UUID:** `a9a23a10-3618-43da-a52a-9ab249e81db5`
- **Worker-Name:** `easyreader2`
- **CLOUDFLARE_API_TOKEN:** als Umgebungsvariable gesetzt (nur Worker-Scope!)
  - ⚠️ Token kann D1 NICHT direkt (nur Worker-Scope). Alles geht durch Worker.
- **ADMIN_KEY:** `7f889216364cb987ec4f0b36a1ce20d5427f` (im Worker als Secret)

### Z.ai / GLM
- **API-Key:** `1db0c25e87d244948c7e38869b9024a9.uBKxTepsiqkRgLQ3`
- **Endpunkt:** `open.bigmodel.cn/api/anthropic/v1/messages` (siehe oben)
- **Coding-Plan:** Max (Flatrate für IDE-Nutzung und lokale Skripte)

### GitHub
- **Repo:** `stschaab/EasyReader2`
- **Pages:** `https://stschaab.github.io/EasyReader2/`
- **Auth:** über `git push` (HTTPS, gespeicherte Credentials)

---

## Worker (`worker.js`) — Endpunkte

### Öffentlich
- `GET /` — Health-Check
- `GET /api/books` — Buchliste
- `GET /api/books/:id` — Buch mit Originaltexten
- `GET /api/books/:id/simplifications` — alle Simplifikationen (groß!)
- `POST /api/simplify` — RAG-Vereinfachung (cached in D1)
- `GET /api/progress/:bookId` / `POST /api/progress` — Lesefortschritt
- `POST /api/synonym` — Synonym+Rang+EN (GLM live)
- `POST /api/bug-report` — Bug-Report mit optionalem Screenshot
- `POST /api/debug/hardwords` — Diagnose (hard words für einen Chunk)

### Admin (X-Admin-Key Header)
- `POST /api/admin/words` — Kelly-Wortlisten-Import
- `POST /api/admin/wordforms` — word_forms-Tabelle verwalten
- `POST /api/admin/rebuild-chunks` — Chunks neu aufbauen
- `POST /api/admin/clearcache` — Simplifikations-Cache löschen
- `POST /api/admin/insert-simplifications` — **Hauptweg:** Lokal generierte Simplifikationen einschreiben
- `GET /api/admin/bug-reports` — Bug-Report-Liste (letzte 50, ohne Screenshots)
- `GET /api/admin/bug-reports/:id` — Einzelner Bug-Report inkl. Screenshot

### ⚠️ Worker aktuell NICHT redeployt
Der Worker hat noch die alte GLM-Logik (api.z.ai). Lokale Skripte umgehen das,
indem sie GLM direkt aufrufen und Ergebnisse über `insert-simplifications`
eintragen. Deploy ist aus Russland unzuverlässig (große Uploads werden abgebrochen).

---

## D1-Schema (universell)

Siehe `scripts/schema.sql`. Wichtig:
- `chunks.original_text` — Original
- `simplifications(chunk_id, level, simplified_text, method, model)`
  - `level`: TEXT, kann `'1000'`, `'2000'`, `'B1'`, alles sein
  - `method`: `'zeroshot'`, `'rag'`, `'wordcount'`, `'manual'`
- `words(language_id, lemma, rank, cefr_level)` — Frequenzliste (Kelly für ru)
- `word_forms(word_form, lemma, cefr_level)` — Flexionsformen (optional)

---

## Bekannte Fallstricke

### 1. Worker-Deploy aus Russland
Große Multipart-Uploads (~25KB worker.js) werden regelmäßig abgebrochen
(ECONNRESET, terminated). Retry-Logik in `deploy_worker.js` hilft manchmal.
Wrangler scheitert ebenfalls. **Workaround:** Lokale Skripte nutzen live Worker.

### 2. JSON-Truncation
Antworten >30KB aus Cloudflare werden in Russland abgeschnitten
(„unterminated string at position XXXXX"). Lösung: Batched Requests
oder statische JSON-Dateien.

### 3. GLM-Rate-Limit
- `glm-4.5-flash` hat Free-Tier mit Tageslimit (Fehler 1302)
- Andere Modelle brauchen API-Guthaben (Fehler 1113)
- **Workaround:** Coding-Plan über Anthropic-Endpunkt (siehe oben)

### 4. GLM verliert manchmal die Sprache
Chinesische Zeichen (CJK) in der Ausgabe. Validierung in Skripten prüfen,
im Zweifel retry.

### 5. Z.ai trennt Abo und API künstlich
Coding-Plan (Chat/IDE) und API-Plattform (Skripte) sind separate Konten.
„Insufficient balance" heißt nicht, dass der Plan leer ist — sondern dass
der API-Zweig angesprochen wurde. Immer Anthropic-Endpunkt nutzen.

---

## Prompt-Historie (Lernpfad)

### v1: Zero-Shot (einfach)
„Vereinfache auf B1" → Modell rät, keine Präzision. 

### v2: RAG mit Kelly
Hard-Word-Liste aus D1 im Prompt. Problem: `князь` (C2) wurde zu `господин`
(Sinn verzerrt). Prompt war zu aggressiv („MUST replace EVERY word").

### v3: Reparierter Prompt (dreistufig)
1. Ersetzen, wenn echtes Synonym existiert (ибо → потому что)
2. Behalten + `[Level]` markieren, wenn kein Synonym (князь [C2])
3. `[>C2]` für Wörter außerhalb Kellys

A/B-Test bestätigt: `князь` bleibt, wird nicht mehr zu `господин`. ✅

### v4: Wortanzahl-Levels (aktuell)
- Levels: 1000/2000/3000/4000 statt CEFR
- Prompt enthält ALLOWED-Liste (N häufigste) + ABOVE-Liste (mit Rang)
- Syntax-Staffelung pro Level (4000 = erhalten, 1000 = extrem einfach)

### ⚠️ Offene Prompt-Probleme (12. Juli 2026)
1. **Rank-Zuweisungen falsch:** Modell kann in 6000-Wort-Liste nicht zuverlässig
   nachschlagen (`[поэма:4001]` für *известная* — komplett daneben)
2. **Eigennamen werden markiert:** Trotz „NEVER mark names" markiert das Modell
   `Анна Павловна Шерер` etc.
3. **Levels zu ähnlich:** Vor allem 4000 vs. Original kaum Unterschied

### Mögliche Lösungsansätze (zu diskutieren)
- **A:** Radikal vereinfachter Prompt ohne Listen. Modell nutzt Frequenz-Intuition.
- **B:** Eigennamen im Chunk-Text vorab taggen (`[NAME князь Василий]`)
- **C:**Kelly-Liste nur für das unterste Level (1000) voll mitgeben, für höhere
  Levels verkürzt
- **D:** Zweistufiger Prozess: 1) Modell lemmatisiert, 2) lookup gegen D1

---

## Lesefortschritt (userId)

- Generiert pro Gerät zufällig (`anon-XXXXX`) in `localStorage`
- Notebook und Handy haben **verschiedene** userIds → **keine Sync** (gewollt!)
- Stefan testet am Notebook, liest am Handy. Sollen sich nicht beeinflussen.

---

## Bug-Report-Funktion (v7.19)

User können über den 🐛-Button (Header + Review-Topbar) einen Bug-Report senden.

- **Screenshot:** `html2canvas` (CDN) rendert das aktuelle `document.body` — **inkl. offenem Wörterbuch-Popup**, weil der Screenshot läuft, *bevor* das Bug-Overlay eingeblendet wird. Bild wird auf max 1280px Breite skaliert und als JPEG (q=0.7) base64-kodiert. Fehlt `html2canvas` oder schlägt es fehl (CORS), läuft alles ohne Screenshot weiter.
- **Spracheingabe (optional):** `SpeechRecognition`/`webkitSpeechRecognition` — Button erscheint nur, wenn die API vorhanden ist (Chrome/Edge/Android; **nicht iOS Safari**). Sprache = `book.tts_lang`, sonst `de-DE`. Interim-Ergebnisse werden live in die Textarea eingetragen.
- **Senden:** `POST /api/bug-report` mit `{ description, screenshot, version, book_id, chunk_index, level }`. Schlägt das API fehl (Netzwerk/Worker nicht deployed), wird der Report als lokale JSON-Datei heruntergeladen (Fallback).
- **Speicher:** D1-Tabelle `bug_reports` (wird vom Worker per `CREATE TABLE IF NOT EXISTS` automatisch angelegt). Screenshot wird serverseitig verworfen, wenn > ~750 KB base64.
- **Auslesen (Admin):**
  ```bash
  curl -H "X-Admin-Key: $ADMIN_KEY" \
    https://easyreader2.st-schaab.workers.dev/api/admin/bug-reports
  # einzelnen Report mit Screenshot:
  curl -H "X-Admin-Key: $ADMIN_KEY" \
    https://easyreader2.st-schaab.workers.dev/api/admin/bug-reports/1
  ```
- **⚠️ Worker muss deployed sein**, damit Reports in D1 landen. Bis dahin greift der lokale Download-Fallback.

---

## TODO / Offen

### Dringend
- **Prompt-Logik überdenken** (siehe oben) — aktuelle v4-Ergebnisse unbrauchbar für
  Marker, Levels zu ähnlich
- Level 2000 hatte in erster v4-Generierung 29/97 Chunks mit kaputten Markern

### Mittel
- Worker redeployen (wenn Netzwerk erlaubt) — hat noch alte GLM-Logik
- Wortanzahl-Display im Frontend schöner („4000 W." → vielleicht Slider später)
- Eigennamen-Erkennung (Capitalized-Wörter + bekannte Namen)

### Langfristig
- Live-Slider vom Handy (braucht API-Key-Schutz — Worker wäre öffentlich)
- API-Zugang bei Z.ai beantragen (10 Werktage Review) für Skalierung
- Lemmatisierung (pymorphy3 via Colab) für bessere Hard-Word-Erkennung
- Mehr Bücher: ganzes «Война и мир», andere russische Literatur
- Andere Sprachen: Spanisch (RAEO-Liste), Chinesisch (HSK-Liste)
- Grammatik-RAG (ТРКИ-PDF-Parsing, `grammar_points`-Tabelle füllen)
- Vokabeltrainer (SRS: SM-2 vs. FSRS), `user_words`-Tabelle ist vorbereitet
- Google OAuth (Schema vorbereitet, aktuell 'anon')
- Google-login für Multi-Device-Fortschritt

---

## Befehle für den Alltag

```bash
# Simplifikationen lokal generieren
cd C:/Users/Stefan/ZCodeProject/EasyReader2
ADMIN_KEY=7f889216364cb987ec4f0b36a1ce20d5427f node scripts/generate_local.js

# Export nach book-1.json
ADMIN_KEY=7f889216364cb987ec4f0b36a1ce20d5427f node scripts/export_book_json.js

# Deploy nach GitHub Pages
git add book-1.json index.html library.json
git commit -m "v4.x: ..."
git push origin main

# Worker deployen (oft schwierig aus Russland)
GLM_API_KEY=1db0c... ADMIN_KEY=7f88... node scripts/deploy_worker.js
```

---

## Was ein neuer Chat wissen muss

1. **Lies diese Datei komplett.** Sie ist der Projektstand.
2. **GLM-Anbindung:** IMMER `open.bigmodel.cn/api/anthropic`, niemals `api.z.ai`.
3. **Worker-Deploy** ist aktuell gebrochen — lokale Skripte sind der Weg.
4. **Levels sind Wortanzahl** (1000/2000/3000/4000), nicht CEFR.
5. **Prompt-Logik ist in Arbeit** — die v4-Ergebnisse sind nicht produktionsreif.
6. **Sprache mit Stefan:** Deutsch. Er fragt selbst, will keine Options-Fragen.
7. **Keine voreiligen Aktionen** — erst verstehen, dann vorschlagen.
