#!/usr/bin/env python3
"""Build the ChatGPT release artifact with only Python's standard library."""
import argparse
import json
from pathlib import Path
import re
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
# Explicit inputs prevent local config, credentials, hooks, or worktrees leaking.
FILES = {
    "plugin.json": "adapters/chatgpt/plugin.json",
    "mcp.json": "adapters/chatgpt/mcp.json",
    "assets/icon.png": "adapters/chatgpt/assets/icon.png",
    "skills/spor/SKILL.md": "adapters/chatgpt/skills/spor/SKILL.md",
    "skills/workspace-onboarding/SKILL.md": "adapters/chatgpt/skills/workspace-onboarding/SKILL.md",
    "skills/workspace-onboarding/references/factory-worker.md": "adapters/chatgpt/skills/workspace-onboarding/references/factory-worker.md",
    "LICENSE": "LICENSE",
    "NOTICE": "NOTICE",
}


def build(root, output, tag=None):
    version = json.loads((root / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid package version")
    if tag is not None and tag != "v" + version:
        raise ValueError("Release tag does not match package version")
    for name in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "package-lock.json"):
        if json.loads((root / name).read_text())["version"] != version:
            raise ValueError(f"Version mismatch: {name}")
    entries = {}
    for destination, source in FILES.items():
        file = root / source
        if any(p.is_symlink() for p in [file, *file.parents] if p != root.parent):
            raise ValueError(f"Symlink input: {source}")
        entries["spor/" + destination] = file.read_bytes()
    manifest = json.loads(entries["spor/plugin.json"])
    manifest["version"] = version
    if manifest["name"] != "spor":
        raise ValueError("Plugin name must match its archive directory")
    if len(manifest["extensions"]["com.openai"]["interface"]["shortDescription"]) > 30:
        raise ValueError("Plugin subtitle exceeds 30 characters")
    for field in ("logo", "composerIcon"):
        asset = manifest["extensions"]["com.openai"]["interface"].get(field)
        if not isinstance(asset, str) or not asset.startswith("./assets/") or "spor/" + asset[2:] not in entries:
            raise ValueError(f"{field} must point to a packaged branding asset")
        # This package uses a PNG for both icons. Validate the IHDR before shipping.
        data = entries["spor/" + asset[2:]]
        if not asset.endswith(".png") or len(data) < 33 or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
            raise ValueError(f"{field} must be a PNG with a valid image header")
        width, height = struct.unpack(">II", data[16:24])
        if width != height or not 48 <= width <= 4096 or len(data) > 5 * 1024 * 1024:
            raise ValueError(f"{field} must be square, 48..4096 pixels, and at most 5 MiB")
    onboarding = manifest["extensions"]["com.openai"].get("onboardingSkill")
    if onboarding is not None and (
        not isinstance(onboarding, str)
        or not onboarding.startswith("./skills/")
        or not onboarding.endswith("/SKILL.md")
        or "spor/" + onboarding[2:] not in entries
    ):
        raise ValueError("onboardingSkill must point to a packaged skill")
    entries["spor/plugin.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Fixed timestamps, order, and permissions make rebuilds reproducible.
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist/chatgpt/plugin.zip")
    parser.add_argument("--tag", help="Expected release tag (vX.Y.Z)")
    args = parser.parse_args()
    print(build(ROOT, args.output.resolve(), args.tag))
