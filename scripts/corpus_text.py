"""Resolve additive corpus text layers while preserving the source reading.

The API's token and POS builds must select text identically.  This module is
the single join point for ainu-corpora rows and annotation sidecars.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class ResolvedText:
    text: str
    legacy_text: str | None
    text_layer: str | None
    text_layer_status: str | None


@dataclass(frozen=True)
class _LayerEntry:
    source: str
    modern: str


class ModernTextLayer:
    """A validated ``modern-orthography-latn`` annotation directory."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.entries: dict[str, _LayerEntry] = {}
        self.applied: set[str] = set()
        layer_ids: set[str] = set()

        manifest_path = self.root / "manifest.yaml"
        if not manifest_path.is_file():
            raise ValueError(f"missing layer manifest: {manifest_path}")
        manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema") != 1:
            raise ValueError("unsupported layer manifest schema")
        self.status = manifest.get("status")
        if self.status not in {"provisional", "reviewed"}:
            raise ValueError(f"invalid layer status: {self.status!r}")
        manifest_id = f"{manifest.get('layer')}@{manifest.get('version')}"

        paths = sorted(self.root.glob("*/*.yaml"))
        if not paths:
            raise ValueError(f"no layer YAML files found under {self.root}")

        for path in paths:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
            layer = doc.get("layer")
            version = doc.get("version")
            source_path = doc.get("path")
            if not layer or version is None or not source_path:
                raise ValueError(f"incomplete layer metadata: {path}")
            layer_ids.add(f"{layer}@{version}")
            if not source_path.startswith("texts/") or not source_path.endswith(".yaml"):
                raise ValueError(f"invalid corpus path in {path}: {source_path!r}")
            document_id = source_path.removeprefix("texts/").removesuffix(".yaml")
            for sentence in doc.get("sentences", []):
                sid = f"{document_id}#{sentence['index']}"
                if sid in self.entries:
                    raise ValueError(f"duplicate layer sentence: {sid}")
                source = sentence.get("ain")
                modern = sentence.get("ain-modern")
                if not isinstance(source, str) or not isinstance(modern, str):
                    raise ValueError(f"missing text for layer sentence: {sid}")
                self.entries[sid] = _LayerEntry(source=source, modern=modern)

        if len(layer_ids) != 1:
            raise ValueError(f"mixed layer identities: {sorted(layer_ids)}")
        self.layer_id = next(iter(layer_ids))
        if self.layer_id != manifest_id:
            raise ValueError(f"manifest identity {manifest_id} differs from {self.layer_id}")

    def resolve(self, sentence_id: str, source_text: str) -> ResolvedText:
        entry = self.entries.get(sentence_id)
        if entry is None:
            return ResolvedText(source_text, None, None, None)
        if entry.source != source_text:
            raise ValueError(
                f"layer/source mismatch for {sentence_id}: "
                f"layer={entry.source!r}, corpus={source_text!r}"
            )
        self.applied.add(sentence_id)
        return ResolvedText(entry.modern, source_text, self.layer_id, self.status)

    def validate_complete(self) -> None:
        missing = sorted(self.entries.keys() - self.applied)
        if missing:
            sample = ", ".join(missing[:5])
            raise ValueError(
                f"{len(missing)} layer sentences were not found in the corpus"
                f" (first: {sample})"
            )
