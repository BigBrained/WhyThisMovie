/*
 * WhyThisMovie interface code. The CSV catalogue is loaded automatically from dataset/.
 * Recommendation calculations live in recommender.js; CSV parsing lives in csv-database.js.
 */
(function () {
  "use strict";

  const { recommendMetadata } = window.MovieRecommender;
  const CSV_GENRE_FILES = [
    "action", "adventure", "crime", "family", "fantasy", "film-noir",
    "history", "horror", "mystery", "scifi", "sports", "thriller", "war",
  ];
  const $ = (selector) => document.querySelector(selector);
  const listen = (selector, eventName, handler) => {
    const element = $(selector);
    if (!element) {
      console.warn(`[WhyThisMovie] Cannot bind ${eventName}: ${selector} is missing from index.html. Check that the HTML and JavaScript files are from the same release.`);
      return null;
    }
    element.addEventListener(eventName, handler);
    return element;
  };
  const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

  let activeData = { movies: [] };
  let activeGenres = ["unknown"];

  const titleOf = (movieId) => {
    const movie = activeData.movies[movieId];
    if (!movie) return "Unknown movie";
    return movie.year ? `${movie.title} (${movie.year})` : movie.title;
  };
  const genresOf = (movieId) => activeData.movies[movieId]?.genres || [];

  let customRatings = new Map();
  let mix = 0.6;
  let genreWeights = new Float32Array(19).fill(1);
  let hiddenMovies = new Set();
  let ready = false;
  let explicitTheme = null;

  const posterCache = new Map();
  // TMDB poster paths are independent of a user's token, so cache successful lookups
  // and confirmed no-poster results for this page session. In-flight requests are shared
  // when the recommendation list changes quickly (for example, while moving the mix slider).
  const tmdbPosterCache = new Map();
  const tmdbPosterRequests = new Map();
  let tmdbAccessToken = "";
  let posterRenderGeneration = 0;
  try {
    tmdbAccessToken = sessionStorage.getItem("whyThisMovieTmdbReadToken") || "";
  } catch (error) {
    console.warn("[WhyThisMovie] Session storage is unavailable; the TMDB token will not persist across page refreshes.");
  }
  if ($("#tmdbToken")) $("#tmdbToken").value = tmdbAccessToken;

  const currentRatings = () => [...customRatings];

  function starPicker(rating, attributes) {
    const buttons = [1, 2, 3, 4, 5].map((value) => {
      const state = value > rating ? "off" : "";
      return `
        <button
          type="button"
          class="${state}"
          ${attributes}
          data-r="${value}"
          aria-label="Rate ${value} out of 5 stars"
          title="${value} star${value === 1 ? "" : "s"}"
        >★</button>`;
    });

    return `<span class="st" role="group" aria-label="Choose a star rating">${buttons.join("")}</span>`;
  }

  const genreIcons = {
    Action: "✦",
    Adventure: "⌁",
    Animation: "◈",
    "Children’s": "❋",
    Comedy: "☼",
    Crime: "⌕",
    Documentary: "▧",
    Drama: "◉",
    Fantasy: "✧",
    "Film-Noir": "◐",
    Horror: "◌",
    Musical: "♫",
    Mystery: "⌖",
    Romance: "♡",
    "Sci-Fi": "⌬",
    Thriller: "⚡",
    War: "▥",
    Western: "⌂",
  };

  const escapeXml = (value) => value.replace(/[&<>]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]);

  function generatedPoster(movieId) {
    if (posterCache.has(movieId)) return posterCache.get(movieId);

    const fullTitle = titleOf(movieId);
    const plainTitle = fullTitle.replace(/\s*\(\d{4}\)$/, "");
    const firstGenre = genresOf(movieId)[0];
    let hue = 0;

    for (const character of fullTitle) {
      hue = (hue * 31 + character.charCodeAt(0)) % 360;
    }

    const titleLines = [];
    let currentLine = "";

    for (const word of plainTitle.split(" ")) {
      if (`${currentLine} ${word}`.trim().length > 13 && currentLine) {
        titleLines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = `${currentLine} ${word}`.trim();
      }
    }
    titleLines.push(currentLine);

    const titleMarkup = titleLines.slice(0, 4).map((line, index) => `
      <text
        x="42"
        y="74"
        dy="${index * 12}"
        font-size="9.5"
        font-weight="700"
        fill="#fff"
        text-anchor="middle"
        font-family="Arial, sans-serif"
      >${escapeXml(line)}</text>`).join("");

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 126">
        <defs>
          <linearGradient id="poster-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="hsl(${hue}, 48%, 43%)" />
            <stop offset="1" stop-color="hsl(${(hue + 50) % 360}, 55%, 19%)" />
          </linearGradient>
        </defs>
        <rect width="84" height="126" fill="url(#poster-gradient)" />
        <circle cx="42" cy="40" r="21" fill="rgba(255,255,255,0.10)" />
        <text x="42" y="51" font-size="30" text-anchor="middle" fill="#fff">
          ${genreIcons[firstGenre] || "▣"}
        </text>
        ${titleMarkup}
      </svg>`;

    const imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    posterCache.set(movieId, imageUrl);
    return imageUrl;
  }


  function normalizeMovieTitle(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  async function tmdbJSON(url, token) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const endpoint = new URL(url).pathname;
      const error = new Error(`TMDB returned HTTP ${response.status} for ${endpoint}.`);
      error.status = response.status;
      error.endpoint = endpoint;
      throw error;
    }

    return response.json();
  }

  async function requestTmdbPoster(movie, token) {
    const imdbId = String(movie?.id || "").trim();
    const cacheKey = imdbId || `${normalizeMovieTitle(movie?.title)}|${movie?.year || ""}`;
    if (tmdbPosterCache.has(cacheKey)) return tmdbPosterCache.get(cacheKey);

    const requestKey = `${cacheKey}\u0000${token}`;
    if (tmdbPosterRequests.has(requestKey)) return tmdbPosterRequests.get(requestKey);

    const request = (async () => {
      let posterPath = null;

      if (/^tt\d+$/i.test(imdbId)) {
        const findUrl = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
        findUrl.searchParams.set("external_source", "imdb_id");
        findUrl.searchParams.set("language", "en-US");
        try {
          const found = await tmdbJSON(findUrl.href, token);
          posterPath = found.movie_results?.find((result) => result.poster_path)?.poster_path || null;
        } catch (error) {
          // TMDB can return 404 for an IMDb ID it cannot resolve. Treat that as
          // a failed ID lookup, not a fatal poster error: title/year search below
          // is the intended fallback. Authentication and other API errors remain visible.
          if (error?.status !== 404) throw error;
        }
      }

      // Some CSV IDs are absent or unmapped. Search by title/year, but only accept an
      // exact normalized title match to avoid displaying a poster for a different film.
      if (!posterPath && movie?.title) {
        const searchUrl = new URL("https://api.themoviedb.org/3/search/movie");
        searchUrl.searchParams.set("query", movie.title);
        searchUrl.searchParams.set("language", "en-US");
        if (movie.year) searchUrl.searchParams.set("year", String(movie.year));
        const search = await tmdbJSON(searchUrl.href, token);
        const wanted = normalizeMovieTitle(movie.title);
        const exact = (search.results || []).find((result) => {
          const resultTitle = normalizeMovieTitle(result.title || result.original_title);
          const resultYear = Number(String(result.release_date || "").slice(0, 4)) || null;
          return resultTitle === wanted && (!movie.year || !resultYear || resultYear === Number(movie.year)) && result.poster_path;
        });
        posterPath = exact?.poster_path || null;
      }

      const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
      tmdbPosterCache.set(cacheKey, posterUrl);
      return posterUrl;
    })();

    tmdbPosterRequests.set(requestKey, request);
    try {
      return await request;
    } finally {
      if (tmdbPosterRequests.get(requestKey) === request) tmdbPosterRequests.delete(requestKey);
    }
  }

  function configurePosterFallback(image) {
    const movieId = Number(image.dataset.m);
    image.dataset.tmdbSrc = "";
    image.dataset.fallbackApplied = "false";

    // Posters are fetched directly from TMDB; no posters/ directory is required.
    // Generated SVG artwork is the placeholder and the fallback if TMDB has no image.
    image.onerror = () => {
      if (image.dataset.fallbackApplied === "true") return;
      image.dataset.fallbackApplied = "true";
      image.dataset.tmdbSrc = "";
      image.src = generatedPoster(movieId);
    };

    image.src = generatedPoster(movieId);
  }

  async function refreshDisplayedPosters() {
    const generation = ++posterRenderGeneration;
    const images = [...$("#cards").querySelectorAll("img[data-m]")];
    images.forEach(configurePosterFallback);

    const status = $("#tmdbStatus");
    if (!tmdbAccessToken) {
      if (status) status.textContent = "Enter a TMDB API Read Access Token to fetch real posters. Generated SVG artwork is shown until then.";
      return;
    }

    if (status) status.textContent = `Looking up posters for ${images.length} displayed films on TMDB…`;
    if (!images.length) {
      if (status) status.textContent = "Your current shortlist has no films to look up yet. Rate a few films first.";
      return;
    }

    const results = await Promise.allSettled(images.map(async (image) => {
      const movieId = Number(image.dataset.m);
      const movie = activeData.movies[movieId];
      if (!movie) return false;

      const posterUrl = await requestTmdbPoster(movie, tmdbAccessToken);
      if (generation !== posterRenderGeneration || !image.isConnected) return false;
      if (!posterUrl) return false;

      image.dataset.tmdbSrc = posterUrl;
      image.dataset.fallbackApplied = "false";
      image.src = posterUrl;
      return true;
    }));

    if (generation !== posterRenderGeneration) return;
    const matched = results.filter((result) => result.status === "fulfilled" && result.value).length;
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    const authError = errors.find((error) => error?.status === 401 || error?.status === 403);
    if (authError) {
      if (status) status.textContent = `TMDB rejected this token (HTTP ${authError.status}). Check your API Read Access Token. Generated SVG fallback remains active.`;
    } else if (errors.length) {
      const first = errors[0];
      const endpoint = first?.endpoint ? ` at ${first.endpoint}` : "";
      if (status) status.textContent = `TMDB could not load some posters${first?.status ? ` (HTTP ${first.status}${endpoint})` : ""}. Generated SVG fallback remains active.`;
    } else if (status) {
      status.textContent = matched
        ? `TMDB posters loaded for ${matched} of ${images.length} displayed films. Movies without a match use generated SVG posters.`
        : "No matching TMDB posters were found for this shortlist. Generated SVG fallback remains active.";
    }
  }

  function applyTmdbToken() {
    const token = $("#tmdbToken")?.value.trim() || "";
    if (!token) {
      if ($("#tmdbStatus")) $("#tmdbStatus").textContent = "Paste your TMDB API Read Access Token first.";
      return;
    }

    tmdbAccessToken = token;
    try {
      sessionStorage.setItem("whyThisMovieTmdbReadToken", token);
    } catch (error) {
      // The active token still works even when session storage is blocked.
    }
    refreshDisplayedPosters();
  }

  function clearTmdbToken() {
    tmdbAccessToken = "";
    if ($("#tmdbToken")) $("#tmdbToken").value = "";
    try {
      sessionStorage.removeItem("whyThisMovieTmdbReadToken");
    } catch (error) {
      // Clearing the in-memory token is still sufficient for this page.
    }
    refreshDisplayedPosters();
  }

  function buildGenreControls() {
    $("#genres").innerHTML = activeGenres.map((genre, index) => {
      if (index === 0) return "";

      return `
        <div
          class="gl"
          data-tip="${esc(genre)}: the bar shows how much your ratings favour it. Set its influence from ×0 to ×3."
        >
          <span>${esc(genre)}</span>
          <div class="bar"><i id="pb${index}" style="width: 0%"></i></div>
          <span id="pv${index}">×1.0</span>
          <input
            type="range"
            id="ps${index}"
            min="0"
            max="300"
            value="100"
            aria-label="${esc(genre)} influence"
          />
        </div>`;
    }).join("");

    activeGenres.forEach((genre, index) => {
      if (index === 0) return;

      $(`#ps${index}`).addEventListener("input", (event) => {
        genreWeights[index] = Number(event.target.value) / 100;
        renderRecommendations();
      });
    });
  }

  function syncGenreControls(profile) {
    const largestValue = Math.max(1e-9, ...Array.from(profile, (value) => Math.abs(value)));

    activeGenres.forEach((genre, index) => {
      if (index === 0) return;

      const profileValue = profile[index] || 0;
      $(`#pb${index}`).style.width = `${(100 * Math.abs(profileValue)) / largestValue}%`;
      $(`#pb${index}`).style.background = profileValue < 0 ? "var(--danger)" : "var(--good)";
      $(`#pv${index}`).textContent = `×${genreWeights[index].toFixed(1)}`;

      const slider = $(`#ps${index}`);
      const targetValue = Math.round(genreWeights[index] * 100);
      if (Number(slider.value) !== targetValue) slider.value = targetValue;
    });
  }

  function renderEmptyState() {
    $("#cards").innerHTML = `
      <div class="empty-state">
        <div class="empty-state-mark" aria-hidden="true">✦</div>
        <h3>A few favourites go a long way</h3>
        <p>Rate two or three films you know, or add the sample favourites to start building a personal shortlist.</p>
        <div class="inline-actions" style="justify-content: center;">
          <button class="b" type="button" data-empty-action="sample">Try sample favourites</button>
          <button class="b ghost" type="button" data-empty-action="ratings">Rate a film</button>
        </div>
      </div>`;

    $("#fav").textContent = "Rate a few films to see the favourites that shape your recommendations.";
    $("#hid").innerHTML = "";
    syncGenreControls(new Float32Array(activeGenres.length));
    $("#lat").textContent = "Ready when you are";
    $("#cards").setAttribute("aria-busy", "false");
  }

  function renderRecommendations() {
    if (!ready) return;

    const startTime = performance.now();
    const ratings = currentRatings();

    $("#alphaTxt").textContent = `${Math.round((1 - mix) * 100)}% genre profile · ${Math.round(mix * 100)}% similar-film details`;

    if (!ratings.length) {
      renderEmptyState();
      return;
    }

    const output = recommendMetadata(activeData.movies, ratings, {
      alpha: mix,
      genreNames: activeGenres,
      mult: genreWeights,
      hidden: hiddenMovies,
      explain: true,
      n: 5,
    });

    $("#cards").innerHTML = output.res.map((item, index) => {
      const anchor = item.anchor;
      let explanation = "A strong fit from your genre profile, film details, IMDb rating and vote count.";

      if (anchor) {
        const sharedGenres = anchor.shared.length
          ? `both share <b>${anchor.shared.map(esc).join(", ")}</b> themes`
          : "have related details such as director, cast, or release era";

        explanation = `Recommended because you rated <b>${esc(titleOf(anchor.j))}</b> ${anchor.r} star${anchor.r > 1 ? "s" : ""} and ${sharedGenres}.`;

        if (anchor.cs > 0.05) {
          explanation += ` Film-detail similarity: ${(anchor.cs * 100).toFixed(0)}%.`;
        }
      }

      const genreTags = genresOf(item.m).map((genre) => (
        `<span>${esc(genre)}</span>`
      )).join("");
      const metadata = activeData.movies[item.m];
      const metadataFacts = metadata ? [
        metadata.certificate,
        metadata.runtime,
        Number.isFinite(metadata.rating) ? `IMDb ${metadata.rating.toFixed(1)}/10` : "",
        metadata.votes ? `${Number(metadata.votes).toLocaleString()} votes` : "",
        metadata.director ? `Dir. ${metadata.director}` : "",
      ].filter(Boolean) : [];
      const metadataMarkup = metadata ? `
        <p class="movie-meta">${metadataFacts.map(esc).join(" · ")}</p>
        ${metadata.description ? `<p class="movie-description">${esc(metadata.description)}</p>` : ""}
        ${metadata.stars?.length ? `<p class="movie-cast"><b>Starring:</b> ${esc(metadata.stars.slice(0, 4).join(", "))}</p>` : ""}` : "";

      const contributionBars = item.weights.map((weight) => `
        <div class="w">
          <span>${esc(activeGenres[weight.g])}</span>
          <span class="t"><i style="width: ${weight.pct}%"></i></span>
          <b>${weight.pct}%</b>
        </div>`).join("");

      return `
        <article class="card" style="animation-delay: ${index * 35}ms">
          <div class="poster">
            <img src="${generatedPoster(item.m)}" alt="Poster for ${esc(titleOf(item.m))}" data-m="${item.m}" loading="lazy" decoding="async" />
            <b aria-label="Recommendation ${index + 1}">${index + 1}</b>
          </div>

          <div class="body">
            <h4>${esc(titleOf(item.m))}</h4>
            <div class="tags" aria-label="Genres">${genreTags}</div>
            ${metadataMarkup}
            <p class="why">${explanation}</p>

            <div class="acts">
              <button
                class="b bad"
                type="button"
                data-act="less"
                data-m="${item.m}"
                data-tip="Hide this film and reduce the influence of its genres."
              >Less like this</button>
              <button
                class="b ghost"
                type="button"
                data-act="more"
                data-m="${item.m}"
                data-tip="Give this film's genres more influence in future picks."
              >More like this</button>
            </div>

            <details class="detail">
              <summary data-tip="See the genre contribution and a breakdown of the recommendation score.">
                Why this score?
              </summary>
              ${contributionBars}
              <div class="comp">
                <span>Score <b>${item.score.toFixed(2)}</b></span>
                <span>Genre match <b>${item.content.toFixed(2)}</b></span>
                <span>Film similarity <b>${item.cfN.toFixed(2)}</b></span>
                <span>IMDb quality <b>${item.qual.toFixed(2)}</b></span>
              </div>
            </details>
          </div>
        </article>`;
    }).join("");

    $("#cards").setAttribute("aria-busy", "false");
    // Fetch posters directly from TMDB when a token is available.
    // Missing/failed TMDB images use the generated SVG artwork; no local poster files are required.
    refreshDisplayedPosters();

    $("#hid").innerHTML = hiddenMovies.size
      ? `
        <div class="panel" style="padding: 14px 16px; margin-bottom: 15px;">
          <p class="panel-kicker">Hidden from your picks</p>
          ${[...hiddenMovies].map((movieId) => `
            <span class="chip">
              ${esc(titleOf(movieId))}
              <button type="button" data-act="unhide" data-m="${movieId}" aria-label="Restore ${esc(titleOf(movieId))}" title="Restore this film">×</button>
            </span>`).join("")}
        </div>`
      : "";

    $("#fav").innerHTML = ratings
      .slice()
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([movieId, rating]) => `
        <div>
          <span aria-label="${rating} out of 5 stars">${"★".repeat(rating)}</span>
          <span>${esc(titleOf(movieId))}</span>
        </div>`)
      .join("");

    syncGenreControls(output.profile);
    $("#lat").textContent = `Ranked ${activeData.movies.length.toLocaleString()} films · ${(performance.now() - startTime).toFixed(1)} ms`;
  }

  function drawCustomRatings() {
    $("#mine").innerHTML = [...customRatings].map(([movieId, rating]) => `
      <div>
        <span>${esc(titleOf(movieId))}</span>
        ${starPicker(rating, `data-m="${movieId}"`)}
        <button class="chip" type="button" data-del="${movieId}" aria-label="Remove ${esc(titleOf(movieId))}" title="Remove rating">×</button>
      </div>`).join("");
  }

  function addSampleRatings() {
    const wantedGenres = ["Action", "Comedy", "Drama", "Sci-Fi", "Thriller", "Fantasy", "Crime"];
    const selected = new Set();
    const candidates = activeData.movies.map((movie, movieId) => ({ movie, movieId }))
      .filter(({ movie }) => Number.isFinite(movie.rating) && movie.rating > 0)
      .sort((left, right) => {
        const leftVotes = Math.log1p(left.movie.votes || 0);
        const rightVotes = Math.log1p(right.movie.votes || 0);
        return ((right.movie.rating || 0) + rightVotes * 0.12) - ((left.movie.rating || 0) + leftVotes * 0.12);
      });

    for (const genre of wantedGenres) {
      const match = candidates.find(({ movieId, movie }) => !selected.has(movieId) && movie.genres.includes(genre));
      if (match) {
        selected.add(match.movieId);
        customRatings.set(match.movieId, match.movie.rating >= 7.8 ? 5 : 4);
        if (selected.size >= 5) break;
      }
    }
    for (const { movieId, movie } of candidates) {
      if (selected.size >= 5) break;
      if (selected.has(movieId)) continue;
      selected.add(movieId);
      customRatings.set(movieId, movie.rating >= 7.8 ? 5 : 4);
    }

    drawCustomRatings();
    renderRecommendations();
  }

  function switchTab(tabName) {
    document.querySelectorAll(".tabs button[data-tab]").forEach((button) => {
      const selected = button.dataset.tab === tabName;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });

    ["rec", "eval", "how"].forEach((name) => {
      $(`#tab-${name}`).classList.toggle("hide", name !== tabName);
    });
  }

  function updateThemeLabel() {
    const effectiveTheme = explicitTheme || (
      window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    );
    $("#themeToggle").textContent = effectiveTheme === "dark" ? "Light theme" : "Dark theme";
  }

  function switchTheme() {
    const currentTheme = explicitTheme || (
      window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    );
    explicitTheme = currentTheme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = explicitTheme;
    updateThemeLabel();
  }

  function updateMixCopy() {
    $("#mixLeft").textContent = "Genre taste";
    $("#mixRight").textContent = "Similar films";
    $("#mixHelp").textContent = "Balance shared genres against similarities in director, cast and release era. IMDb ratings and votes help break ties.";
    $("#alpha").setAttribute("aria-label", "Balance genre profile and similar-film details");
  }

  function applyMetadataDatabase(database, importedBy = "dataset/") {
    activeData = { movies: database.movies };
    activeGenres = ["unknown", ...database.genres.filter((genre) => genre.toLowerCase() !== "unknown")];
    ready = true;
    customRatings.clear();
    hiddenMovies.clear();
    genreWeights = new Float32Array(activeGenres.length).fill(1);
    mix = Number($("#alpha").value) / 100;

    $("#run").disabled = true;
    $("#benchmarkHeading").textContent = "Benchmarking needs individual rating histories";
    $("#benchmarkCopy").textContent = "These CSVs provide movie details, aggregate IMDb ratings and votes, but no per-user rating history. The app therefore cannot run the same held-out user-rating test on this source.";
    $("#evst").textContent = "Not available for metadata-only CSVs.";
    $("#dbStatus").textContent = `Loaded ${database.movies.length.toLocaleString()} unique movies from ${database.sourceFiles.length} CSV files (${importedBy}).`;
    $("#q").disabled = false;
    $("#demo").disabled = false;
    $("#clr").disabled = false;
    $("#lat").textContent = `IMDb catalogue · ${database.movies.length.toLocaleString()} movies`;
    updateMixCopy();
    buildGenreControls();
    drawCustomRatings();
    renderRecommendations();
  }

  function showDatasetUnavailable(message) {
    ready = false;
    activeData = { movies: [] };
    $("#dbStatus").textContent = message;
    $("#lat").textContent = "Dataset not loaded";
    $("#cards").innerHTML = `
      <div class="empty-state">
        <div class="empty-state-mark" aria-hidden="true">▤</div>
        <h3>Your dataset is not loaded yet</h3>
        <p>Put the 13 genre CSV files in <code>dataset/</code> beside <code>index.html</code>, then start the local server using the instructions in <code>README.md</code>.</p>
      </div>`;
    $("#cards").setAttribute("aria-busy", "false");
    $("#fav").textContent = "Your rated films will appear here once the catalogue is loaded.";
    $("#run").disabled = true;
    $("#q").disabled = true;
    $("#demo").disabled = true;
    $("#clr").disabled = true;
  }

  async function tryLoadLocalDataset() {
    // Browsers block fetch() from file:// pages. Serve the project locally instead;
    // the app always reads its CSVs from ./dataset and never asks for a folder.
    if (!/^https?:$/.test(window.location.protocol)) {
      showDatasetUnavailable("Start the local server to load dataset/*.csv automatically. From this project folder, run: python -m http.server 8000, then open http://localhost:8000.");
      return;
    }

    $("#dbStatus").textContent = "Loading CSV files from dataset/…";
    try {
      const files = await Promise.all(CSV_GENRE_FILES.map(async (genre) => {
        const path = `dataset/${genre}.csv`;
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) throw new Error(`${path} not found (HTTP ${response.status})`);
        return new File([await response.text()], `${genre}.csv`, { type: "text/csv" });
      }));
      const database = await window.MovieDatabase.fromFiles(files);
      applyMetadataDatabase(database, "automatic dataset/ load");
    } catch (error) {
      showDatasetUnavailable(`Could not load dataset/*.csv: ${error.message || error}. Check that all 13 CSV files are directly inside the project's dataset/ folder.`);
    }
  }

  // Keep the interface resilient if index.html and app.js were copied from
  // different project revisions. The ratings mount is not present in a few
  // older HTML copies, so create it beside the rating actions when necessary.
  if (!$("#mine")) {
    const ratingsMount = document.createElement("div");
    ratingsMount.id = "mine";
    ratingsMount.className = "mine";
    ratingsMount.setAttribute("aria-live", "polite");

    const customBox = $("#customBox");
    const actions = $("#demo")?.parentElement;

    if (customBox) {
      if (actions && actions.parentElement === customBox) {
        customBox.insertBefore(ratingsMount, actions);
      } else {
        customBox.append(ratingsMount);
      }
    } else {
      console.error("[WhyThisMovie] Missing #customBox in index.html. Ensure index.html and app.js are from the same project version.");
    }
  }

  // Live ratings and search
  listen("#mine", "click", (event) => {
    const starButton = event.target.closest("button[data-r]");
    const removeButton = event.target.closest("button[data-del]");

    if (starButton) {
      customRatings.set(Number(starButton.dataset.m), Number(starButton.dataset.r));
    }
    if (removeButton) customRatings.delete(Number(removeButton.dataset.del));

    if (starButton || removeButton) {
      drawCustomRatings();
      renderRecommendations();
    }
  });

  listen("#q", "input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    const results = $("#qres");

    if (query.length < 2) {
      results.classList.add("hide");
      results.innerHTML = "";
      return;
    }

    const matches = [];
    for (let movieId = 0; movieId < activeData.movies.length && matches.length < 8; movieId += 1) {
      if (titleOf(movieId).toLowerCase().includes(query) && !customRatings.has(movieId)) {
        matches.push(movieId);
      }
    }

    results.classList.remove("hide");
    results.innerHTML = matches.length
      ? matches.map((movieId) => `
          <div>
            <span>${esc(titleOf(movieId))}</span>
            ${starPicker(0, `data-m="${movieId}"`)}
          </div>`).join("")
      : '<div class="mut">No matching films. Try another title.</div>';
  });

  listen("#qres", "click", (event) => {
    const starButton = event.target.closest("button[data-r]");
    if (!starButton) return;

    customRatings.set(Number(starButton.dataset.m), Number(starButton.dataset.r));
    $("#q").value = "";
    $("#qres").classList.add("hide");
    $("#qres").innerHTML = "";
    drawCustomRatings();
    renderRecommendations();
  });

  listen("#demo", "click", addSampleRatings);
  listen("#clr", "click", () => {
    customRatings.clear();
    drawCustomRatings();
    renderRecommendations();
  });

  // Recommendation feedback
  listen("#cards", "click", (event) => {
    const actionButton = event.target.closest("button[data-act]");
    const emptyAction = event.target.closest("button[data-empty-action]");

    if (emptyAction) {
      if (emptyAction.dataset.emptyAction === "sample") {
        addSampleRatings();
      } else {
        $("#q").focus();
      }
      return;
    }

    if (!actionButton) return;

    const movieId = Number(actionButton.dataset.m);
    const relatedGenres = genresOf(movieId);

    relatedGenres.forEach((genre) => {
      const genreIndex = activeGenres.indexOf(genre);
      const factor = actionButton.dataset.act === "less" ? 0.6 : 1.4;
      genreWeights[genreIndex] = Math.min(3, Math.max(0.1, genreWeights[genreIndex] * factor));
    });

    if (actionButton.dataset.act === "less") hiddenMovies.add(movieId);
    renderRecommendations();
  });

  listen("#hid", "click", (event) => {
    const restoreButton = event.target.closest('button[data-act="unhide"]');
    if (!restoreButton) return;

    hiddenMovies.delete(Number(restoreButton.dataset.m));
    renderRecommendations();
  });

  listen("#reset", "click", () => {
    genreWeights.fill(1);
    hiddenMovies.clear();
    renderRecommendations();
  });

  listen("#alpha", "input", (event) => {
    mix = Number(event.target.value) / 100;
    renderRecommendations();
  });

  // Navigation, theme, and benchmark
  document.querySelectorAll(".tabs button[data-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  listen("#themeToggle", "click", switchTheme);
  listen("#tmdbApply", "click", applyTmdbToken);
  listen("#tmdbClear", "click", clearTmdbToken);
  updateThemeLabel();

  // Always use the project's dataset/ directory. There is no folder picker or bundled catalogue.
  window.setTimeout(() => {
    $("#run").disabled = true;
    $("#benchmarkHeading").textContent = "Benchmarking needs individual rating histories";
    $("#benchmarkCopy").textContent = "The dataset has IMDb aggregate scores and vote counts, not the user-by-user ratings required for a valid 80/20 benchmark.";
    $("#evst").textContent = "Unavailable for this dataset.";
    updateMixCopy();
    showDatasetUnavailable("Looking for dataset/*.csv. The CSV files must be inside the project's dataset/ directory; start the local server to load them.");
    tryLoadLocalDataset();
  }, 0);
})();
