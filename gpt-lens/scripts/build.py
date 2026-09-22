#!/usr/bin/env python3
"""Build a reproducible Chrome extension directory and ZIP for GPT Lens."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
BUILD_DIR = DIST / "gpt-lens"
MANIFEST = ROOT / "manifest.json"
PLACEHOLDER_CLIENT_ID = "000000000000-gpt-lens-placeholder.apps.googleusercontent.com"
FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)

INCLUDE = (
    Path("manifest.json"),
    Path("src/content.js"),
    Path("src/model-utils.js"),
    Path("src/page-bridge.js"),
    Path("src/route-parser.js"),
    Path("src/service-worker.js"),
    Path("src/ui.css"),
    Path("icons/icon16.png"),
    Path("icons/icon32.png"),
    Path("icons/icon48.png"),
    Path("icons/icon128.png"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build GPT Lens as a Chrome extension package.")
    parser.add_argument(
        "--oauth-client-id",
        default=os.environ.get("GPT_LENS_GOOGLE_CLIENT_ID"),
        help="Optional Google OAuth client ID. Defaults to GPT_LENS_GOOGLE_CLIENT_ID.",
    )
    return parser.parse_args()


def read_manifest() -> dict:
    with MANIFEST.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        raise SystemExit("manifest.json is missing a valid version")
    return manifest


def clean_dist() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    BUILD_DIR.mkdir(parents=True)


def copy_extension_files() -> None:
    for relative in INCLUDE:
        source = ROOT / relative
        if not source.is_file():
            raise SystemExit(f"Missing extension file: {relative}")
        target = BUILD_DIR / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def configure_manifest(manifest: dict, oauth_client_id: str | None) -> None:
    output = dict(manifest)
    if oauth_client_id:
        oauth = dict(output.get("oauth2") or {})
        oauth["client_id"] = oauth_client_id
        output["oauth2"] = oauth

    with (BUILD_DIR / "manifest.json").open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(output, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def validate_build(manifest: dict) -> None:
    with (BUILD_DIR / "manifest.json").open("r", encoding="utf-8") as handle:
        built_manifest = json.load(handle)

    if built_manifest.get("manifest_version") != 3:
        raise SystemExit("Built extension is not Manifest V3")
    if built_manifest.get("version") != manifest.get("version"):
        raise SystemExit("Built manifest version does not match source manifest")

    for relative in INCLUDE:
        if not (BUILD_DIR / relative).is_file():
            raise SystemExit(f"Built extension is missing: {relative}")

    declared = set()
    for item in built_manifest.get("content_scripts", []):
        declared.update(item.get("js", []))
        declared.update(item.get("css", []))
    background = built_manifest.get("background", {}).get("service_worker")
    if background:
        declared.add(background)
    for relative in declared:
        if not (BUILD_DIR / relative).is_file():
            raise SystemExit(f"Manifest references missing file: {relative}")


def write_zip(version: str) -> Path:
    zip_path = DIST / f"gpt-lens-v{version}.zip"
    files = sorted(path for path in BUILD_DIR.rglob("*") if path.is_file())

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            relative = path.relative_to(BUILD_DIR).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, path.read_bytes())

    return zip_path


def main() -> int:
    args = parse_args()
    manifest = read_manifest()
    clean_dist()
    copy_extension_files()
    configure_manifest(manifest, args.oauth_client_id)
    validate_build(manifest)
    zip_path = write_zip(manifest["version"])

    client_id = (args.oauth_client_id or manifest.get("oauth2", {}).get("client_id"))
    print(f"Built unpacked extension: {BUILD_DIR}")
    print(f"Built release package:   {zip_path}")
    if client_id == PLACEHOLDER_CLIENT_ID:
        print(
            "Note: Google Drive sync uses the placeholder OAuth client ID. "
            "Set GPT_LENS_GOOGLE_CLIENT_ID or pass --oauth-client-id for a distributable OAuth-enabled build.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
