#!/usr/bin/env python3
"""Read-only audit for production assets and Sites deployment archives."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
TEXT_SUFFIXES = {".js", ".jsx", ".json", ".mjs", ".ts", ".tsx"}
IMAGE_REFERENCE = re.compile(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+\.(?:png|jpe?g|webp)", re.I)


def mib(value: int) -> float:
    return round(value / 1048576, 3)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_reference(value: str) -> str | None:
    normalized = value.lstrip("/")
    if Path(normalized).suffix.lower() in IMAGE_SUFFIXES and "/" in normalized:
        return normalized
    return None


def walk_values(value, references: list[str]) -> None:
    if isinstance(value, str):
        reference = image_reference(value)
        if reference:
            references.append(reference)
    elif isinstance(value, dict):
        for nested in value.values():
            walk_values(nested, references)
    elif isinstance(value, list):
        for nested in value:
            walk_values(nested, references)


def load_runtime_js_references(root: Path) -> list[str]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is required to evaluate JavaScript data modules")
    data_dir = root / "src" / "data"
    modules = sorted(path for path in data_dir.iterdir() if path.suffix in {".js", ".mjs"})
    if not modules:
        return []
    module_urls = [path.resolve().as_uri() for path in modules]
    program = """
const urls = JSON.parse(process.argv[1]);
const refs = [];
const seen = new WeakSet();
function walk(value) {
  if (typeof value === 'string') {
    if (/^[^/]+(?:\\/[^/]+)+\\.(?:png|jpe?g|webp)$/i.test(value)) refs.push(value.replace(/^\\/+/, ''));
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) walk(nested);
}
for (const url of urls) walk(await import(url));
process.stdout.write(JSON.stringify(refs));
"""
    completed = subprocess.run(
        [node, "--input-type=module", "-e", program, json.dumps(module_urls)],
        check=True,
        capture_output=True,
        text=True,
        cwd=root,
    )
    return json.loads(completed.stdout)


def collect_references(root: Path) -> tuple[list[str], list[str]]:
    runtime: list[str] = []
    for path in sorted((root / "src" / "data").glob("*.json")):
        walk_values(json.loads(path.read_text(encoding="utf-8")), runtime)
    runtime.extend(load_runtime_js_references(root))

    lexical: list[str] = []
    for path in sorted((root / "src").rglob("*")):
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            lexical.extend(IMAGE_REFERENCE.findall(path.read_text(encoding="utf-8")))
    return runtime, lexical


def directory_stats(base: Path) -> list[dict]:
    stats = []
    directories = [base, *sorted(path for path in base.rglob("*") if path.is_dir())]
    for directory in directories:
        files = [path for path in directory.rglob("*") if path.is_file()]
        relative = "." if directory == base else directory.relative_to(base).as_posix()
        stats.append({
            "directory": relative,
            "files": len(files),
            "bytes": sum(path.stat().st_size for path in files),
            "mib": mib(sum(path.stat().st_size for path in files)),
        })
    return stats


def compressed_subtree_size(base: Path, directory: Path) -> int:
    with tempfile.NamedTemporaryFile(suffix=".tar.gz") as handle:
        with tarfile.open(handle.name, "w:gz", compresslevel=6) as archive:
            archive.add(directory, arcname=directory.relative_to(base.parent).as_posix())
        return Path(handle.name).stat().st_size


def artifact_directory_stats(dist: Path) -> list[dict]:
    stats = directory_stats(dist)
    by_name = {item["directory"]: item for item in stats}
    # Estimate gzip occupancy for the deploy-relevant roots. A .tar.gz is a solid
    # stream, so exact per-directory attribution is not defined; standalone
    # subtree archives provide a reproducible comparison.
    selected = [dist]
    selected.extend(path for path in dist.iterdir() if path.is_dir())
    client = dist / "client"
    if client.exists():
        selected.extend(path for path in client.iterdir() if path.is_dir())
    server = dist / "server"
    if server.exists():
        selected.extend(path for path in server.iterdir() if path.is_dir())
    for directory in selected:
        key = "." if directory == dist else directory.relative_to(dist).as_posix()
        by_name[key]["standalone_archive_bytes"] = compressed_subtree_size(dist, directory)
        by_name[key]["standalone_archive_mib"] = mib(by_name[key]["standalone_archive_bytes"])
    return stats


def js_stats(dist: Path) -> dict:
    result = {}
    areas = {
        "client": dist / "client",
        "server": dist / "server",
        "server_ssr": dist / "server" / "ssr",
    }
    for label, area in areas.items():
        files = sorted(area.rglob("*.js")) if area.exists() else []
        raw = sum(path.stat().st_size for path in files)
        compressed = sum(len(gzip.compress(path.read_bytes(), compresslevel=6)) for path in files)
        result[label] = {
            "files": len(files),
            "bytes": raw,
            "mib": mib(raw),
            "individual_gzip_bytes": compressed,
            "individual_gzip_mib": mib(compressed),
            "largest": [
                {"path": path.relative_to(dist).as_posix(), "bytes": path.stat().st_size}
                for path in sorted(files, key=lambda item: item.stat().st_size, reverse=True)[:15]
            ],
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    public = root / "public"
    dist = root / "dist"
    images = sorted(
        path for path in public.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )

    runtime_references, lexical_references = collect_references(root)
    runtime_unique = sorted(set(runtime_references))
    lexical_unique = sorted(set(lexical_references))
    all_references = sorted(set(runtime_unique) | set(lexical_unique))
    public_names = {path.relative_to(public).as_posix() for path in images}

    byte_groups: dict[str, list[str]] = defaultdict(list)
    pixel_groups: dict[str, list[str]] = defaultdict(list)
    dimension_counts: Counter[str] = Counter()
    formats: Counter[str] = Counter()
    image_rows = []
    for path in images:
        relative = path.relative_to(public).as_posix()
        size = path.stat().st_size
        digest = sha256_file(path)
        byte_groups[digest].append(relative)
        with Image.open(path) as opened:
            formats[opened.format or "unknown"] += 1
            dimensions = f"{opened.width}x{opened.height}"
            dimension_counts[dimensions] += 1
            rgba = opened.convert("RGBA")
            pixel_digest = hashlib.sha256(
                f"{rgba.width}x{rgba.height}:RGBA:".encode() + rgba.tobytes()
            ).hexdigest()
            pixel_groups[pixel_digest].append(relative)
        image_rows.append({"path": relative, "bytes": size, "dimensions": dimensions})

    exact_duplicates = [paths for paths in byte_groups.values() if len(paths) > 1]
    visual_duplicates = [paths for paths in pixel_groups.values() if len(paths) > 1]
    archive = args.archive.resolve() if args.archive else None
    archive_stats = None
    if archive:
        with tarfile.open(archive, "r:gz") as handle:
            members = [
                member for member in handle.getmembers()
                if not any(part.startswith("._") for part in Path(member.name).parts)
            ]
        archive_stats = {
            "path": str(archive),
            "bytes": archive.stat().st_size,
            "mib": mib(archive.stat().st_size),
            "entries": len(members),
            "files": sum(member.isfile() for member in members),
            "logical_bytes": sum(member.size for member in members if member.isfile()),
            "logical_mib": mib(sum(member.size for member in members if member.isfile())),
        }

    report = {
        "archive": archive_stats,
        "public_directories": directory_stats(public),
        "artifact_directories": artifact_directory_stats(dist) if dist.exists() else [],
        "images": {
            "files": len(images),
            "bytes": sum(path.stat().st_size for path in images),
            "mib": mib(sum(path.stat().st_size for path in images)),
            "formats": dict(sorted(formats.items())),
            "runtime_reference_occurrences": len(runtime_references),
            "runtime_referenced_unique": len(runtime_unique),
            "lexical_referenced_unique": len(lexical_unique),
            "referenced_existing_unique": len(set(all_references) & public_names),
            "unreferenced_unique": len(public_names - set(all_references)),
            "unreferenced": sorted(public_names - set(all_references)),
            "missing_references": sorted(set(all_references) - public_names),
            "exact_duplicate_groups": exact_duplicates,
            "visual_duplicate_groups": visual_duplicates,
            "dimensions": dict(dimension_counts.most_common()),
            "over_500_kib": [row for row in sorted(image_rows, key=lambda item: item["bytes"], reverse=True) if row["bytes"] > 500 * 1024],
            "over_1_mib": [row for row in sorted(image_rows, key=lambda item: item["bytes"], reverse=True) if row["bytes"] > 1024 * 1024],
        },
        "javascript": js_stats(dist) if dist.exists() else {},
        "largest_artifact_files": [
            {"path": path.relative_to(dist).as_posix(), "bytes": path.stat().st_size}
            for path in sorted((path for path in dist.rglob("*") if path.is_file()), key=lambda item: item.stat().st_size, reverse=True)[:50]
        ] if dist.exists() else [],
    }

    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + os.linesep, encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
