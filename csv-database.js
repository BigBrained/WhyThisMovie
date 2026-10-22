/*
 * Importer for the user's genre-split IMDb-style CSV catalogue.
 * Supports quoted commas, escaped quotes, and multiline quoted fields.
 * No dependencies or network access are required.
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
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && next === "\n") index += 1;
        row.push(field);
        field = "";
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
      } else {
        field += character;
      }
    }

    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    if (quoted) throw new Error("A CSV file ends inside a quoted field. Check the final row.");
    return rows;
  }

  const clean = (value) => String(value ?? "").trim();
  const keyOf = (value) => clean(value).toLowerCase().replace(/[\s_]+/g, " ");

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
    return trimmed.split("-").map((part) => part
      ? part[0].toUpperCase() + part.slice(1).toLowerCase()
      : part).join("-");
  }

  function numberOrNull(value) {
    const number = Number(clean(value).replace(/[$,]/g, ""));
    return Number.isFinite(number) && clean(value) !== "" ? number : null;
  }

  function parseYear(value) {
    const match = clean(value).match(/\b(18|19|20|21)\d{2}\b/);
    return match ? Number(match[0]) : null;
  }

  function parseVotes(value) {
    return Math.max(0, numberOrNull(value) || 0);
  }

  function parseStars(value) {
    return clean(value).split(/[\n,;|]+/)
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name, index, all) => all.findIndex((item) => item.toLowerCase() === name.toLowerCase()) === index);
  }

  function parseFile(text, fileName) {
    const rows = parseCSV(text);
    if (rows.length < 2) return [];

    const headers = rows[0].map((header) => keyOf(header));
    const column = (...names) => names.map((name) => headers.indexOf(keyOf(name))).find((index) => index >= 0) ?? -1;
    const columns = {
      id: column("movie_id", "imdb_id", "id"),
      title: column("movie_name", "movie_title", "title", "name"),
      year: column("year", "release_year"),
      certificate: column("certificate", "certification", "content_rating"),
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
      throw new Error(`${fileName}: couldn't find a movie title column (expected movie_name).`);
    }

    const filename = String(fileName).split(/[\\/]/).pop().replace(/\.csv$/i, "").toLowerCase();
    const fallbackGenre = FILE_GENRES[filename] || "";

    return rows.slice(1).map((cells) => {
      const read = (key) => columns[key] < 0 ? "" : clean(cells[columns[key]]);
      const title = read("title");
      if (!title) return null;

      const rawGenres = read("genre").split(",").map(genreName).filter(Boolean);
      const genres = [...new Set(rawGenres.length ? rawGenres : [fallbackGenre].filter(Boolean))];

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

  function mergeFiles(fileRows) {
    const byKey = new Map();
    const movies = [];

    for (const { name, rows } of fileRows) {
      for (const movie of rows) {
        const fallbackKey = `${keyOf(movie.title)}|${movie.year ?? ""}`;
        const key = movie.id ? `id:${movie.id.toLowerCase()}` : `title:${fallbackKey}`;
        const current = byKey.get(key);

        if (!current) {
          const entry = { ...movie, sources: [name] };
          byKey.set(key, entry);
          movies.push(entry);
          continue;
        }

        current.sources.push(name);
        current.genres = [...new Set([...current.genres, ...movie.genres])];
        current.stars = [...new Set([...current.stars, ...movie.stars])];

        for (const field of ["year", "rating", "votes", "certificate", "runtime", "description", "director", "gross", "id"]) {
          const existingEmpty = current[field] === null || current[field] === undefined || current[field] === "" || current[field] === 0;
          const incomingPresent = movie[field] !== null && movie[field] !== undefined && movie[field] !== "" && movie[field] !== 0;
          if (existingEmpty && incomingPresent) current[field] = movie[field];
        }
      }
    }

    const genreSet = new Set();
    movies.forEach((movie, index) => {
      movie.genres = [...new Set(movie.genres.map(genreName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      movie.sources = [...new Set(movie.sources)];
      movie.posterIndex = index;
      movie.searchText = [movie.title, movie.year, movie.director, ...movie.stars, ...movie.genres]
        .filter(Boolean).join(" ").toLowerCase();
      movie.genres.forEach((genre) => genreSet.add(genre));
    });

    return {
      movies,
      genres: [...genreSet].sort((a, b) => a.localeCompare(b)),
      sourceFiles: fileRows.map((file) => file.name),
      importedAt: new Date().toISOString(),
    };
  }

  async function fromFiles(files) {
    const csvFiles = [...files]
      .filter((file) => /\.csv$/i.test(file.name))
      .sort((left, right) => {
        const leftPath = left.webkitRelativePath || left.name;
        const rightPath = right.webkitRelativePath || right.name;
        return leftPath.localeCompare(rightPath);
      });

    if (!csvFiles.length) throw new Error("No CSV files were loaded from dataset/. Check that the genre CSV files exist in that directory.");

    const fileRows = [];
    for (const file of csvFiles) {
      const text = await file.text();
      fileRows.push({
        name: file.webkitRelativePath || file.name,
        rows: parseFile(text, file.name),
      });
    }

    const result = mergeFiles(fileRows);
    if (!result.movies.length) throw new Error("The selected CSV files did not contain any movie rows.");
    return result;
  }

  window.MovieDatabase = { parseCSV, parseFile, fromFiles, mergeFiles, genreName };
})();
