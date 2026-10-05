"""Inspect the actual ZIP and exercise release guard failures."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_chatgpt", ROOT / "scripts/package-chatgpt.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        inputs = set(packager.FILES.values()) | {
            "package.json", "package-lock.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"
        }
        for source in inputs:
            destination = self.root / source
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / source, destination)
        self.version = json.loads((self.root / "package.json").read_text())["version"]

    def test_archive_contract_and_reproducibility(self):
        # A tempting unrelated file must never enter the package.
        (self.root / "adapters/chatgpt/.env").write_text("SECRET=do-not-package")
        first = packager.build(self.root, self.root / "one.zip", "v" + self.version)
        second = packager.build(self.root, self.root / "two.zip")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), {
                "spor/plugin.json", "spor/mcp.json", "spor/skills/spor/SKILL.md", "spor/LICENSE", "spor/NOTICE"
            })
            manifest = json.loads(archive.read("spor/plugin.json"))
            self.assertEqual(manifest["version"], self.version)
            self.assertEqual(manifest["name"], "spor")
            self.assertNotIn("apps", manifest["extensions"]["com.openai"])
            mcp = json.loads(archive.read("spor/mcp.json"))
            self.assertEqual(mcp["mcpServers"]["spor"], {
                "type": "streamable-http", "url": "https://mcp.sporhq.io/mcp"
            })
            self.assertTrue(archive.read("spor/skills/spor/SKILL.md").startswith(b"---\nname: spor\n"))

    def test_bad_tag_cannot_produce_archive(self):
        output = self.root / "plugin.zip"
        with self.assertRaisesRegex(ValueError, "tag"):
            packager.build(self.root, output, "v999.0.0")
        self.assertFalse(output.exists())

    def test_version_drift_cannot_produce_archive(self):
        (self.root / ".codex-plugin/plugin.json").write_text('{"version":"999.0.0"}')
        with self.assertRaisesRegex(ValueError, "Version mismatch"):
            packager.build(self.root, self.root / "plugin.zip")

    def test_symlink_input_rejected(self):
        source = self.root / "adapters/chatgpt/skills/spor/SKILL.md"
        source.unlink()
        source.symlink_to(self.root / "package.json")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            packager.build(self.root, self.root / "plugin.zip")


if __name__ == "__main__":
    unittest.main()
