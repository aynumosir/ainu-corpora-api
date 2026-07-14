from pathlib import Path
import sys
import tempfile
import unittest

import yaml

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from corpus_text import ModernTextLayer  # noqa: E402


class ModernTextLayerTest(unittest.TestCase):
    def make_layer(self, root: Path) -> Path:
        path = root / "mat" / "001.yaml"
        path.parent.mkdir(parents=True)
        path.write_text(
            yaml.safe_dump(
                {
                    "layer": "modern-orthography-latn",
                    "version": 1,
                    "path": "texts/bible/mat/001.yaml",
                    "sentences": [
                        {"index": 1, "ain": "Kamui", "ain-modern": "Kamuy"},
                    ],
                },
                allow_unicode=True,
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return root

    def test_resolves_layer_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            layer = ModernTextLayer(self.make_layer(Path(tmp)))
            resolved = layer.resolve("bible/mat/001#1", "Kamui")
            self.assertEqual(resolved.text, "Kamuy")
            self.assertEqual(resolved.legacy_text, "Kamui")
            self.assertEqual(resolved.text_layer, "modern-orthography-latn@1")
            layer.validate_complete()

    def test_rejects_stale_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            layer = ModernTextLayer(self.make_layer(Path(tmp)))
            with self.assertRaisesRegex(ValueError, "layer/source mismatch"):
                layer.resolve("bible/mat/001#1", "Kamuy")

    def test_requires_complete_corpus_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            layer = ModernTextLayer(self.make_layer(Path(tmp)))
            with self.assertRaisesRegex(ValueError, "1 layer sentences"):
                layer.validate_complete()


if __name__ == "__main__":
    unittest.main()
