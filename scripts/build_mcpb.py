"""Package warlock-gis-mcp as a Claude Desktop extension (.mcpb).

An .mcpb file is a zip archive with manifest.json at its root. This script
uses the Python standard library only (works with the ArcGIS Pro Python
already on the workstation), makes no network calls, and never connects to
a geodatabase. Same approach as warlock-jira-mcp.

Usage (from the project folder):
    "C:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\arcgispro-py3\\python.exe" scripts\\build_mcpb.py
Output:
    dist\\warlock-gis-mcp-<version>.mcpb  (and its SHA-256)

The build is reproducible: entries are stored uncompressed with a fixed
timestamp, so the same source files always give the same SHA-256.
"""

import hashlib
import json
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Only these files go into the bundle: the runtime files, nothing else.
# Never the .sde connection, local config, credentials, logs, tests,
# node_modules, or any machine-specific data.
INCLUDE = [
    "manifest.json",
    "package.json",
    "server/index.js",
    "server/core.js",
    "worker/inspect_dataset.py",
]

FORBIDDEN_NAME = re.compile(
    r"(\.sde$|(^|/)config\.json$|\.log$|\.env|secret|credential|token|node_modules)",
    re.IGNORECASE,
)

# An actual Windows path to a connection file inside any bundled file.
FORBIDDEN_CONTENT = re.compile(rb"[A-Za-z]:\\[^\r\n\"']*\.sde\b", re.IGNORECASE)

FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def fail(message):
    sys.exit(f"BUILD REFUSED: {message}")


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = manifest["version"]

    if package.get("version") != version:
        fail("package.json and manifest.json versions differ")
    if package.get("dependencies"):
        fail("package.json declares dependencies; the bundle has no node_modules")
    if manifest.get("compatibility", {}).get("platforms") != ["win32"]:
        fail("manifest must be Windows-only")
    if [t.get("name") for t in manifest.get("tools", [])] != ["inspect_gis_dataset"]:
        fail("manifest must declare exactly one tool: inspect_gis_dataset")

    files = []
    for rel in INCLUDE:
        path = ROOT / rel
        if FORBIDDEN_NAME.search(rel):
            fail(f"forbidden file name: {rel}")
        if path.is_symlink() or not path.is_file():
            fail(f"missing or not a regular file: {rel}")
        if ROOT not in path.resolve().parents:
            fail(f"outside the project folder: {rel}")
        data = path.read_bytes()
        if FORBIDDEN_CONTENT.search(data):
            fail(f"connection file path found in: {rel}")
        files.append((rel, data))

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / f"warlock-gis-mcp-{version}.mcpb"

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:
        for rel, data in files:
            info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)  # forward slashes
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    # Verify what was written.
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        if names != INCLUDE:
            out.unlink()
            fail(f"unexpected bundle contents: {names}")
        if zf.testzip() is not None:
            out.unlink()
            fail("bundle failed its integrity check")

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"Built {out}")
    for name in names:
        print(f"  {name}")
    print(f"SHA-256 {digest}")


if __name__ == "__main__":
    main()
