#!/usr/bin/env python3
"""Rebuild an AoI SQLite catalog from files retained in a DATA_DIR.

Copy this script into the affected AoI data directory and run:

    python3 recover-aoi-data.py

The script is intentionally non-destructive. It reads the existing directories
and databases, then writes a new database and reports below a timestamped
``aoi-recovery-*`` directory. It never replaces ``db/packdb.sqlite``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any, Iterable


SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
ARCHIVE_SUFFIXES = {".zip", ".rar", ".7z"}
MIGRATIONS = [
    "001_add_compressed_size",
    "002_add_structure_type",
    "003_add_blurhashes_and_backfill",
    "004_add_source_type",
    "005_add_pack_files",
    "006_cleanup_orphaned_relations",
]
DEFAULT_OPTIONS = {
    "format": "jpeg",
    "quality": 80,
    "keepVideos": True,
    "scaleImages": True,
    "maxDimension": 1920,
}
RECOVERY_NAMESPACE = uuid.UUID("1c3d1028-6d52-4eb7-964a-35804e96511a")

FINAL_SCHEMA = """
CREATE TABLE packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
  image_count INTEGER DEFAULT 0,
  video_count INTEGER DEFAULT 0,
  total_images_size INTEGER DEFAULT 0,
  total_videos_size INTEGER DEFAULT 0,
  error_message TEXT,
  archive_password TEXT,
  compressed_size INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  structure_type TEXT DEFAULT 'flat',
  blurhashes TEXT DEFAULT NULL,
  source_type TEXT NOT NULL DEFAULT 'archive'
);

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  options TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  pack_id TEXT,
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  offset INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pack_tags (
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (pack_id, tag_id)
);

CREATE TABLE pack_files (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_at TEXT
);

CREATE TABLE migrations (
  name TEXT PRIMARY KEY,
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_packs_created_at ON packs(created_at DESC);
CREATE INDEX idx_jobs_pack_id ON jobs(pack_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE UNIQUE INDEX idx_presets_default ON presets(is_default) WHERE is_default = 1;
CREATE INDEX idx_pack_tags_tag_id ON pack_tags(tag_id);
CREATE INDEX idx_pack_files_pack_id ON pack_files(pack_id);
"""


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def sqlite_time(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def parse_time(value: Any, fallback: float = 0.0) -> float:
    if not isinstance(value, str) or not value.strip():
        return fallback
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return fallback


def safe_text(value: Any, fallback: str, maximum: int = 255) -> str:
    if not isinstance(value, str):
        return fallback
    value = value.replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    return value[:maximum] or fallback


def safe_integer(value: Any, fallback: int = 0) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        result = int(value)
    except (TypeError, ValueError):
        return fallback
    return result if result >= 0 else fallback


def safe_relative_path(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 1024:
        return None
    portable = value.replace("\\", "/")
    if portable.startswith("/") or re.match(r"^[A-Za-z]:/", portable):
        return None
    parts = portable.split("/")
    if any(
        part in {"", ".", ".."}
        or len(part.encode("utf-8")) > 255
        or any(ord(character) < 32 for character in part)
        for part in parts
    ):
        return None
    return "/".join(parts)


def relative_display(path: Path, data_dir: Path) -> str:
    try:
        return path.relative_to(data_dir).as_posix()
    except ValueError:
        return str(path)


def regular_files(root: Path) -> list[tuple[Path, str, int]]:
    if not root.is_dir() or root.is_symlink():
        return []
    result: list[tuple[Path, str, int]] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        directory_names[:] = [
            name
            for name in directory_names
            if not (current_path / name).is_symlink()
            and name != "__MACOSX"
        ]
        for name in file_names:
            if name.startswith("._"):
                continue
            candidate = current_path / name
            try:
                if candidate.is_symlink() or not candidate.is_file():
                    continue
                stat = candidate.stat()
            except OSError:
                continue
            result.append((candidate, candidate.relative_to(root).as_posix(), stat.st_size))
    return result


def directory_ids(data_dir: Path, skipped: list[dict[str, str]]) -> set[str]:
    ids: set[str] = set()
    for directory_name in ("archives", "extracted", "generated", "thumbnails"):
        base = data_dir / directory_name
        if not base.is_dir():
            continue
        for child in base.iterdir():
            if not child.is_dir() or child.is_symlink():
                continue
            if SAFE_ID.fullmatch(child.name):
                ids.add(child.name)
            else:
                skipped.append({
                    "path": relative_display(child, data_dir),
                    "reason": "directory name is not a safe AoI pack id",
                })
    return ids


def database_candidates(data_dir: Path, output_dir: Path) -> list[Path]:
    candidates: set[Path] = set()
    patterns = (
        data_dir / "db",
        data_dir / "backups",
        data_dir,
    )
    for base in patterns:
        if not base.is_dir():
            continue
        for candidate in base.glob("*.sqlite"):
            resolved = candidate.resolve()
            if (
                candidate.is_file()
                and candidate.name != "instance-lock.sqlite"
                and output_dir not in resolved.parents
            ):
                candidates.add(resolved)
    return sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True)


def table_rows(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if not exists:
        return []
    try:
        cursor = connection.execute(f'SELECT * FROM "{table}"')
        columns = [description[0] for description in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]
    except sqlite3.DatabaseError:
        return []


def snapshot_database(source: Path, temporary_root: Path) -> Path:
    snapshot_dir = temporary_root / f"{len(list(temporary_root.iterdir())):04d}"
    snapshot_dir.mkdir(mode=0o700)
    destination = snapshot_dir / source.name
    shutil.copy2(source, destination)
    for suffix in ("-wal", "-shm"):
        companion = Path(str(source) + suffix)
        if companion.is_file():
            shutil.copy2(companion, Path(str(destination) + suffix))
    return destination


def collect_database_metadata(
    data_dir: Path,
    output_dir: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    collected: dict[str, Any] = {
        "packs": {},
        "tags": {},
        "pack_tags": set(),
        "presets": {},
        "pack_files": {},
    }
    reports: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix=".db-snapshots-", dir=output_dir) as temporary:
        temporary_root = Path(temporary)
        for source in database_candidates(data_dir, output_dir):
            report: dict[str, Any] = {
                "path": relative_display(source, data_dir),
                "size": source.stat().st_size,
                "usable": False,
            }
            if source.stat().st_size < 100:
                report["error"] = "empty or too small to be a SQLite database"
                reports.append(report)
                continue
            try:
                snapshot = snapshot_database(source, temporary_root)
                connection = sqlite3.connect(
                    f"file:{snapshot.as_posix()}?mode=ro", uri=True, timeout=1
                )
                quick_check = connection.execute("PRAGMA quick_check").fetchone()
                if not quick_check or quick_check[0] != "ok":
                    raise sqlite3.DatabaseError(
                        f"quick_check returned {quick_check[0] if quick_check else 'no result'}"
                    )
                source_mtime = source.stat().st_mtime
                source_label = relative_display(source, data_dir)
                report["usable"] = True

                for table, key_column in (
                    ("packs", "id"),
                    ("tags", "id"),
                    ("presets", "id"),
                    ("pack_files", "id"),
                ):
                    rows = table_rows(connection, table)
                    report[f"{table}_rows"] = len(rows)
                    for row in rows:
                        key = row.get(key_column)
                        if not isinstance(key, str) or not key:
                            continue
                        if table in {"packs", "pack_files"}:
                            pack_id = key if table == "packs" else row.get("pack_id")
                            if not isinstance(pack_id, str) or not SAFE_ID.fullmatch(pack_id):
                                continue
                        row["_source"] = source_label
                        row["_source_mtime"] = source_mtime
                        existing = collected[table].get(key)
                        row_rank = (
                            parse_time(row.get("updated_at") or row.get("uploaded_at"), source_mtime),
                            source_mtime,
                        )
                        existing_rank = (
                            parse_time(
                                existing.get("updated_at") or existing.get("uploaded_at"),
                                existing.get("_source_mtime", 0),
                            ),
                            existing.get("_source_mtime", 0),
                        ) if existing else (-1.0, -1.0)
                        if row_rank >= existing_rank:
                            collected[table][key] = row

                relations = table_rows(connection, "pack_tags")
                report["pack_tags_rows"] = len(relations)
                for relation in relations:
                    pack_id = relation.get("pack_id")
                    tag_id = relation.get("tag_id")
                    if (
                        isinstance(pack_id, str)
                        and SAFE_ID.fullmatch(pack_id)
                        and isinstance(tag_id, str)
                    ):
                        collected["pack_tags"].add((pack_id, tag_id))
                connection.close()
            except (OSError, sqlite3.DatabaseError) as error:
                report["error"] = str(error)
            reports.append(report)
    return collected, reports


def choose_archive(archive_dir: Path) -> Path | None:
    if not archive_dir.is_dir():
        return None
    candidates: list[Path] = []
    for candidate in archive_dir.iterdir():
        try:
            if (
                candidate.is_file()
                and not candidate.is_symlink()
                and candidate.stat().st_size > 0
                and not candidate.name.endswith(".tmp")
            ):
                candidates.append(candidate)
        except OSError:
            continue
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (
            item.name.lower().startswith("original."),
            item.suffix.lower() in ARCHIVE_SUFFIXES,
            item.stat().st_size,
        ),
    )


def find_7z() -> str | None:
    for command in ("7z", "7zz", "7za"):
        executable = shutil.which(command)
        if executable:
            return executable
    return None


def test_with_7z(
    executable: str,
    archive: Path,
    password: str | None,
) -> tuple[str, str]:
    arguments = [executable, "t"]
    if password is not None:
        arguments.append(f"-p{password}")
    arguments.append(str(archive))
    try:
        result = subprocess.run(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=30 * 60,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "error", "7z verification timed out"
    except OSError as error:
        return "error", f"failed to run 7z: {error}"

    if result.returncode == 0:
        return "valid", "7z tested the archive successfully"
    output = result.stdout.lower()
    password_markers = (
        "wrong password",
        "password is incorrect",
        "can not open encrypted archive",
        "data error in encrypted file",
        "encrypted",
        "enter password",
    )
    if any(marker in output for marker in password_markers):
        return "password-required" if password is None else "invalid", "archive rejected the password"
    return "error", "archive test failed; the archive may be damaged or unsupported"


def zip_password_requirement(archive: Path) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(archive) as zip_file:
            encrypted = [
                entry
                for entry in zip_file.infolist()
                if not entry.is_dir() and entry.flag_bits & 0x1
            ]
            if not encrypted:
                return "not-required", "ZIP has no encrypted file entries"
            return "password-required", "ZIP contains encrypted file entries"
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        return "error", f"cannot inspect ZIP: {error}"


def verify_zip_password(archive: Path, password: str) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(archive) as zip_file:
            encrypted = [
                entry
                for entry in zip_file.infolist()
                if not entry.is_dir() and entry.flag_bits & 0x1
            ]
            if not encrypted:
                return "not-required", "ZIP has no encrypted file entries"
            # Reading the smallest encrypted entry through EOF verifies both the
            # password header and CRC, avoiding a false positive from a header-only test.
            target = min(encrypted, key=lambda entry: entry.file_size)
            with zip_file.open(target, "r", pwd=password.encode("utf-8")) as source:
                while source.read(1024 * 1024):
                    pass
        return "valid", "ZIP password and CRC were verified"
    except NotImplementedError:
        return "unsupported", "ZIP encryption method requires 7z verification"
    except RuntimeError as error:
        if "password" in str(error).lower():
            return "invalid", "ZIP rejected the password"
        return "error", f"ZIP verification failed: {error}"
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        return "error", f"ZIP verification failed: {error}"


def password_requirement(archive: Path, seven_zip: str | None) -> tuple[str, str]:
    if archive.suffix.lower() == ".zip":
        return zip_password_requirement(archive)
    if not seven_zip:
        return "unavailable", "7z/7zz/7za is required to inspect this archive format"
    status, message = test_with_7z(seven_zip, archive, None)
    if status == "valid":
        return "not-required", message
    return status, message


def verify_archive_password(
    archive: Path,
    password: str,
    seven_zip: str | None,
) -> tuple[str, str]:
    if archive.suffix.lower() == ".zip":
        status, message = verify_zip_password(archive, password)
        if status != "unsupported":
            return status, message
    if not seven_zip:
        return "unavailable", "7z/7zz/7za is required to verify this encryption method"
    return test_with_7z(seven_zip, archive, password)


def collect_interactive_passwords(
    data_dir: Path,
    packs: dict[str, dict[str, Any]],
    details: list[dict[str, Any]],
    enabled: bool,
) -> None:
    details_by_id = {detail["id"]: detail for detail in details}
    seven_zip = find_7z()

    for pack_id, pack in packs.items():
        detail = details_by_id[pack_id]
        if pack["status"] not in {"uploading", "failed"} or pack["source_type"] != "archive":
            pack["archive_password"] = None
            detail["passwordRecovery"] = {
                "status": "not-needed",
                "message": "retained extracted/generated data does not require re-extraction",
            }
            continue

        archive = choose_archive(data_dir / "archives" / pack_id)
        if not archive:
            pack["archive_password"] = None
            detail["passwordRecovery"] = {
                "status": "not-applicable",
                "message": "no retained source archive was found",
            }
            continue

        requirement, requirement_message = password_requirement(archive, seven_zip)
        if requirement == "not-required":
            pack["archive_password"] = None
            detail["passwordRecovery"] = {
                "status": "not-required",
                "message": requirement_message,
            }
            continue
        if requirement == "error":
            pack["archive_password"] = None
            detail["passwordRecovery"] = {
                "status": "verification-error",
                "message": requirement_message,
            }
            continue
        if requirement == "unavailable":
            pack["archive_password"] = None
            detail["passwordRecovery"] = {
                "status": "verification-unavailable",
                "message": requirement_message,
            }
            if enabled:
                print(
                    f"\n[{pack_id}] {pack['name']}\n"
                    f"  Archive: {relative_display(archive, data_dir)}\n"
                    f"  Cannot verify a password: {requirement_message}\n"
                    "  Skipped; install 7z and run the recovery script again."
                )
            continue

        existing_password = pack.get("archive_password")
        if isinstance(existing_password, str) and existing_password:
            status, message = verify_archive_password(
                archive, existing_password, seven_zip
            )
            if status == "valid":
                detail["passwordRecovery"] = {
                    "status": "database-password-verified",
                    "message": message,
                }
                continue
            pack["archive_password"] = None

        if not enabled:
            detail["passwordRecovery"] = {
                "status": "password-required-not-entered",
                "message": "rerun with --ask-passwords to verify and store a password",
            }
            continue

        print(
            f"\n[{pack_id}] {pack['name']}\n"
            f"  Archive: {relative_display(archive, data_dir)}\n"
            "  This retained archive needs a password for re-extraction."
        )
        while True:
            try:
                password = getpass.getpass(
                    "  Password (press Enter to skip this archive): "
                )
            except (EOFError, KeyboardInterrupt):
                print("\n  Password entry cancelled; archive skipped.")
                password = ""
            if not password:
                pack["archive_password"] = None
                detail["passwordRecovery"] = {
                    "status": "skipped",
                    "message": "password entry was skipped",
                }
                break

            status, message = verify_archive_password(archive, password, seven_zip)
            if status == "valid":
                pack["archive_password"] = password
                detail["passwordRecovery"] = {
                    "status": "verified",
                    "message": message,
                }
                print("  Password verified successfully.")
                break
            if status in {"unavailable", "error"}:
                pack["archive_password"] = None
                detail["passwordRecovery"] = {
                    "status": "verification-error",
                    "message": message,
                }
                print(f"  Password was not stored: {message}")
                break
            print("  Password is incorrect. Try again, or press Enter to skip.")


def load_manifest(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def filesystem_times(paths: Iterable[Path]) -> tuple[str, str]:
    timestamps: list[float] = []
    for path in paths:
        try:
            timestamps.append(path.stat().st_mtime)
        except OSError:
            continue
    if not timestamps:
        now = utc_now()
        return sqlite_time(now), sqlite_time(now)
    return (
        sqlite_time(dt.datetime.fromtimestamp(min(timestamps), dt.timezone.utc)),
        sqlite_time(dt.datetime.fromtimestamp(max(timestamps), dt.timezone.utc)),
    )


def donor_json(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = json.loads(value)
        return value if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def build_pack(
    pack_id: str,
    data_dir: Path,
    donor: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    donor = donor or {}
    archive_dir = data_dir / "archives" / pack_id
    extracted_dir = data_dir / "extracted" / pack_id
    generated_dir = data_dir / "generated" / pack_id
    cover_dir = data_dir / "thumbnails" / pack_id
    images_dir = extracted_dir / "images"
    videos_dir = extracted_dir / "videos"
    staging_dir = extracted_dir / "_staging"

    archive = choose_archive(archive_dir)
    images = regular_files(images_dir)
    videos = regular_files(videos_dir)
    staging = regular_files(staging_dir)
    generated = generated_dir / "compressed.zip"
    generated_exists = (
        generated.is_file()
        and not generated.is_symlink()
        and generated.stat().st_size > 0
    )
    manifest = load_manifest(generated_dir / "manifest.json")
    actual_extracted_tree = images_dir.is_dir() or videos_dir.is_dir()

    source_type = donor.get("source_type")
    if source_type not in {"archive", "folder"}:
        source_type = "archive" if archive else "folder"

    if generated_exists:
        status = "generated"
        error_message = None
    elif images or videos or actual_extracted_tree:
        status = "extracted"
        error_message = None
    elif staging:
        status = "uploading"
        source_type = "folder"
        error_message = None
    elif archive:
        status = "uploading"
        source_type = "archive"
        error_message = None
    else:
        status = "failed"
        error_message = "恢复脚本仅找到数据库元数据，未找到对应文件"

    archive_format = archive.suffix.lower().lstrip(".") if archive else ""
    original_format = safe_text(
        donor.get("original_format"),
        archive_format or ("folder" if source_type == "folder" else "unknown"),
        32,
    ).lower()
    if archive_format:
        original_format = archive_format

    fallback_name = f"恢复-{pack_id[:8]}"
    if archive and not archive.name.lower().startswith("original."):
        fallback_name = archive.stem
    name = safe_text(donor.get("name"), fallback_name, 200)
    original_filename = safe_text(
        donor.get("original_filename"),
        archive.name if archive else name,
        255,
    )

    if archive:
        original_size = archive.stat().st_size
    elif source_type == "folder":
        original_size = sum(item[2] for item in images + videos + staging)
    else:
        original_size = safe_integer(donor.get("original_size"))

    if actual_extracted_tree:
        image_count = len(images)
        video_count = len(videos)
        total_images_size = sum(item[2] for item in images)
        total_videos_size = sum(item[2] for item in videos)
    else:
        image_count = safe_integer(donor.get("image_count"))
        video_count = safe_integer(donor.get("video_count"))
        total_images_size = safe_integer(donor.get("total_images_size"))
        total_videos_size = safe_integer(donor.get("total_videos_size"))

    structured = any("/" in item[1] for item in images + videos)
    structure_type = "structured" if structured else "flat"
    if not actual_extracted_tree and donor.get("structure_type") in {"flat", "structured"}:
        structure_type = donor["structure_type"]

    relevant_paths = [
        path
        for path in (
            archive_dir,
            extracted_dir,
            generated_dir,
            cover_dir,
            archive,
            generated if generated_exists else None,
        )
        if path is not None and path.exists()
    ]
    inferred_created, inferred_updated = filesystem_times(relevant_paths)
    created_at = safe_text(donor.get("created_at"), inferred_created, 40)
    updated_at = safe_text(donor.get("updated_at"), inferred_updated, 40)

    pack = {
        "id": pack_id,
        "name": name,
        "original_filename": original_filename,
        "original_size": original_size,
        "original_format": original_format,
        "status": status,
        "image_count": image_count,
        "video_count": video_count,
        "total_images_size": total_images_size,
        "total_videos_size": total_videos_size,
        "error_message": error_message,
        "archive_password": (
            donor.get("archive_password")
            if status == "uploading"
            and source_type == "archive"
            and isinstance(donor.get("archive_password"), str)
            else None
        ),
        "compressed_size": generated.stat().st_size if generated_exists else 0,
        "created_at": created_at,
        "updated_at": updated_at,
        "structure_type": structure_type,
        "blurhashes": donor_json(donor.get("blurhashes")),
        "source_type": source_type,
    }
    detail = {
        "id": pack_id,
        "name": name,
        "status": status,
        "sourceType": source_type,
        "archive": relative_display(archive, data_dir) if archive else None,
        "generatedArchive": relative_display(generated, data_dir)
        if generated_exists
        else None,
        "imageCount": image_count,
        "videoCount": video_count,
        "stagedFileCount": len(staging),
        "metadataSource": donor.get("_source"),
        "manifestOptions": manifest.get("options")
        if manifest and isinstance(manifest.get("options"), dict)
        else None,
        "limitations": []
        if donor
        else ["name, tags, timestamps and password could not be recovered from a database"],
    }
    return pack, detail


def scan_unconfirmed_uploads(data_dir: Path) -> list[dict[str, Any]]:
    uploads_dir = data_dir / "uploads"
    if not uploads_dir.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for candidate in sorted(uploads_dir.iterdir()):
        if (
            not candidate.is_file()
            or candidate.is_symlink()
            or candidate.name.endswith(".info")
        ):
            continue
        info_path = Path(str(candidate) + ".info")
        metadata: dict[str, Any] | None = None
        if info_path.is_file():
            try:
                value = json.loads(info_path.read_text(encoding="utf-8"))
                metadata = value if isinstance(value, dict) else None
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                pass
        result.append({
            "uploadId": candidate.name,
            "path": relative_display(candidate, data_dir),
            "size": candidate.stat().st_size,
            "metadata": metadata,
            "note": "not imported automatically; inspect and copy to archives/<packId>/ if needed",
        })
    return result


def reconcile_pack_files(
    data_dir: Path,
    recovered_packs: dict[str, dict[str, Any]],
    donor_files: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    by_pack: dict[str, list[dict[str, Any]]] = {}
    for row in donor_files.values():
        pack_id = row.get("pack_id")
        relative_path = safe_relative_path(row.get("relative_path"))
        if pack_id not in recovered_packs or relative_path is None:
            continue
        item = dict(row)
        item["relative_path"] = relative_path
        by_pack.setdefault(pack_id, []).append(item)

    result: list[dict[str, Any]] = []
    for pack_id, pack in recovered_packs.items():
        rows = by_pack.get(pack_id, [])
        staging_dir = data_dir / "extracted" / pack_id / "_staging"
        if not rows and pack["source_type"] == "folder":
            for _, relative_path, size in regular_files(staging_dir):
                rows.append({
                    "id": str(uuid.uuid5(RECOVERY_NAMESPACE, f"{pack_id}:{relative_path}")),
                    "pack_id": pack_id,
                    "relative_path": relative_path,
                    "file_size": size,
                    "upload_id": None,
                    "status": "uploaded",
                    "created_at": pack["created_at"],
                    "uploaded_at": pack["updated_at"],
                })

        for row in rows:
            relative_path = row["relative_path"]
            expected_size = safe_integer(row.get("file_size"))
            staged = staging_dir.joinpath(*relative_path.split("/"))
            upload_id = row.get("upload_id") if isinstance(row.get("upload_id"), str) else None
            uploaded_source = data_dir / "uploads" / upload_id if upload_id else None
            if staged.is_file() and staged.stat().st_size == expected_size:
                status = "uploaded"
                uploaded_at = safe_text(
                    row.get("uploaded_at"), pack["updated_at"], 40
                )
            elif (
                uploaded_source
                and uploaded_source.is_file()
                and uploaded_source.stat().st_size == expected_size
            ):
                status = "uploading"
                uploaded_at = None
            else:
                status = "pending"
                uploaded_at = None
            result.append({
                "id": safe_text(
                    row.get("id"),
                    str(uuid.uuid5(RECOVERY_NAMESPACE, f"{pack_id}:{relative_path}")),
                    128,
                ),
                "pack_id": pack_id,
                "relative_path": relative_path,
                "file_size": expected_size,
                "upload_id": upload_id,
                "status": status,
                "created_at": safe_text(
                    row.get("created_at"), pack["created_at"], 40
                ),
                "uploaded_at": uploaded_at,
            })
    return result


def insert_recovery_database(
    database_path: Path,
    packs: dict[str, dict[str, Any]],
    metadata: dict[str, Any],
    pack_files: list[dict[str, Any]],
) -> dict[str, int]:
    connection = sqlite3.connect(database_path)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(FINAL_SCHEMA)

    pack_columns = [
        "id", "name", "original_filename", "original_size", "original_format",
        "status", "image_count", "video_count", "total_images_size",
        "total_videos_size", "error_message", "archive_password",
        "compressed_size", "created_at", "updated_at", "structure_type",
        "blurhashes", "source_type",
    ]
    placeholders = ", ".join("?" for _ in pack_columns)
    connection.executemany(
        f"INSERT INTO packs ({', '.join(pack_columns)}) VALUES ({placeholders})",
        [[pack[column] for column in pack_columns] for pack in packs.values()],
    )

    tag_id_remap: dict[str, str] = {}
    used_names: dict[str, str] = {}
    tags_inserted = 0
    for tag_id, row in sorted(metadata["tags"].items()):
        name = safe_text(row.get("name"), "", 200)
        if not name:
            continue
        canonical_id = used_names.get(name)
        if canonical_id:
            tag_id_remap[tag_id] = canonical_id
            continue
        canonical_id = safe_text(tag_id, str(uuid.uuid4()), 128)
        used_names[name] = canonical_id
        tag_id_remap[tag_id] = canonical_id
        connection.execute(
            "INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)",
            (
                canonical_id,
                name,
                safe_text(row.get("created_at"), sqlite_time(utc_now()), 40),
            ),
        )
        tags_inserted += 1

    relations_inserted = 0
    for pack_id, old_tag_id in sorted(metadata["pack_tags"]):
        tag_id = tag_id_remap.get(old_tag_id)
        if pack_id in packs and tag_id:
            connection.execute(
                "INSERT OR IGNORE INTO pack_tags (pack_id, tag_id) VALUES (?, ?)",
                (pack_id, tag_id),
            )
            relations_inserted += 1

    valid_presets: list[dict[str, Any]] = []
    for row in metadata["presets"].values():
        try:
            options = json.loads(row.get("options", ""))
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(options, dict):
            continue
        valid_presets.append({
            "id": safe_text(row.get("id"), str(uuid.uuid4()), 128),
            "name": safe_text(row.get("name"), "恢复预设", 200),
            "options": json.dumps(options, ensure_ascii=False, separators=(",", ":")),
            "is_default": 1 if row.get("is_default") in (1, True) else 0,
            "created_at": safe_text(row.get("created_at"), sqlite_time(utc_now()), 40),
            "updated_at": safe_text(row.get("updated_at"), sqlite_time(utc_now()), 40),
            "_rank": parse_time(row.get("updated_at"), row.get("_source_mtime", 0)),
        })
    if not valid_presets:
        valid_presets.append({
            "id": str(uuid.uuid5(RECOVERY_NAMESPACE, "default-preset")),
            "name": "默认",
            "options": json.dumps(DEFAULT_OPTIONS, ensure_ascii=False, separators=(",", ":")),
            "is_default": 1,
            "created_at": sqlite_time(utc_now()),
            "updated_at": sqlite_time(utc_now()),
            "_rank": 0,
        })
    chosen_default = max(
        (preset for preset in valid_presets if preset["is_default"]),
        key=lambda preset: preset["_rank"],
        default=max(valid_presets, key=lambda preset: preset["_rank"]),
    )
    for preset in valid_presets:
        connection.execute(
            """
            INSERT INTO presets
              (id, name, is_default, options, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                preset["id"],
                preset["name"],
                1 if preset is chosen_default else 0,
                preset["options"],
                preset["created_at"],
                preset["updated_at"],
            ),
        )

    for row in pack_files:
        connection.execute(
            """
            INSERT OR IGNORE INTO pack_files
              (id, pack_id, relative_path, file_size, upload_id, status,
               created_at, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"], row["pack_id"], row["relative_path"],
                row["file_size"], row["upload_id"], row["status"],
                row["created_at"], row["uploaded_at"],
            ),
        )

    connection.executemany(
        "INSERT INTO migrations (name) VALUES (?)",
        [(migration,) for migration in MIGRATIONS],
    )
    connection.commit()
    integrity = connection.execute("PRAGMA quick_check").fetchone()
    if not integrity or integrity[0] != "ok":
        connection.close()
        raise RuntimeError(
            f"recovered database failed quick_check: {integrity[0] if integrity else 'no result'}"
        )
    connection.execute("VACUUM")
    connection.close()
    os.chmod(database_path, 0o600)
    return {
        "packs": len(packs),
        "tags": tags_inserted,
        "packTags": relations_inserted,
        "presets": len(valid_presets),
        "packFiles": len(pack_files),
    }


def write_instructions(output_dir: Path, data_dir: Path, database_path: Path) -> None:
    text = f"""AoI recovery output
===================

Source DATA_DIR:
  {data_dir}

Recovered database:
  {database_path}

This script did not overwrite or delete any source file.

Review recovery-report.json before installing the database. Names beginning
with "恢复-" were inferred because no usable database metadata was found.
Tags and other database-only metadata cannot be reconstructed from image files.
If --ask-passwords was used, verified passwords exist as plaintext SQLite
fields only for archives that still require extraction. AoI clears each field
after a successful extraction.

To install after review:

1. Stop AoI completely, including PM2 or Docker restart policies.
2. Make an additional copy of the entire DATA_DIR if space permits.
3. Move db/packdb.sqlite, db/packdb.sqlite-wal and db/packdb.sqlite-shm to a
   separate backup directory. Do not delete them.
4. Copy the recovered packdb.sqlite to db/packdb.sqlite and set mode 0600.
5. Start exactly one AoI instance and inspect the packs before deleting any
   backup.

Packs marked "uploading" have a retained archive or folder staging tree. The
current AoI startup recovery will enqueue extraction or finish folder staging.
Metadata-only packs are marked "failed" so they remain visible for inspection.
"""
    instructions = output_dir / "README.txt"
    instructions.write_text(text, encoding="utf-8")
    os.chmod(instructions, 0o600)


def unique_output_dir(data_dir: Path) -> Path:
    base = data_dir / f"aoi-recovery-{utc_now().strftime('%Y%m%d-%H%M%S')}"
    candidate = base
    counter = 1
    while candidate.exists():
        candidate = Path(f"{base}-{counter}")
        counter += 1
    return candidate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Rebuild an AoI catalog from retained archives, extracted files, "
            "generated ZIPs and any readable database/backup."
        )
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        help="AoI DATA_DIR; defaults to the directory containing this script",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="new, empty output directory; defaults to DATA_DIR/aoi-recovery-<time>",
    )
    parser.add_argument(
        "--ask-passwords",
        action="store_true",
        help=(
            "interactively request and verify passwords only for retained archives "
            "that must be re-extracted; Enter skips an archive"
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    script_dir = Path(__file__).resolve().parent
    data_dir = (args.data_dir or script_dir).expanduser().resolve()
    if not data_dir.is_dir():
        print(f"error: DATA_DIR does not exist: {data_dir}", file=sys.stderr)
        return 2

    output_dir = (
        args.output.expanduser().resolve()
        if args.output
        else unique_output_dir(data_dir)
    )
    if output_dir.exists():
        print(f"error: output path already exists: {output_dir}", file=sys.stderr)
        return 2
    output_dir.mkdir(parents=True, mode=0o700)

    print(f"Scanning AoI data directory: {data_dir}")
    print("IMPORTANT: stop all AoI/PM2/Docker instances before using this output.")

    skipped: list[dict[str, str]] = []
    metadata, database_reports = collect_database_metadata(data_dir, output_dir)
    pack_ids = directory_ids(data_dir, skipped)
    pack_ids.update(metadata["packs"].keys())

    packs: dict[str, dict[str, Any]] = {}
    pack_details: list[dict[str, Any]] = []
    for pack_id in sorted(pack_ids):
        if not SAFE_ID.fullmatch(pack_id):
            skipped.append({"path": pack_id, "reason": "unsafe pack id from metadata"})
            continue
        pack, detail = build_pack(
            pack_id, data_dir, metadata["packs"].get(pack_id)
        )
        packs[pack_id] = pack
        pack_details.append(detail)

    collect_interactive_passwords(
        data_dir, packs, pack_details, args.ask_passwords
    )
    pack_files = reconcile_pack_files(
        data_dir, packs, metadata["pack_files"]
    )
    database_path = output_dir / "packdb.sqlite"
    counts = insert_recovery_database(
        database_path, packs, metadata, pack_files
    )

    report = {
        "generatedAt": utc_now().isoformat(),
        "sourceDataDir": str(data_dir),
        "outputDatabase": str(database_path),
        "sourceWasModified": False,
        "counts": counts,
        "databaseCandidates": database_reports,
        "packs": pack_details,
        "unconfirmedUploads": scan_unconfirmed_uploads(data_dir),
        "skipped": skipped,
        "limitations": [
            "filesystem-only recovery cannot reconstruct original names, tags or exact timestamps",
            "archive passwords are stored only after successful archive verification with --ask-passwords",
            "unconfirmed files in uploads/ are reported but never moved automatically",
            "archive contents and image decodability are not exhaustively verified by this catalog rebuild",
        ],
    }
    report_path = output_dir / "recovery-report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(report_path, 0o600)
    write_instructions(output_dir, data_dir, database_path)

    print(f"Recovered packs: {counts['packs']}")
    print(f"Recovered tags: {counts['tags']}")
    print(f"Unconfirmed uploads reported: {len(report['unconfirmedUploads'])}")
    print(f"New database: {database_path}")
    print(f"Review report: {report_path}")
    print("No source file or existing database was modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
