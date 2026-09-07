#!/usr/bin/env python3
"""Install pinned Linux x86-64 CI tools with recorded archive checksums."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import urllib.request

if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("This bootstrap is pinned to Linux x86-64.")
root = Path(__file__).resolve().parent
sources = json.loads((root / "sources.json").read_text())
target = Path.home() / ".local/bin"
target.mkdir(parents=True, exist_ok=True)
for repo, name, asset in [
    ("gitleaks/gitleaks", "gitleaks", "gitleaks_8.30.1_linux_x64.tar.gz"),
    ("rhysd/actionlint", "actionlint", "actionlint_1.7.12_linux_amd64.tar.gz"),
]:
    metadata = sources[repo]
    url = next(a["browser_download_url"] for a in metadata["assets"] if a["name"] == asset)
    data = urllib.request.urlopen(url, timeout=60).read()
    if hashlib.sha256(data).hexdigest() != metadata["download_sha256"]:
        raise SystemExit(f"Checksum mismatch for {name}")
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        member = next(m for m in archive.getmembers() if Path(m.name).name == name and m.isfile())
        destination = target / name
        destination.write_bytes(archive.extractfile(member).read())
        destination.chmod(0o755)
if os.environ.get("GITHUB_PATH"):
    with open(os.environ["GITHUB_PATH"], "a") as stream:
        stream.write(str(target) + "\n")
