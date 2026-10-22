#!/usr/bin/env python3
"""Download numbered movie posters from TMDB using the IMDb IDs in dataset/*.csv.

The generated posters/{index}.jpg numbering mirrors the browser CSV importer:
CSV files are processed alphabetically, duplicate IMDb IDs are merged, and the
first occurrence determines the poster index.

Environment:
    TMDB_TOKEN     TMDB API Read Access Token (recommended)
    TMDB_API_KEY   Optional v3 API key alternative

Examples:
    export TMDB_TOKEN='your-read-access-token'
    python download_posters.py
    python download_posters.py --limit 20
    python download_posters.py --workers 24 --rate 28 --overwrite
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import re
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageOps
from requests.adapters import HTTPAdapter

API_BASE = "https://api.themoviedb.org/3"
IMAGE_BASE = "https://image.tmdb.org/t/p/w500"
USER_AGENT = "WhyThisMovie-PosterDownloader/1.0 (local personal project)"

THREAD_LOCAL = threading.local()


def normalize(value: Any) -> str:
    return re.sub(r"[\s_]+", " ", str(value or "").strip().lower())


def normalize_header(value: Any) -> str:
    return normalize(value)


def get_value(normalized_row: dict[str, str], *names: str) -> str:
    """Return the first matching field from a row whose headers are normalized."""
    for name in names:
        key = normalize_header(name)
        if key in normalized_row:
            return normalized_row[key]
    return ""


def catalogue_from_csv(dataset_dir: Path) -> list[dict[str, str | int]]:
    """Create a stable deduplicated list that follows csv-database.js mergeFiles()."""
    csv_files = sorted(
        (path for path in dataset_dir.glob("*.csv") if path.is_file()),
        key=lambda path: path.name.casefold(),
    )
    if not csv_files:
        raise FileNotFoundError(f"No CSV files found in {dataset_dir}")

    catalogue: list[dict[str, str | int]] = []
    seen: set[str] = set()

    for csv_path in csv_files:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if not reader.fieldnames:
                continue

            header_keys = {normalize_header(name) for name in reader.fieldnames if name}
            title_headers = {normalize_header(name) for name in ("movie_name", "movie_title", "title", "name")}
            id_headers = {normalize_header(name) for name in ("movie_id", "imdb_id", "id")}
            if not header_keys.intersection(title_headers):
                raise ValueError(f"{csv_path.name}: no movie_name/title column found")

            for row in reader:
                normalized_row = {
                    normalize_header(key): (value or "").strip()
                    for key, value in row.items()
                    if key is not None
                }
                title = get_value(normalized_row, "movie_name", "movie_title", "title", "name")
                if not title:
                    continue
                imdb_id = get_value(normalized_row, "movie_id", "imdb_id", "id")
                year_text = get_value(normalized_row, "year", "release_year")
                year_match = re.search(r"\b(18|19|20|21)\d{2}\b", year_text)
                year = year_match.group(0) if year_match else ""
                if imdb_id:
                    key = f"id:{imdb_id.lower()}"
                else:
                    key = f"title:{normalize(title)}|{year}"
                if key in seen:
                    continue
                seen.add(key)
                catalogue.append({
                    "index": len(catalogue),
                    "title": title,
                    "year": year,
                    "imdb_id": imdb_id,
                })

    if not catalogue:
        raise ValueError(f"No movie rows found in CSV files under {dataset_dir}")
    return catalogue


class ApiPacer:
    """A shared request-start pacer to stay comfortably below TMDB's published limit."""
    def __init__(self, requests_per_second: float) -> None:
        if requests_per_second <= 0:
            raise ValueError("--rate must be greater than zero")
        self.interval = 1.0 / requests_per_second
        self.lock = threading.Lock()
        self.next_time = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            slot = max(now, self.next_time)
            self.next_time = slot + self.interval
        delay = slot - now
        if delay > 0:
            time.sleep(delay)


def get_session(token: str | None, api_key: str | None, pool_size: int) -> requests.Session:
    session = getattr(THREAD_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json,image/*,*/*;q=0.8"})
        if token:
            session.headers["Authorization"] = f"Bearer {token}"
        adapter = HTTPAdapter(pool_connections=pool_size, pool_maxsize=pool_size, max_retries=0)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        THREAD_LOCAL.session = session
    return session


def validate_tmdb_credentials(token: str | None, api_key: str | None, pool_size: int) -> None:
    """Fail fast before queuing a huge batch if auth or connectivity is broken."""
    session = get_session(token, api_key, pool_size)
    params = {"api_key": api_key} if api_key and not token else None
    response = request_with_retries(
        session,
        f"{API_BASE}/configuration",
        params=params,
        timeout=(5, 15),
    )
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("images"), dict):
        raise RuntimeError("TMDB returned an unexpected configuration response")


def retry_delay(response: requests.Response | None, attempt: int) -> float:
    if response is not None and response.headers.get("Retry-After"):
        try:
            return min(30.0, max(0.5, float(response.headers["Retry-After"])))
        except ValueError:
            pass
    return min(12.0, 0.75 * (2 ** attempt))


def request_with_retries(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, str] | None = None,
    timeout: tuple[float, float] = (5, 20),
    pacer: ApiPacer | None = None,
) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(5):
        if pacer:
            pacer.wait()
        response: requests.Response | None = None
        try:
            response = session.get(url, params=params, timeout=timeout)
            if response.status_code == 429 or response.status_code >= 500:
                if attempt == 4:
                    response.raise_for_status()
                time.sleep(retry_delay(response, attempt))
                continue
            response.raise_for_status()
            return response
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_error = exc
            if attempt == 4:
                break
            time.sleep(retry_delay(response, attempt))
        except requests.HTTPError:
            raise
    if last_error:
        raise last_error
    raise RuntimeError(f"Request failed after retries: {url}")


def pick_poster_path(data: dict[str, Any]) -> str | None:
    # IMDb IDs can resolve to a movie or (occasionally) a TV entry.
    for result_key in ("movie_results", "tv_results", "tv_episode_results"):
        for item in data.get(result_key, []) or []:
            path = item.get("poster_path")
            if path:
                return path
    return None


def save_as_jpeg(image_bytes: bytes, output_path: Path) -> None:
    """Keep JPEG bytes as-is for speed; convert other formats into .jpg."""
    if image_bytes.startswith(b"\xff\xd8\xff"):
        # TMDB's poster CDN overwhelmingly serves JPEGs. Avoid expensive decode/re-encode.
        output_path.write_bytes(image_bytes)
        return

    with Image.open(io.BytesIO(image_bytes)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        image.load()
        image.save(output_path, format="JPEG", quality=88, optimize=False, progressive=False)


def download_one(
    movie: dict[str, str | int],
    posters_dir: Path,
    token: str | None,
    api_key: str | None,
    pacer: ApiPacer,
    pool_size: int,
    overwrite: bool,
) -> tuple[int, str, str, str]:
    index = int(movie["index"])
    title = str(movie["title"])
    imdb_id = str(movie["imdb_id"] or "").strip()
    output_path = posters_dir / f"{index}.jpg"

    if output_path.exists() and output_path.stat().st_size > 512 and not overwrite:
        return index, title, "existing", ""
    if not re.fullmatch(r"tt\d+", imdb_id, flags=re.IGNORECASE):
        return index, title, "missing", "no IMDb ID"

    session = get_session(token, api_key, pool_size)
    params = {"external_source": "imdb_id", "language": "en-US"}
    if api_key and not token:
        params["api_key"] = api_key

    try:
        lookup = request_with_retries(
            session,
            f"{API_BASE}/find/{imdb_id}",
            params=params,
            pacer=pacer,
        )
        path = pick_poster_path(lookup.json())
        if not path:
            return index, title, "missing", "TMDB has no poster for this IMDb ID"

        image_response = request_with_retries(
            session,
            f"{IMAGE_BASE}{path}",
            timeout=(5, 30),
            pacer=None,
        )
        content_type = image_response.headers.get("Content-Type", "").lower()
        if not content_type.startswith("image/"):
            raise ValueError(f"expected image content, got {content_type or 'unknown content type'}")

        # Temp+rename avoids leaving a truncated poster if a download is interrupted.
        temp_final = output_path.with_name(f".{output_path.name}.tmp")
        try:
            save_as_jpeg(image_response.content, temp_final)
            temp_final.replace(output_path)
        finally:
            temp_final.unlink(missing_ok=True)
        return index, title, "downloaded", ""
    except Exception as exc:  # one failed poster should not stop the whole batch
        reason = str(exc)
        # The v3 API-key auth method puts credentials in the URL. Never write
        # those credentials into the CSV error report or terminal output.
        if api_key:
            reason = re.sub(r"([?&]api_key=)[^&\s]+", r"\1[REDACTED]", reason, flags=re.IGNORECASE)
        return index, title, "error", reason


def main() -> int:
    parser = argparse.ArgumentParser(description="Fast, parallel TMDB poster downloader for WhyThisMovie")
    parser.add_argument("--dataset", type=Path, default=Path(__file__).resolve().parent / "dataset",
                        help="folder containing genre CSV files (default: ./dataset)")
    parser.add_argument("--posters", type=Path, default=Path(__file__).resolve().parent / "posters",
                        help="output folder (default: ./posters)")
    parser.add_argument("--workers", type=int, default=24, help="parallel image/metadata workers (default: 24)")
    parser.add_argument("--rate", type=float, default=28.0, help="max TMDB API lookups per second (default: 28)")
    parser.add_argument("--limit", type=int, default=0, help="only process the first N catalogue movies (0 = all)")
    parser.add_argument("--overwrite", action="store_true", help="redownload posters that already exist")
    args = parser.parse_args()

    token = os.getenv("TMDB_TOKEN", "").strip() or None
    api_key = os.getenv("TMDB_API_KEY", "").strip() or None
    if not token and not api_key:
        print("Missing TMDB credentials. Set TMDB_TOKEN to your API Read Access Token, or TMDB_API_KEY.", file=sys.stderr)
        print("See https://developer.themoviedb.org/docs/authentication-application", file=sys.stderr)
        return 2
    if args.workers < 1 or args.workers > 64:
        parser.error("--workers must be between 1 and 64")
    if args.rate <= 0 or args.rate > 35:
        parser.error("--rate must be greater than 0 and at most 35 requests/second; keep some headroom below TMDB's approximate 40/s ceiling")

    try:
        catalogue = catalogue_from_csv(args.dataset)
    except Exception as exc:
        print(f"Could not read catalogue: {exc}", file=sys.stderr)
        return 2

    # Avoid producing hundreds of thousands of identical failures when a token
    # is invalid or TMDB cannot be reached. This check runs once before any batch.
    print("Checking TMDB credentials and API connectivity…", flush=True)
    try:
        validate_tmdb_credentials(token, api_key, min(args.workers, 8))
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "unknown"
        detail = ""
        if exc.response is not None:
            try:
                detail = str(exc.response.json().get("status_message", ""))
            except (ValueError, AttributeError):
                pass
        print(f"TMDB preflight failed (HTTP {status}){': ' + detail if detail else ''}.", file=sys.stderr)
        print("Check your credentials. TMDB_TOKEN must be the API Read Access Token (Bearer token), not the short v3 API key.", file=sys.stderr)
        return 2
    except Exception as exc:
        # Don't print raw request exceptions here; an API key can be present in URLs.
        print(f"TMDB preflight failed ({type(exc).__name__}). Check your network connection and TMDB credentials.", file=sys.stderr)
        return 2
    print("TMDB authentication and API connectivity OK.", flush=True)

    if args.limit > 0:
        catalogue = catalogue[:args.limit]

    args.posters.mkdir(parents=True, exist_ok=True)
    to_process = []
    existing = 0
    for movie in catalogue:
        target = args.posters / f"{movie['index']}.jpg"
        if target.exists() and target.stat().st_size > 512 and not args.overwrite:
            existing += 1
        else:
            to_process.append(movie)

    print(f"Catalogue: {len(catalogue):,} unique movies")
    print(f"Already present: {existing:,}; queued: {len(to_process):,}")
    print(f"Workers: {args.workers}; TMDB lookup pace: {args.rate:g}/second")
    if not to_process:
        print("Nothing to do. Use --overwrite to redownload existing poster files.")
        return 0

    pacer = ApiPacer(args.rate)
    totals = {"downloaded": 0, "existing": existing, "missing": 0, "error": 0}
    failures: list[tuple[int, str, str]] = []
    start = time.monotonic()

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(download_one, movie, args.posters, token, api_key,
                                   pacer, args.workers, args.overwrite) for movie in to_process]
        for completed, future in enumerate(as_completed(futures), start=1):
            index, title, status, detail = future.result()
            totals[status] = totals.get(status, 0) + 1
            if status in ("missing", "error"):
                failures.append((index, title, detail))
            if completed % 25 == 0 or completed == len(futures):
                elapsed = max(0.001, time.monotonic() - start)
                rate = completed / elapsed
                print(f"[{completed:>5}/{len(futures)}] downloaded={totals['downloaded']} "
                      f"missing={totals['missing']} errors={totals['error']} ({rate:.1f} movies/s)",
                      flush=True)

    if failures:
        report = args.posters / "missing_posters.csv"
        with report.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["index", "title", "reason"])
            writer.writerows(sorted(failures))
        print(f"Missing/error report: {report}")
        sample_errors = [item for item in failures if item[2] and item[2] != "no IMDb ID"][:5]
        if sample_errors:
            print("Example failures (first 5):")
            for index, title, reason in sample_errors:
                print(f"  [{index}] {title}: {reason}")
    else:
        report = args.posters / "missing_posters.csv"
        report.unlink(missing_ok=True)

    elapsed = time.monotonic() - start
    print("\nFinished")
    print(f"  Downloaded: {totals['downloaded']:,}")
    print(f"  Already present: {totals['existing']:,}")
    print(f"  No poster/ID: {totals['missing']:,}")
    print(f"  Errors: {totals['error']:,}")
    print(f"  Elapsed: {elapsed:.1f} seconds")
    print("TMDB attribution is required; see the project's README and Credits section.")
    return 0 if not totals["error"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
