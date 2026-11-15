#!/usr/bin/env python3
"""Package a Fusion add-in repo for a GitHub release.

Run from the root of an add-in repository, with TAG set to the release tag (e.g. v1.3.0).
Writes:
  <Folder>-<TAG>.zip   the add-in folder only, ready to unzip and add in Fusion
  release-notes.md     the CHANGELOG section for this version (or the manifest
                       description), followed by install steps
and, on GitHub Actions, the outputs `zip` and `title`.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

TAG = os.environ.get("TAG") or sys.exit("TAG is not set")
VERSION = re.sub(r"^v", "", TAG, flags=re.I)
ROOT = Path.cwd()


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def find_manifest(files):
    candidates = sorted(
        (f for f in files if f.lower().endswith(".manifest") and Path(f).name.lower() != "app.manifest"),
        key=lambda f: (f.count("/"), f),
    )
    for f in candidates:
        try:
            data = json.loads((ROOT / f).read_text(encoding="utf-8-sig"))
        except (ValueError, OSError):
            continue
        if re.search("fusion", str(data.get("autodeskProduct", "")), re.I) and data.get("type") in ("addin", "script"):
            return f, data
    sys.exit("No Fusion add-in .manifest found in this repository")


def clean_title(t):
    t = re.sub(r"[*_`]", "", t)
    t = re.sub(r"\s*[—–-]\s*(autodesk\s+)?fusion(\s*360)?(\s+add-?in)?\s*$", "", t, flags=re.I)
    t = re.sub(r"\s+for\s+(autodesk\s+)?fusion(\s*360)?\s*$", "", t, flags=re.I)
    return t.strip()


def readme_title(files):
    readme = next((f for f in files if re.fullmatch(r"readme(\.md|\.markdown)?", f, re.I)), None)
    if not readme:
        return None
    m = re.search(r"^#\s+(.+)$", (ROOT / readme).read_text(encoding="utf-8"), re.M)
    return clean_title(m.group(1)) if m else None


def changelog_section(files):
    """The body under the CHANGELOG heading for VERSION, up to the next heading of the same level."""
    log = next((f for f in files if re.fullmatch(r"changelog(\.md)?", f, re.I)), None)
    if not log:
        return None
    lines = (ROOT / log).read_text(encoding="utf-8").splitlines()
    head = re.compile(r"^(#{2,3})\s*\[?v?" + re.escape(VERSION) + r"\]?(?=$|[\s—–(-])", re.I)
    for i, line in enumerate(lines):
        m = head.match(line)
        if not m:
            continue
        level = len(m.group(1))
        body = []
        for nxt in lines[i + 1 :]:
            h = re.match(r"^(#{1,6})\s", nxt)
            if h and len(h.group(1)) <= level:
                break
            body.append(nxt)
        return "\n".join(body).strip() or None
    return None


def main():
    files = tracked_files()
    manifest_path, manifest = find_manifest(files)
    addin_dir = str(Path(manifest_path).parent)
    folder = Path(ROOT.name if addin_dir == "." else addin_dir).name

    manifest_version = str(manifest.get("version", "")).strip()
    if manifest_version and manifest_version.lstrip("vV") != VERSION:
        print(f"::warning::Tag {TAG} does not match the manifest version {manifest_version} in {manifest_path}")

    name = readme_title(files) or re.sub(r"(?<=[a-z])(?=[A-Z])", " ", folder)
    title = f"{name} {TAG}"

    zip_name = f"{folder}-{TAG}.zip"
    tree = "HEAD" if addin_dir == "." else f"HEAD:{addin_dir}"
    subprocess.run(["git", "archive", "--format=zip", f"--prefix={folder}/", "-o", zip_name, tree], check=True)

    desc = manifest.get("description")
    if isinstance(desc, dict):
        desc = desc.get("") or next(iter(desc.values()), "")
    notes = changelog_section(files) or (desc or "").strip()
    kind = "Scripts" if manifest.get("type") == "script" else "Add-Ins"
    startup = "" if manifest.get("type") == "script" else ", and tick **Run on Startup**"
    notes += (
        "\n\n## Install\n\n"
        f"1. Download **{zip_name}** below and unzip it. You get a folder named `{folder}`.\n"
        f"2. In Fusion press **Shift+S** and open the **{kind}** tab.\n"
        f"3. Click the green **+** and pick the `{folder}` folder.\n"
        f"4. Select it, click **Run**{startup}.\n\n"
        "Updating: close Fusion, replace the old folder with the new one, and start Fusion again.\n"
    )
    Path("release-notes.md").write_text(notes.lstrip(), encoding="utf-8")

    print(f"{title}: {zip_name} from {addin_dir}/")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"zip={zip_name}\ntitle={title}\n")


main()
