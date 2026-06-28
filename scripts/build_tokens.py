#!/usr/bin/env python
"""Phase 1 tokenizer: ainu-corpora data.jsonl -> sentences.jsonl + tokens.jsonl.

Uses the ainu-morpheme-tagger spaCy `ain` tokenizer (the SAME tokenizer the POS
tagger uses at inference), so the token rows materialized here line up exactly
with the Phase 3 annotation pass — no tokenizer drift between KWIC and POS.

Run (no torch needed — tokenization only):
  PYTHONPATH=../ainu-morpheme-tagger \
    uv run --python 3.12 --with "spacy>=3.8.4" --with click --no-project \
    scripts/tokenize.py --data ../ainu-corpora/data.jsonl --out build

Outputs (JSONL, short keys to keep the files small):
  build/sentences.jsonl  {id,o,text,tr,dia,au,col,doc,uri}
  build/tokens.jsonl     {s,i,surf,norm,a,b,sc,cl}
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from ainu_lang import Ainu

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
    ap.add_argument("--data", required=True, help="path to ainu-corpora data.jsonl")
    ap.add_argument("--out", default="build", help="output dir")
    ap.add_argument("--limit", type=int, default=0, help="cap sentences (0 = all, for dry runs)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    nlp = Ainu()
    tokenizer = nlp.tokenizer

    n_sent = 0
    n_tok = 0
    with open(args.data, encoding="utf-8") as fin, \
         open(out / "sentences.jsonl", "w", encoding="utf-8") as fs, \
         open(out / "tokens.jsonl", "w", encoding="utf-8") as ft:
        for order, line in enumerate(fin):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            text = r.get("text") or ""
            sid = r["id"]
            fs.write(json.dumps({
                "id": sid, "o": order, "text": text,
                "tr": r.get("translation"), "dia": r.get("dialect"),
                "au": r.get("author"), "col": r.get("collection_lv1") or r.get("collection"),
                "doc": r.get("document"), "uri": r.get("uri"),
            }, ensure_ascii=False) + "\n")
            n_sent += 1
            for i, t in enumerate(tokenizer(text)):
                surf = t.text
                ft.write(json.dumps({
                    "s": sid, "i": i, "surf": surf, "norm": norm(surf),
                    "a": t.idx, "b": t.idx + len(surf),
                    "sc": script_of(surf), "cl": 1 if is_clitic(surf) else 0,
                }, ensure_ascii=False) + "\n")
                n_tok += 1
            if args.limit and n_sent >= args.limit:
                break

    print(f"sentences={n_sent} tokens={n_tok} -> {out}/")


if __name__ == "__main__":
    main()
