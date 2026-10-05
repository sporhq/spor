#!/usr/bin/env python3
"""Build the ChatGPT release artifact with only Python's standard library."""
import argparse
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
# Explicit inputs prevent local config, credentials, hooks, or worktrees leaking.
FILES = {
    "plugin.json": "adapters/chatgpt/plugin.json",
    "mcp.json": "adapters/chatgpt/mcp.json",
    "skills/spor/SKILL.md": "adapters/chatgpt/skills/spor/SKILL.md",
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
