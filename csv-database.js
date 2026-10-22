/*
 * CSV importer and persistent catalogue cache for WhyThisMovie.
 *
 * Features:
 * - Parses quoted commas, escaped quotes and multiline fields.
 * - Merges duplicate IMDb IDs across genre CSV files.
 * - Saves a compact parsed catalogue in IndexedDB.
 * - Loads the saved catalogue without downloading the CSV files again.
 */

(function () {
  "use strict";

  const FILE_GENRES = {
    action: "Action",
    adventure: "Adventure",
    crime: "Crime",
    family: "Family",
    fantasy: "Fantasy",
    "film-noir": "Film-Noir",
    history: "History",
    horror: "Horror",
    mystery: "Mystery",
    scifi: "Sci-Fi",
    sports: "Sport",
    thriller: "Thriller",
    war: "War",
  };

  // --------------------------------------------------
  // CSV parsing
  // --------------------------------------------------

  function parseCSV(source) {
    const text = String(source ?? "").replace(/^\uFEFF/, "");

    const rows = [];

    let row = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const next = text[index + 1];

      if (quoted) {
        if (character === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }

        continue;
      }

      if (character === '"' && field.length === 0) {
        quoted = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (
        character === "\n" ||
        character === "\r"
      ) {
        if (character === "\r" && next === "\n") {
          index += 1;
        }

        row.push(field);
        field = "";

        if (row.some((cell) => cell.trim() !== "")) {
          rows.push(row);
        }

        row = [];
      } else {
        field += character;
      }
    }

    row.push(field);

    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }

    if (quoted) {
      throw new Error(
        "A CSV file ends inside a quoted field. Check the final row."
      );
    }

    return rows;
  }

  const clean = (value) => String(value ?? "").trim();

  const keyOf = (value) =>
    clean(value).toLowerCase().replace(/[\s_]+/g, " ");

  function genreName(value) {
    const trimmed = clean(value).replace(/\s+/g, " ");
    const key = trimmed.toLowerCase().replace(/[ _]+/g, "-");

    const known = {
      "sci-fi": "Sci-Fi",
      scifi: "Sci-Fi",
      "science-fiction": "Sci-Fi",
      "film-noir": "Film-Noir",
      noir: "Film-Noir",
      sport: "Sport",
      sports: "Sport",
      "tv-movie": "TV Movie",
      "talk-show": "Talk Show",
      "game-show": "Game Show",
      "reality-tv": "Reality TV",
      "short-film": "Short",
    };

    if (known[key]) return known[key];

    return trimmed.split("-").map((part) =>
      part
        ? part[0].toUpperCase() + part.slice(1).toLowerCase()
        : part
    ).join("-");
  }

  function numberOrNull(value) {
    const text = clean(value);
    const number = Number(text.replace(/[$,]/g, ""));

    return Number.isFinite(number) && text !== ""
      ? number
      : null;
  }

  function parseYear(value) {
    const match = clean(value).match(/\b(18|19|20|21)\d{2}\b/);

    return match ? Number(match[0]) : null;
  }

  function parseVotes(value) {
    return Math.max(0, numberOrNull(value) || 0);
  }

  function parseStars(value) {
    return clean(value)
      .split(/[\n,;|]+/)
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name, index, all) =>
        all.findIndex(
          (item) => item.toLowerCase() === name.toLowerCase()
        ) === index
      );
  }

  // --------------------------------------------------
  // Individual CSV file parsing
  // --------------------------------------------------

  function parseFile(text, fileName) {
    const rows = parseCSV(text);

    if (rows.length < 2) return [];

    const headers = rows[0].map((header) => keyOf(header));

    const column = (...names) =>
      names
        .map((name) => headers.indexOf(keyOf(name)))
        .find((index) => index >= 0) ?? -1;

    const columns = {
      id: column("movie_id", "imdb_id", "id"),
      title: column("movie_name", "movie_title", "title", "name"),
      year: column("year", "release_year"),
      certificate: column(
        "certificate",
        "certification",
        "content_rating"
      ),
      runtime: column("runtime", "duration"),
      genre: column("genre", "genres"),
      rating: column("rating", "imdb_rating", "average_rating"),
      description: column("description", "plot", "overview"),
      director: column("director", "directors"),
      stars: column("star", "stars", "cast"),
      votes: column("votes", "vote_count", "num_votes"),
      gross: column("gross(in $)", "gross", "box_office"),
    };

    if (columns.title < 0) {
      throw new Error(
        `${fileName}: couldn't find a movie title column.`
      );
    }

    const filename = String(fileName)
      .split(/[\\/]/)
      .pop()
      .replace(/\.csv$/i, "")
      .toLowerCase();

    const fallbackGenre = FILE_GENRES[filename] || "";

    return rows.slice(1).map((cells) => {
      const read = (key) =>
        columns[key] < 0
          ? ""
          : clean(cells[columns[key]]);

      const title = read("title");

      if (!title) return null;

      const rawGenres = read("genre")
        .split(",")
        .map(genreName)
        .filter(Boolean);

      const genres = [
        ...new Set(
          rawGenres.length
            ? rawGenres
            : [fallbackGenre].filter(Boolean)
        ),
      ];

      return {
        id: read("id"),
        title,
        year: parseYear(read("year")),
        certificate: read("certificate"),
        runtime: read("runtime"),
        genres,
        rating: numberOrNull(read("rating")),
        description: read("description"),
        director: read("director"),
        stars: parseStars(read("stars")),
        votes: parseVotes(read("votes")),
        gross: read("gross"),
      };
    }).filter(Boolean);
  }

  // --------------------------------------------------
  // Merge duplicate films across genre files
  // --------------------------------------------------

  function mergeFiles(fileRows) {
    const byKey = new Map();
    const movies = [];

    for (const { name, rows } of fileRows) {
      for (const movie of rows) {
        const fallbackKey =
          `${keyOf(movie.title)}|${movie.year ?? ""}`;

        const key = movie.id
          ? `id:${movie.id.toLowerCase()}`
          : `title:${fallbackKey}`;

        const current = byKey.get(key);

        if (!current) {
          const entry = {
            ...movie,
            sources: [name],
          };

          byKey.set(key, entry);
          movies.push(entry);

          continue;
        }

        current.sources.push(name);

        current.genres = [
          ...new Set([...current.genres, ...movie.genres]),
        ];

        current.stars = [
          ...new Set([...current.stars, ...movie.stars]),
        ];

        const fields = [
          "year",
          "rating",
          "votes",
          "certificate",
          "runtime",
          "description",
          "director",
          "gross",
          "id",
        ];

        for (const field of fields) {
          const existing = current[field];

          const existingEmpty =
            existing === null ||
            existing === undefined ||
            existing === "" ||
            existing === 0;

          const incoming = movie[field];

          const incomingPresent =
            incoming !== null &&
            incoming !== undefined &&
            incoming !== "" &&
            incoming !== 0;

          if (existingEmpty && incomingPresent) {
            current[field] = incoming;
          }
        }
      }
    }

    const genreSet = new Set();

    movies.forEach((movie, index) => {
      movie.genres = [
        ...new Set(
          movie.genres.map(genreName).filter(Boolean)
        ),
      ].sort((a, b) => a.localeCompare(b));

      movie.sources = [...new Set(movie.sources)];

      movie.posterIndex = index;

      movie.searchText = [
        movie.title,
        movie.year,
        movie.director,
        ...movie.stars,
        ...movie.genres,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      movie.genres.forEach((genre) => genreSet.add(genre));
    });

    return {
      movies,
      genres: [...genreSet].sort((a, b) => a.localeCompare(b)),
      sourceFiles: fileRows.map((file) => file.name),
      importedAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------
  // Import CSV files
  // --------------------------------------------------

  async function fromFiles(files) {
    const csvFiles = [...files]
      .filter((file) => /\.csv$/i.test(file.name))
      .sort((left, right) => {
        const leftPath = left.webkitRelativePath || left.name;
        const rightPath = right.webkitRelativePath || right.name;

        return leftPath.localeCompare(rightPath);
      });

    if (!csvFiles.length) {
      throw new Error(
        "No CSV files were found in dataset/."
      );
    }

    const fileRows = [];

    for (const file of csvFiles) {
      const text = await file.text();

      fileRows.push({
        name: file.webkitRelativePath || file.name,
        rows: parseFile(text, file.name),
      });
    }

    const result = mergeFiles(fileRows);

    if (!result.movies.length) {
      throw new Error(
        "The CSV files did not contain any movie rows."
      );
    }

    return result;
  }

  // --------------------------------------------------
  // IndexedDB persistent catalogue cache
  // --------------------------------------------------

  const CACHE_DB_NAME = "whythismovie-catalogue-cache";
  const CACHE_DB_VERSION = 1;
  const CACHE_STORE = "catalogues";

  function openCacheDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(
          new Error("IndexedDB is not supported in this browser.")
        );

        return;
      }

      const request = indexedDB.open(
        CACHE_DB_NAME,
        CACHE_DB_VERSION
      );

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, {
            keyPath: "key",
          });
        }
      };

      request.onsuccess = () => resolve(request.result);

      request.onerror = () => {
        reject(
          request.error ||
          new Error("Could not open the local catalogue cache.")
        );
      };

      request.onblocked = () => {
        reject(
          new Error(
            "The local catalogue cache is blocked by another tab."
          )
        );
      };
    });
  }

  async function getCachedDatabase(key) {
    const db = await openCacheDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        CACHE_STORE,
        "readonly"
      );

      const request = transaction
        .objectStore(CACHE_STORE)
        .get(key);

      request.onsuccess = () => {
        resolve(request.result?.database || null);
      };

      request.onerror = () => {
        reject(
          request.error ||
          new Error("Could not read the saved catalogue.")
        );
      };

      transaction.oncomplete = () => db.close();

      transaction.onerror = () => {
        db.close();

        reject(
          transaction.error ||
          new Error("Could not read the saved catalogue.")
        );
      };

      transaction.onabort = () => {
        db.close();

        reject(
          transaction.error ||
          new Error("The saved catalogue read was aborted.")
        );
      };
    });
  }

  async function saveCachedDatabase(key, database) {
    const db = await openCacheDB();

    /*
     * Store only the fields required by the app.
     * This keeps the saved database smaller than the parsed import.
     */

    const compactDatabase = {
      genres: [...(database.genres || [])],
      sourceFiles: [...(database.sourceFiles || [])],
      importedAt: database.importedAt || new Date().toISOString(),

      movies: (database.movies || []).map((movie) => ({
        id: movie.id || "",
        title: movie.title || "",
        year: movie.year ?? null,
        certificate: movie.certificate || "",
        runtime: movie.runtime || "",
        genres: [...(movie.genres || [])],
        rating: movie.rating ?? null,
        description: movie.description || "",
        director: movie.director || "",
        stars: [...(movie.stars || [])],
        votes: Number(movie.votes) || 0,
      })),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        CACHE_STORE,
        "readwrite"
      );

      transaction.objectStore(CACHE_STORE).put({
        key,
        database: compactDatabase,
        savedAt: new Date().toISOString(),
      });

      transaction.oncomplete = () => {
        db.close();
        resolve(true);
      };

      transaction.onerror = () => {
        db.close();

        reject(
          transaction.error ||
          new Error("Could not save the catalogue on this device.")
        );
      };

      transaction.onabort = () => {
        db.close();

        reject(
          transaction.error ||
          new Error("Saving the catalogue was aborted.")
        );
      };
    });
  }

  // --------------------------------------------------
  // Public API
  // --------------------------------------------------

  window.MovieDatabase = {
    parseCSV,
    parseFile,
    fromFiles,
    mergeFiles,
    genreName,
    getCachedDatabase,
    saveCachedDatabase,
  };
})();
