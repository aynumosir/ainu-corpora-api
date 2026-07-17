#!/usr/bin/env python
"""Build curated-gloss JSONL from ainu-corpora-annotations layer directories.

Each layer directory holds a manifest.yaml plus one YAML file per covered
corpus text (see the annotations repo for the schema). This script maps the
layer's (path, index) anchoring onto corpus sentence ids
(`<document>#<index>`, e.g. texts/hokudai-respect/full.yaml index 7 →
hokudai-respect/full#7) and precomputes the token alignment for each part.

Run:
  uv run --with pyyaml scripts/build_curated_gloss.py \
    --layer ../ainu-corpora-annotations/layers/hokudai-respect-gloss

Outputs (JSONL, one file per table in migrations/0006_curated_gloss.sql):
  build/gloss_layers.jsonl   one row per layer
  build/curated_gloss.jsonl  one row per (sentence, part)
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import yaml

SEPARATORS = re.compile(r"[、。]")


def gloss_tokens(s: str) -> list[str]:
    """Gloss lines attach 、/。 to the preceding token; treat them as spaces so
    token counts line up with the ain line (whose punctuation is ASCII and
    stays attached to its own token)."""
    return SEPARATORS.sub(" ", s).split()


def align(ain: str, gloss: str) -> tuple[int, list[list[str]] | None]:
    a, g = ain.split(), gloss_tokens(gloss)
    if len(a) == len(g):
        return 1, [list(p) for p in zip(a, g)]
    return 0, None


def document_key(path: str) -> str:
    """texts/hokudai-respect/full.yaml -> hokudai-respect/full (= sentences.id
    prefix in the corpus DB)."""
    p = path
    if p.startswith("texts/"):
        p = p[len("texts/"):]
    if p.endswith(".yaml"):
        p = p[: -len(".yaml")]
    return p


def build_layer(layer_dir: Path, layer_id: str | None) -> tuple[dict, list[dict]]:
    manifest = yaml.safe_load((layer_dir / "manifest.yaml").read_text(encoding="utf-8"))
    lid = layer_id or layer_dir.name
    origin = manifest.get("origin") or {}
    source = manifest.get("source") or {}
    gloss = manifest.get("gloss") or {}
    meta = {
        "id": lid,
        "credibility": "curated",
        "language": gloss.get("language") or "ja",
        "status": manifest.get("status"),
        "author": origin.get("author"),
        "origin_url": origin.get("url"),
        "origin_title": origin.get("title"),
        "description": manifest.get("description"),
        "source_repository": source.get("repository"),
        "source_revision": source.get("revision"),
        "retrieved_at": origin.get("retrieved_at"),
    }
    rows: list[dict] = []
    for text in source.get("texts") or []:
        doc = document_key(text["path"])
        data = yaml.safe_load((layer_dir / text["layer_path"]).read_text(encoding="utf-8"))
        for sentence in data["sentences"]:
            sid = f"{doc}#{sentence['index']}"
            notes = sentence.get("notes")
            divergence = sentence.get("divergence")
            for part_idx, part in enumerate(sentence["parts"]):
                aligned, pairs = align(part["ain"], part["gloss-ja"])
                rows.append({
                    "layer_id": lid,
                    "sentence_id": sid,
                    "part_idx": part_idx,
                    "ain": part["ain"],
                    "gloss": part["gloss-ja"],
                    "interp": part.get("interp-ja"),
                    "aligned": aligned,
                    "pairs": json.dumps(pairs, ensure_ascii=False) if pairs else None,
                    # Sentence-level notes/divergence ride on the first part.
                    "notes": json.dumps(notes, ensure_ascii=False) if notes and part_idx == 0 else None,
                    "divergence": json.dumps(divergence, ensure_ascii=False) if divergence and part_idx == 0 else None,
                })
    return meta, rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layer", action="append", required=True,
                    help="path to an annotations layer directory (repeatable)")
    ap.add_argument("--id", action="append", default=[],
                    help="layer id override, positional per --layer (default: directory name)")
    ap.add_argument("--out", default="build", help="output dir")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    metas, rows = [], []
    for i, layer in enumerate(args.layer):
        override = args.id[i] if i < len(args.id) else None
        meta, layer_rows = build_layer(Path(layer), override)
        metas.append(meta)
        rows.extend(layer_rows)
        aligned = sum(r["aligned"] for r in layer_rows)
        print(f"{meta['id']}: {len(layer_rows)} parts ({aligned} aligned) "
              f"across {len({r['sentence_id'] for r in layer_rows})} sentences")

    with open(out / "gloss_layers.jsonl", "w", encoding="utf-8") as f:
        for m in metas:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    with open(out / "curated_gloss.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {out / 'gloss_layers.jsonl'} + {out / 'curated_gloss.jsonl'}")


if __name__ == "__main__":
    main()
