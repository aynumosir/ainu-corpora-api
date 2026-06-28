#!/usr/bin/env python
"""Phase 3: POS-enrich the corpus tokens with the ainu-morpheme-tagger model.

Loads the trained spaCy `ain` pipeline (CNN tok2vec — CPU, no torch) and runs it
over ainu-corpora data.jsonl. Because the pipeline uses the SAME `ain` tokenizer
as Phase 1 (scripts/build_tokens.py), the token sequence + char offsets line up
exactly, so this writes a drop-in replacement token file with POS columns filled.

POS is written only for Latin-script tokens — the model is Roman-trained and
unreliable on Katakana/Cyrillic (reviewers' note); non-Latin tokens keep their
surface/offset rows with NULL POS (still searchable lexically + in KWIC).

Run with the tagger's own venv (has spacy + ainu_lang + the model deps):
  PYTHONPATH=. ../ainu-morpheme-tagger/.venv/bin/python \
    ../ainu-corpora-api/scripts/tag_pos.py \
    --data ../ainu-corpora/data.jsonl \
    --model ../ainu-morpheme-tagger/training/combined_enriched/model-best \
    --out ../ainu-corpora-api/build --procs 6
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import spacy

KANA = re.compile(r"[゠-ヿㇰ-ㇿｦ-ﾟ぀-ゟ]")
CYRL = re.compile(r"[Ѐ-ӿ]")
LATN = re.compile(r"[A-Za-zÀ-ɏ]")
EDGE_APOS = re.compile(r"^['’\"]+|['’\"]+$")


def script_of(s: str) -> str:
    if KANA.search(s):
        return "kana"
    if CYRL.search(s):
        return "cyrl"
    if LATN.search(s):
        return "latn"
    return "other"


def norm(s: str) -> str:
    return EDGE_APOS.sub("", s.lower())


def is_clitic(s: str) -> bool:
    return s.endswith("=") or s.startswith("=")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default="build")
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model_version = Path(args.model).parent.name + "/" + Path(args.model).name

    # Read sentences (id + text), preserving order.
    rows: list[tuple[str, str]] = []
    with open(args.data, encoding="utf-8") as fin:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rows.append((r["id"], r.get("text") or ""))
            if args.limit and len(rows) >= args.limit:
                break

    nlp = spacy.load(args.model)
    texts = (t for _, t in rows)
    n_tok = 0
    n_pos = 0
    with open(out / "tokens_pos.jsonl", "w", encoding="utf-8") as ft:
        for (sid, _), doc in zip(rows, nlp.pipe(texts, n_process=args.procs, batch_size=args.batch)):
            for i, t in enumerate(doc):
                surf = t.text
                sc = script_of(surf)
                rec = {
                    "s": sid, "i": i, "surf": surf, "norm": norm(surf),
                    "a": t.idx, "b": t.idx + len(surf), "sc": sc,
                    "cl": 1 if is_clitic(surf) else 0,
                    "lem": None, "up": None, "xp": None, "ft": None, "mv": None,
                }
                if sc == "latn":  # POS only where the Roman-trained model is reliable
                    feats = str(t.morph) or None
                    rec.update({
                        "lem": t.lemma_ or None, "up": t.pos_ or None,
                        "xp": t.tag_ or None, "ft": feats, "mv": model_version,
                    })
                    if rec["up"]:
                        n_pos += 1
                ft.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_tok += 1

    print(f"sentences={len(rows)} tokens={n_tok} pos_tagged={n_pos} model={model_version}")


if __name__ == "__main__":
    main()
