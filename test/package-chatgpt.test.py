"""Inspect the actual ZIP and exercise release guard failures."""
import importlib.util
import json
from pathlib import Path
import shutil
import struct
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
                "spor/plugin.json", "spor/mcp.json", "spor/skills/spor/SKILL.md",
                "spor/assets/icon.png",
                "spor/skills/workspace-onboarding/SKILL.md",
                "spor/skills/workspace-onboarding/references/factory-worker.md",
                "spor/LICENSE", "spor/NOTICE"
            })
            manifest = json.loads(archive.read("spor/plugin.json"))
            self.assertEqual(manifest["version"], self.version)
            self.assertEqual(manifest["name"], "spor")
            self.assertNotIn("apps", manifest["extensions"]["com.openai"])
            for field in ("logo", "composerIcon"):
                asset = manifest["extensions"]["com.openai"]["interface"][field]
                data = archive.read("spor/" + asset[2:])
                self.assertEqual(data, (self.root / "adapters/chatgpt" / asset).read_bytes())
                self.assertEqual(struct.unpack(">II", data[16:24]), (512, 512))
            onboarding = manifest["extensions"]["com.openai"]["onboardingSkill"]
            self.assertEqual(onboarding, "./skills/workspace-onboarding/SKILL.md")
            self.assertEqual(archive.read("spor/" + onboarding[2:]),
                             (self.root / "adapters/chatgpt" / onboarding).read_bytes())
            reference = "skills/workspace-onboarding/references/factory-worker.md"
            self.assertEqual(archive.read("spor/" + reference),
                             (self.root / "adapters/chatgpt" / reference).read_bytes())
            mcp = json.loads(archive.read("spor/mcp.json"))
            self.assertEqual(mcp["mcpServers"]["spor"], {
                "type": "streamable-http", "url": "https://mcp.sporhq.io/mcp"
            })
            self.assertTrue(archive.read("spor/skills/spor/SKILL.md").startswith(b"---\nname: spor\n"))

    def test_unbundled_onboarding_cannot_produce_archive(self):
        source = self.root / "adapters/chatgpt/plugin.json"
        manifest = json.loads(source.read_text())
        for path in ("./skills/missing/SKILL.md", "/skills/spor/SKILL.md",
                     "./skills/../plugin.json", 42):
            with self.subTest(path=path):
                manifest["extensions"]["com.openai"]["onboardingSkill"] = path
                source.write_text(json.dumps(manifest))
                output = self.root / "plugin.zip"
                with self.assertRaisesRegex(ValueError, "onboardingSkill"):
                    packager.build(self.root, output)
                self.assertFalse(output.exists())

    def test_missing_branding_cannot_produce_archive(self):
        source = self.root / "adapters/chatgpt/plugin.json"
        original = json.loads(source.read_text())
        for field in ("logo", "composerIcon"):
            for value in (None, "./assets/missing.png"):
                with self.subTest(field=field, value=value):
                    manifest = json.loads(json.dumps(original))
                    if value is None:
                        del manifest["extensions"]["com.openai"]["interface"][field]
                    else:
                        manifest["extensions"]["com.openai"]["interface"][field] = value
                    source.write_text(json.dumps(manifest))
                    output = self.root / "plugin.zip"
                    with self.assertRaisesRegex(ValueError, field):
                        packager.build(self.root, output)
                    self.assertFalse(output.exists())

    def test_invalid_branding_dimensions_cannot_produce_archive(self):
        icon = self.root / "adapters/chatgpt/assets/icon.png"
        original = icon.read_bytes()
        for width, height in ((32, 32), (512, 256), (4097, 4097)):
            with self.subTest(width=width, height=height):
                icon.write_bytes(original[:16] + struct.pack(">II", width, height) + original[24:])
                with self.assertRaisesRegex(ValueError, "square"):
                    packager.build(self.root, self.root / "plugin.zip")

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
