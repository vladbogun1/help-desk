from __future__ import annotations

import hashlib
import shutil
import subprocess
import uuid
import zlib
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from difflib import unified_diff
from enum import Enum
from pathlib import Path
from threading import Lock, Thread
from typing import Any

import yaml
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"


class ObjectStatus(str, Enum):
    ADDED = "ADDED"
    REMOVED = "REMOVED"
    CHANGED = "CHANGED"
    UNCHANGED = "UNCHANGED"


class Presence(str, Enum):
    LEFT_ONLY = "LEFT_ONLY"
    RIGHT_ONLY = "RIGHT_ONLY"
    BOTH = "BOTH"


class ChangeType(str, Enum):
    ADDED = "ADDED"
    REMOVED = "REMOVED"
    CHANGED = "CHANGED"
    UNCHANGED = "UNCHANGED"


@dataclass
class FileDelta:
    path: str
    type: ChangeType
    left_hash: str | None
    right_hash: str | None
    binary: bool
    left_path: Path | None
    right_path: Path | None


@dataclass
class ChangedFile:
    path: str
    changeType: ChangeType
    leftHash: str | None
    rightHash: str | None
    isBinary: bool


@dataclass
class MetadataObject:
    id: str
    type: str
    name: str
    path: str
    sidePresence: Presence
    status: ObjectStatus
    changedFiles: list[ChangedFile]


@dataclass
class CompareJob:
    id: str
    status: JobStatus
    createdAt: str
    finishedAt: str | None
    progress: int
    stage: str
    leftMetaSummary: dict[str, int]
    rightMetaSummary: dict[str, int]
    diffSummary: dict[str, int]
    error: str | None = None


@dataclass
class JobData:
    job: CompareJob
    objects: list[MetadataObject] = field(default_factory=list)
    file_deltas: dict[str, FileDelta] = field(default_factory=dict)


@dataclass
class MutableJob:
    id: str
    base: Path
    created: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished: datetime | None = None
    progress: int = 0
    stage: str = "Queued"
    data: JobData | None = None

    def __post_init__(self) -> None:
        self.data = JobData(job=self.to_job(JobStatus.QUEUED, self.progress, self.stage, None, {}, {}, {}))

    def to_job(
        self,
        status: JobStatus,
        progress: int,
        stage: str,
        error: str | None,
        left_summary: dict[str, int],
        right_summary: dict[str, int],
        diff_summary: dict[str, int],
    ) -> CompareJob:
        return CompareJob(
            id=self.id,
            status=status,
            createdAt=self.created.isoformat(),
            finishedAt=self.finished.isoformat() if self.finished else None,
            progress=progress,
            stage=stage,
            leftMetaSummary=left_summary,
            rightMetaSummary=right_summary,
            diffSummary=diff_summary,
            error=error,
        )


CONFIG = {
    "workspace_root": "/work",
    "job_ttl_minutes": 120,
    "v8unpack_path": "v8unpack",
    "v8unpack_timeout_sec": 120,
}

cfg_path = Path(__file__).resolve().parents[1] / "src" / "main" / "resources" / "application.yml"
if cfg_path.exists():
    raw_cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    app_cfg = raw_cfg.get("app", {})
    CONFIG["workspace_root"] = app_cfg.get("workspace-root", CONFIG["workspace_root"])
    CONFIG["job_ttl_minutes"] = int(app_cfg.get("job-ttl-minutes", CONFIG["job_ttl_minutes"]))
    CONFIG["v8unpack_path"] = app_cfg.get("v8unpack-path", CONFIG["v8unpack_path"])
    CONFIG["v8unpack_timeout_sec"] = int(app_cfg.get("v8unpack-timeout-sec", CONFIG["v8unpack_timeout_sec"]))


app = FastAPI(title="CF Compare", version="0.0.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: dict[str, MutableJob] = {}
lock = Lock()


def ensure_ext(filename: str) -> None:
    lower = filename.lower()
    if not (lower.endswith(".cf") or lower.endswith(".cfe") or lower.endswith(".epf")):
        raise HTTPException(status_code=400, detail="Only .cf/.cfe/.epf files are allowed")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def is_binary(path: Path) -> bool:
    chunk = path.read_bytes()[:4096]
    return b"\x00" in chunk


def normalize_text(path: Path) -> str:
    data = path.read_bytes()
    text = data.decode("utf-8", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if text.startswith("\ufeff"):
        text = text[1:]
    return text


def list_files(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    if not root.exists():
        return result
    for p in sorted(root.rglob("*")):
        if p.is_file():
            result[p.relative_to(root).as_posix()] = p
    return result


def object_key(rel_path: str) -> str:
    seg = rel_path.split("/")
    obj_type = seg[0].upper() if seg else "ROOT"
    name = seg[1] if len(seg) > 1 else "ROOT"
    path = f"{seg[0]}/{seg[1]}" if len(seg) > 1 else rel_path
    return f"{obj_type}::{name}::{path}"


def summarize_objects(objects: list[MetadataObject], left_side: bool) -> dict[str, int]:
    summary: dict[str, int] = {}
    for obj in objects:
        if left_side and obj.sidePresence == Presence.RIGHT_ONLY:
            continue
        if not left_side and obj.sidePresence == Presence.LEFT_ONLY:
            continue
        summary[obj.type] = summary.get(obj.type, 0) + 1
    return dict(sorted(summary.items()))


def compare_dirs(left_dump: Path, right_dump: Path) -> tuple[list[MetadataObject], dict[str, FileDelta], dict[str, int], dict[str, int], dict[str, int]]:
    left_files = list_files(left_dump)
    right_files = list_files(right_dump)
    all_rel = sorted(set(left_files.keys()) | set(right_files.keys()))

    deltas: dict[str, FileDelta] = {}
    by_object: dict[str, list[FileDelta]] = {}

    for rel in all_rel:
        lpath = left_files.get(rel)
        rpath = right_files.get(rel)
        if lpath is None:
            delta = FileDelta(rel, ChangeType.ADDED, None, sha256(rpath), is_binary(rpath), None, rpath)
        elif rpath is None:
            delta = FileDelta(rel, ChangeType.REMOVED, sha256(lpath), None, is_binary(lpath), lpath, None)
        else:
            lhash = sha256(lpath)
            rhash = sha256(rpath)
            ctype = ChangeType.UNCHANGED if lhash == rhash else ChangeType.CHANGED
            delta = FileDelta(rel, ctype, lhash, rhash, is_binary(lpath) or is_binary(rpath), lpath, rpath)
        deltas[rel] = delta
        by_object.setdefault(object_key(rel), []).append(delta)

    objects: list[MetadataObject] = []
    for key, object_deltas in by_object.items():
        obj_type, name, path = key.split("::", 2)
        has_left = any(d.left_path is not None for d in object_deltas)
        has_right = any(d.right_path is not None for d in object_deltas)
        presence = Presence.BOTH if has_left and has_right else (Presence.LEFT_ONLY if has_left else Presence.RIGHT_ONLY)

        status = ObjectStatus.UNCHANGED
        if any(d.type == ChangeType.CHANGED for d in object_deltas):
            status = ObjectStatus.CHANGED
        elif not has_left:
            status = ObjectStatus.ADDED
        elif not has_right:
            status = ObjectStatus.REMOVED

        changed = [
            ChangedFile(
                path=d.path,
                changeType=d.type,
                leftHash=d.left_hash,
                rightHash=d.right_hash,
                isBinary=d.binary,
            )
            for d in object_deltas
            if d.type != ChangeType.UNCHANGED
        ]
        objects.append(
            MetadataObject(
                id=f"{obj_type}:{name}:{path}",
                type=obj_type,
                name=name,
                path=path,
                sidePresence=presence,
                status=status,
                changedFiles=changed,
            )
        )

    objects = sorted(objects, key=lambda o: (o.type, o.name))
    left_summary = summarize_objects(objects, True)
    right_summary = summarize_objects(objects, False)
    diff_summary = {
        "added": sum(1 for o in objects if o.status == ObjectStatus.ADDED),
        "removed": sum(1 for o in objects if o.status == ObjectStatus.REMOVED),
        "changed": sum(1 for o in objects if o.status == ObjectStatus.CHANGED),
        "unchanged": sum(1 for o in objects if o.status == ObjectStatus.UNCHANGED),
    }
    return objects, deltas, left_summary, right_summary, diff_summary


def unpack_raw(cf_file: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cf_file, output_dir / "container.cf")
    try:
        raw = cf_file.read_bytes()
        inflated = zlib.decompress(raw, wbits=-15)
        (output_dir / "container.raw.inflate").write_bytes(inflated)
    except Exception:
        # best-effort raw deflate fallback (same idea as previous Java version)
        pass


def run_v8unpack(cf_file: Path, output_dir: Path) -> tuple[bool, str | None]:
    output_dir.mkdir(parents=True, exist_ok=True)
    source = str(cf_file)
    target = str(output_dir)

    candidate_args = [
        ["-P", source, target],
        ["-I", source, "--prefix", target],
        ["--prefix", target, "-I", source],
    ]
    launchers = [
        [CONFIG["v8unpack_path"]],
        ["python", "-m", "v8unpack"],
    ]
    candidates = [[*launcher, *args] for launcher in launchers for args in candidate_args]

    timeout_sec = CONFIG["v8unpack_timeout_sec"]
    errors: list[str] = []

    for cmd in candidates:
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec, check=False)
        except FileNotFoundError:
            errors.append(f"missing command: {cmd[0]}")
            continue
        except subprocess.TimeoutExpired:
            errors.append(f"timeout after {timeout_sec}s: {' '.join(cmd)}")
            continue

        if proc.returncode != 0:
            err_text = (proc.stderr or proc.stdout or "").strip().replace("\n", " | ")
            err_tail = err_text[:300]
            errors.append(f"rc={proc.returncode} for {' '.join(cmd)}: {err_tail}")
            continue

        produced_files = [p for p in output_dir.rglob("*") if p.is_file()]
        if not produced_files:
            errors.append(f"no files produced by {' '.join(cmd)}")
            continue

        return True, None

    return False, "; ".join(errors) if errors else "unknown v8unpack failure"


def normalize_tree(dir_path: Path) -> None:
    if not dir_path.exists():
        return
    for p in dir_path.rglob("*"):
        if not p.is_file():
            continue
        try:
            p.write_text(normalize_text(p), encoding="utf-8")
        except Exception:
            pass


def copy_all(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        target = dst / rel
        if p.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)


def run_job(m: MutableJob, left_cf: Path, right_cf: Path) -> None:
    try:
        m.progress, m.stage = 5, "Unpacking raw container"
        raw_left = m.base / "raw" / "left"
        raw_right = m.base / "raw" / "right"
        unpack_raw(left_cf, raw_left)
        unpack_raw(right_cf, raw_right)

        m.progress, m.stage = 35, "Running v8unpack"
        dump_left = m.base / "dump" / "left"
        dump_right = m.base / "dump" / "right"
        ok_left, left_err = run_v8unpack(left_cf, dump_left)
        ok_right, right_err = run_v8unpack(right_cf, dump_right)
        used_fallback = not (ok_left and ok_right)
        if used_fallback:
            copy_all(raw_left, dump_left)
            copy_all(raw_right, dump_right)
            print(f"[compare:{m.id}] v8unpack fallback enabled: left={left_err}; right={right_err}")
        normalize_tree(dump_left)
        normalize_tree(dump_right)

        m.progress, m.stage = 70, "Comparing metadata and files"
        objects, deltas, left_summary, right_summary, diff_summary = compare_dirs(dump_left, dump_right)
        m.finished = datetime.now(timezone.utc)
        done_stage = "Done (with v8unpack fallback)" if used_fallback else "Done"
        m.progress, m.stage = 100, done_stage
        m.data = JobData(
            job=m.to_job(JobStatus.DONE, 100, done_stage, None, left_summary, right_summary, diff_summary),
            objects=objects,
            file_deltas=deltas,
        )
    except Exception as exc:
        m.finished = datetime.now(timezone.utc)
        m.data = JobData(
            job=m.to_job(JobStatus.FAILED, m.progress, m.stage, str(exc), {}, {}, {}),
            objects=[],
            file_deltas={},
        )


def cleanup_jobs() -> None:
    threshold = datetime.now(timezone.utc) - timedelta(minutes=CONFIG["job_ttl_minutes"])
    doomed: list[str] = []
    with lock:
        for job_id, job in jobs.items():
            if job.finished and job.finished < threshold:
                doomed.append(job_id)
    for job_id in doomed:
        delete_job(job_id)


def get_job(job_id: str) -> MutableJob:
    with lock:
        j = jobs.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="Job not found")
    return j


def delete_job(job_id: str) -> None:
    with lock:
        j = jobs.pop(job_id, None)
    if not j:
        raise HTTPException(status_code=404, detail="Job not found")
    if j.base.exists():
        shutil.rmtree(j.base, ignore_errors=True)


def as_jsonable(data: Any) -> Any:
    if isinstance(data, Enum):
        return data.value
    if isinstance(data, Path):
        return str(data)
    if isinstance(data, list):
        return [as_jsonable(x) for x in data]
    if isinstance(data, dict):
        return {k: as_jsonable(v) for k, v in data.items()}
    if hasattr(data, "__dataclass_fields__"):
        return as_jsonable(asdict(data))
    return data


@app.post("/api/compare")
async def create_compare(leftFile: UploadFile = File(...), rightFile: UploadFile = File(...)) -> dict[str, str]:
    ensure_ext(leftFile.filename or "")
    ensure_ext(rightFile.filename or "")

    job_id = str(uuid.uuid4())
    base = Path(CONFIG["workspace_root"]) / job_id
    (base / "input").mkdir(parents=True, exist_ok=True)
    left_path = base / "input" / "left.cf"
    right_path = base / "input" / "right.cf"
    left_path.write_bytes(await leftFile.read())
    right_path.write_bytes(await rightFile.read())

    job = MutableJob(id=job_id, base=base)
    with lock:
        jobs[job_id] = job
    Thread(target=run_job, args=(job, left_path, right_path), daemon=True).start()
    return {"jobId": job_id}


@app.get("/api/compare/{job_id}")
def job_status(job_id: str) -> Any:
    cleanup_jobs()
    return as_jsonable(get_job(job_id).data.job)


@app.get("/api/compare/{job_id}/objects")
def job_objects(
    job_id: str,
    q: str | None = Query(default=None),
    type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=0, ge=0),
    size: int = Query(default=200, ge=1),
) -> dict[str, Any]:
    all_objects = get_job(job_id).data.objects
    filtered = [
        o
        for o in all_objects
        if (q is None or q.lower() in o.name.lower())
        and (type is None or o.type.lower() == type.lower())
        and (status is None or o.status.value.lower() == status.lower())
    ]
    start = min(page * size, len(filtered))
    end = min(start + size, len(filtered))
    content = filtered[start:end]
    return {"content": as_jsonable(content), "page": page, "size": size, "count": len(content)}


@app.get("/api/compare/{job_id}/object/{object_id}")
def job_object(job_id: str, object_id: str) -> Any:
    for obj in get_job(job_id).data.objects:
        if obj.id == object_id:
            return as_jsonable(obj)
    raise HTTPException(status_code=404, detail="Object not found")


@app.get("/api/compare/{job_id}/diff")
def job_diff(job_id: str, path: str) -> dict[str, Any]:
    delta = get_job(job_id).data.file_deltas.get(path)
    if not delta:
        raise HTTPException(status_code=404, detail="Path not found")
    if delta.binary:
        return {
            "path": delta.path,
            "isBinary": True,
            "diff": None,
            "leftHash": delta.left_hash,
            "rightHash": delta.right_hash,
        }

    left_lines = []
    right_lines = []
    if delta.left_path and delta.left_path.exists():
        left_lines = normalize_text(delta.left_path).split("\n")
    if delta.right_path and delta.right_path.exists():
        right_lines = normalize_text(delta.right_path).split("\n")
    diff_text = "\n".join(
        unified_diff(left_lines, right_lines, fromfile=f"left/{delta.path}", tofile=f"right/{delta.path}", n=3, lineterm="")
    )
    return {"path": delta.path, "isBinary": False, "diff": diff_text}


@app.delete("/api/compare/{job_id}")
def delete_compare(job_id: str) -> dict[str, str]:
    delete_job(job_id)
    return {"status": "deleted"}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "UP"}


@app.get("/api/version")
def version() -> dict[str, str]:
    return {"version": "0.0.1"}
