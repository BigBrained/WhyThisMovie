# WhyThisMovie

A local, explainable movie recommender backed exclusively by your genre-split CSV catalogue. No MovieLens or other built-in movie dataset is included.

## Project files

- `index.html` — page structure and navigation.
- `styles.css` — responsive layout, themes, cards and controls.
- `recommender.js` — recommendation scoring helpers.
- `csv-database.js` — CSV parsing, schema normalization and duplicate merging.
- `app.js` — UI, ratings, feedback, poster fallback and dataset loading.
- `dataset/` — put the 13 CSV files here: `action.csv`, `adventure.csv`, `crime.csv`, `family.csv`, `fantasy.csv`, `film-noir.csv`, `history.csv`, `horror.csv`, `mystery.csv`, `scifi.csv`, `sports.csv`, `thriller.csv`, and `war.csv`.
- `posters/` — posters named by zero-based catalogue index (`0.jpg`, `1.jpg`, ...).
- `download_posters.py` — parallel TMDB poster downloader (requires a TMDB API Read Access Token).

## Run the app

1. Put all 13 CSV files in `dataset/` next to `index.html`.
2. Run a local static server from the project directory. For example, with Python:

   ```bash
   python -m http.server 8000
   ```

3. Open `http://localhost:8000`.

The app fetches the known 13 filenames from `dataset/` automatically. There is no folder picker and no bundled movie catalogue. Because browsers restrict `fetch()` from `file://` pages, do not double-click `index.html`; serve the project locally as shown above. The page reads only from the project's `dataset/` directory.

## Recommendations

Rate at least two or three movies you know. The model combines genre affinity, shared directors, overlapping cast and release era; IMDb rating and vote count help break ties. Movie IDs are merged across CSV files. Aggregate IMDb ratings are not individual user histories, so a collaborative-filtering benchmark is not available from these CSVs.

Everything runs locally in the browser after the CSVs load. The browser does not upload your ratings or catalogue. If you enter a TMDB API Read Access Token in the **Movie posters** panel, the app looks up posters for the currently displayed movies using each row’s IMDb ID (with an exact title/year search fallback). The token is held in the current tab’s `sessionStorage` and sent directly to TMDB; it is not written into the project files. TMDB artwork is preferred when found, followed by `posters/{index}.jpg` and then the generated SVG poster. Never hardcode your personal token into a public GitHub Pages repository.

## Download posters quickly

The script matches each CSV row's IMDb ID (`tt1234567`) to The Movie Database (TMDB), then downloads a `w500` poster to `posters/{catalogue_index}.jpg`. The index is generated using the same sorted CSV file order and duplicate-removal rules as the browser importer, so the app can find `posters/0.jpg`, `posters/1.jpg`, etc. Missing TMDB matches are recorded in `posters/missing_posters.csv`; the app uses generated SVG posters where a downloaded JPG is absent.

Create a virtual environment and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install requests pillow
```

Create a TMDB account, request an API key / API Read Access Token in the account's API settings, then export the token for the script:

```bash
export TMDB_TOKEN='YOUR_TMDB_API_READ_ACCESS_TOKEN'
python download_posters.py
```

The downloader uses 24 workers and paces TMDB metadata lookups to 28 requests/second by default, honours `429`/`Retry-After`, retries transient failures, skips existing posters, and writes images atomically. Before queuing the whole catalogue, it checks TMDB credentials and API connectivity so an invalid token fails quickly instead of generating thousands of identical errors. If individual downloads fail, it prints a few example reasons and writes the full report to `posters/missing_posters.csv`. To replace all posters, use `--overwrite`. To tune concurrency/rate, use `--workers 24 --rate 28`. Be respectful of TMDB's limits; its documented rate limit may change.

The downloader uses the project's `dataset/` and `posters/` directories by default, so no folder input is needed. To test the first 20 catalogue entries:

```bash
python download_posters.py --limit 20
```

### TMDB attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. The Movie Database requires attribution in an About/Credits section for non-commercial API use. If this project is used commercially, contact TMDB for the appropriate licence. See the official [TMDB API FAQ](https://developer.themoviedb.org/docs/faq).

### Troubleshooting the browser console

Keep `index.html`, `app.js`, `csv-database.js`, and `recommender.js` from the same ZIP release. The HTML now uses versioned asset URLs to avoid stale browser caches. If a previous HTML copy is missing the ratings-list container, `app.js` recreates that element automatically. After updating, hard-refresh the page with `Ctrl+Shift+R`.
