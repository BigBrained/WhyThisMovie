/*
 * WhyThisMovie interface code.
 * Loads the catalogue from dataset/ on first visit and caches it
 * in IndexedDB for subsequent visits.
 *
 * Requires:
 *   - recommender.js
 *   - csv-database.js
 */

(function () {
  "use strict";

  const { recommendMetadata } = window.MovieRecommender;

  const CSV_GENRE_FILES = [
    "action",
    "adventure",
    "crime",
    "family",
    "fantasy",
    "film-noir",
    "history",
    "horror",
    "mystery",
    "scifi",
    "sports",
    "thriller",
    "war",
  ];

  const CATALOGUE_CACHE_KEY =
    `catalogue-v2:${new URL("./", document.baseURI).pathname}`;

  const $ = (selector) => document.querySelector(selector);

  const listen = (selector, eventName, handler) => {
    const element = $(selector);

    if (!element) {
      console.warn(
        `[WhyThisMovie] Missing element: ${selector}`
      );

      return null;
    }

    element.addEventListener(eventName, handler);

    return element;
  };

  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  let activeData = { movies: [] };
  let activeGenres = ["unknown"];

  let customRatings = new Map();
  let mix = 0.6;
  let genreWeights = new Float32Array(19).fill(1);
  let hiddenMovies = new Set();
  let ready = false;
  let explicitTheme = null;

  const posterCache = new Map();
  const tmdbPosterCache = new Map();
  const tmdbPosterRequests = new Map();

  let tmdbAccessToken = "";
  let posterRenderGeneration = 0;

  try {
    tmdbAccessToken =
      sessionStorage.getItem("whyThisMovieTmdbReadToken") || "";
  } catch {
    console.warn("TMDB token storage is unavailable.");
  }

  if ($("#tmdbToken")) {
    $("#tmdbToken").value = tmdbAccessToken;
  }

  const currentRatings = () => [...customRatings];

  const titleOf = (movieId) => {
    const movie = activeData.movies[movieId];

    if (!movie) return "Unknown movie";

    return movie.year
      ? `${movie.title} (${movie.year})`
      : movie.title;
  };

  const genresOf = (movieId) =>
    activeData.movies[movieId]?.genres || [];

  function starPicker(rating, attributes) {
    return `
      <span class="st" role="group" aria-label="Choose a star rating">
        ${[1, 2, 3, 4, 5].map((value) => `
          <button
            type="button"
            class="${value > rating ? "off" : ""}"
            ${attributes}
            data-r="${value}"
            aria-label="Rate ${value} out of 5 stars"
          >★</button>
        `).join("")}
      </span>`;
  }

  const genreIcons = {
    Action: "✦",
    Adventure: "⌁",
    Animation: "◈",
    Comedy: "☼",
    Crime: "⌕",
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
  };

  const escapeXml = (value) =>
    value.replace(/[&<>]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
    })[character]);

  function generatedPoster(movieId) {
    if (posterCache.has(movieId)) {
      return posterCache.get(movieId);
    }

    const fullTitle = titleOf(movieId);
    const plainTitle = fullTitle.replace(/\s*\(\d{4}\)$/, "");
    const firstGenre = genresOf(movieId)[0];

    let hue = 0;

    for (const character of fullTitle) {
      hue = (hue * 31 + character.charCodeAt(0)) % 360;
    }

    const lines = [];
    let line = "";

    for (const word of plainTitle.split(" ")) {
      if (`${line} ${word}`.trim().length > 13 && line) {
        lines.push(line);
        line = word;
      } else {
        line = `${line} ${word}`.trim();
      }
    }

    lines.push(line);

    const titleMarkup = lines.slice(0, 4).map(
      (text, index) => `
        <text
          x="42"
          y="74"
          dy="${index * 12}"
          font-size="9.5"
          font-weight="700"
          fill="#fff"
          text-anchor="middle"
          font-family="Arial, sans-serif"
        >${escapeXml(text)}</text>`
    ).join("");

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 126">
        <defs>
          <linearGradient id="poster-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="hsl(${hue}, 48%, 43%)"/>
            <stop offset="1" stop-color="hsl(${(hue + 50) % 360}, 55%, 19%)"/>
          </linearGradient>
        </defs>

        <rect width="84" height="126" fill="url(#poster-gradient)"/>
        <circle cx="42" cy="40" r="21" fill="rgba(255,255,255,0.10)"/>

        <text x="42" y="51" font-size="30" text-anchor="middle" fill="#fff">
          ${genreIcons[firstGenre] || "▣"}
        </text>

        ${titleMarkup}
      </svg>`;

    const imageUrl =
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

    posterCache.set(movieId, imageUrl);

    return imageUrl;
  }

  // --------------------------------------------------
  // TMDB poster loading
  // --------------------------------------------------

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
      const error = new Error(
        `TMDB returned HTTP ${response.status} for ${new URL(url).pathname}.`
      );

      error.status = response.status;
      error.endpoint = new URL(url).pathname;

      throw error;
    }

    return response.json();
  }

  async function requestTmdbPoster(movie, token) {
    const imdbId = String(movie?.id || "").trim();

    const cacheKey = imdbId ||
      `${normalizeMovieTitle(movie?.title)}|${movie?.year || ""}`;

    if (tmdbPosterCache.has(cacheKey)) {
      return tmdbPosterCache.get(cacheKey);
    }

    const requestKey = `${cacheKey}\u0000${token}`;

    if (tmdbPosterRequests.has(requestKey)) {
      return tmdbPosterRequests.get(requestKey);
    }

    const request = (async () => {
      let posterPath = null;

      // First try IMDb ID.
      if (/^tt\d+$/i.test(imdbId)) {
        const url = new URL(
          `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`
        );

        url.searchParams.set("external_source", "imdb_id");
        url.searchParams.set("language", "en-US");

        try {
          const found = await tmdbJSON(url.href, token);

          posterPath =
            found.movie_results?.find(
              (result) => result.poster_path
            )?.poster_path || null;
        } catch (error) {
          // A missing IMDb mapping should not prevent title search.
          if (error?.status !== 404) {
            throw error;
          }
        }
      }

      // Fall back to exact title and year search.
      if (!posterPath && movie?.title) {
        const url = new URL(
          "https://api.themoviedb.org/3/search/movie"
        );

        url.searchParams.set("query", movie.title);
        url.searchParams.set("language", "en-US");

        if (movie.year) {
          url.searchParams.set("year", String(movie.year));
        }

        const result = await tmdbJSON(url.href, token);
        const wanted = normalizeMovieTitle(movie.title);

        const exact = (result.results || []).find((item) => {
          const resultTitle = normalizeMovieTitle(
            item.title || item.original_title
          );

          const resultYear =
            Number(String(item.release_date || "").slice(0, 4)) || null;

          return (
            resultTitle === wanted &&
            (!movie.year || !resultYear ||
              resultYear === Number(movie.year)) &&
            Boolean(item.poster_path)
          );
        });

        posterPath = exact?.poster_path || null;
      }

      const posterUrl = posterPath
        ? `https://image.tmdb.org/t/p/w500${posterPath}`
        : null;

      tmdbPosterCache.set(cacheKey, posterUrl);

      return posterUrl;
    })();

    tmdbPosterRequests.set(requestKey, request);

    try {
      return await request;
    } finally {
      if (tmdbPosterRequests.get(requestKey) === request) {
        tmdbPosterRequests.delete(requestKey);
      }
    }
  }

  function configurePosterFallback(image) {
    const movieId = Number(image.dataset.m);

    image.dataset.fallbackApplied = "false";
    image.dataset.tmdbSrc = "";

    image.onerror = () => {
      if (image.dataset.fallbackApplied === "true") return;

      image.dataset.fallbackApplied = "true";
      image.src = generatedPoster(movieId);
    };

    image.src = generatedPoster(movieId);
  }

  async function refreshDisplayedPosters() {
    const generation = ++posterRenderGeneration;
    const cards = $("#cards");

    if (!cards) return;

    const images = [
      ...cards.querySelectorAll("img[data-m]")
    ];

    images.forEach(configurePosterFallback);

    const status = $("#tmdbStatus");

    if (!tmdbAccessToken) {
      if (status) {
        status.textContent =
          "Enter a TMDB API Read Access Token to load real posters.";
      }

      return;
    }

    if (!images.length) {
      if (status) {
        status.textContent =
          "Rate a few films to load posters for your recommendations.";
      }

      return;
    }

    if (status) {
      status.textContent =
        `Loading posters for ${images.length} films…`;
    }

    const results = await Promise.allSettled(
      images.map(async (image) => {
        const movie = activeData.movies[Number(image.dataset.m)];

        if (!movie) return false;

        const posterUrl = await requestTmdbPoster(
          movie,
          tmdbAccessToken
        );

        if (
          generation !== posterRenderGeneration ||
          !image.isConnected ||
          !posterUrl
        ) {
          return false;
        }

        image.dataset.tmdbSrc = posterUrl;
        image.dataset.fallbackApplied = "false";
        image.src = posterUrl;

        return true;
      })
    );

    if (generation !== posterRenderGeneration) return;

    const matched = results.filter(
      (result) =>
        result.status === "fulfilled" && result.value
    ).length;

    const errors = results.filter(
      (result) => result.status === "rejected"
    ).map((result) => result.reason);

    const authError = errors.find(
      (error) => error?.status === 401 || error?.status === 403
    );

    if (authError) {
      if (status) {
        status.textContent =
          `TMDB rejected the token (HTTP ${authError.status}).`;
      }
    } else if (errors.length) {
      const error = errors[0];

      if (status) {
        status.textContent =
          `TMDB poster loading failed${error?.status
            ? ` (HTTP ${error.status})`
            : ""}. SVG fallbacks remain available.`;
      }
    } else if (status) {
      status.textContent =
        `${matched} of ${images.length} posters loaded from TMDB.`;
    }
  }

  function applyTmdbToken() {
    const token = $("#tmdbToken")?.value.trim() || "";

    if (!token) {
      if ($("#tmdbStatus")) {
        $("#tmdbStatus").textContent = "Enter your TMDB token first.";
      }

      return;
    }

    tmdbAccessToken = token;

    try {
      sessionStorage.setItem("whyThisMovieTmdbReadToken", token);
    } catch {
      // The token remains usable for this page session.
    }

    tmdbPosterCache.clear();

    refreshDisplayedPosters();
  }

  function clearTmdbToken() {
    tmdbAccessToken = "";

    if ($("#tmdbToken")) {
      $("#tmdbToken").value = "";
    }

    try {
      sessionStorage.removeItem("whyThisMovieTmdbReadToken");
    } catch {
      // Clearing the in-memory value is sufficient.
    }

    refreshDisplayedPosters();
  }

  // --------------------------------------------------
  // Genre controls
  // --------------------------------------------------

  function buildGenreControls() {
    $("#genres").innerHTML = activeGenres.map((genre, index) => {
      if (index === 0) return "";

      return `
        <div class="gl" data-tip="${esc(genre)} influence">
          <span>${esc(genre)}</span>
          <div class="bar"><i id="pb${index}" style="width:0%"></i></div>
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

      const slider = $(`#ps${index}`);

      if (!slider) return;

      slider.addEventListener("input", (event) => {
        genreWeights[index] = Number(event.target.value) / 100;
        renderRecommendations();
      });
    });
  }

  function syncGenreControls(profile) {
    const largestValue = Math.max(
      1e-9,
      ...Array.from(profile, (value) => Math.abs(value))
    );

    activeGenres.forEach((genre, index) => {
      if (index === 0) return;

      const value = profile[index] || 0;
      const bar = $(`#pb${index}`);
      const label = $(`#pv${index}`);
      const slider = $(`#ps${index}`);

      if (!bar || !label || !slider) return;

      bar.style.width =
        `${100 * Math.abs(value) / largestValue}%`;

      bar.style.background =
        value < 0 ? "var(--danger)" : "var(--good)";

      label.textContent = `×${genreWeights[index].toFixed(1)}`;

      const target = Math.round(genreWeights[index] * 100);

      if (Number(slider.value) !== target) {
        slider.value = target;
      }
    });
  }

  // --------------------------------------------------
  // Ratings and recommendations
  // --------------------------------------------------

  function drawCustomRatings() {
    const mine = $("#mine");

    if (!mine) return;

    mine.innerHTML = [...customRatings].map(
      ([movieId, rating]) => `
        <div>
          <span>${esc(titleOf(movieId))}</span>

          ${starPicker(rating, `data-m="${movieId}"`)}

          <button
            class="chip"
            type="button"
            data-del="${movieId}"
            aria-label="Remove rating"
          >×</button>
        </div>`
    ).join("");
  }

  function renderEmptyState() {
    $("#cards").innerHTML = `
      <div class="empty-state">
        <div class="empty-state-mark" aria-hidden="true">✦</div>

        <h3>A few favourites go a long way</h3>

        <p>
          Rate two or three films you know, or add sample favourites
          to build a personal shortlist.
        </p>

        <div class="inline-actions" style="justify-content:center">
          <button class="b" type="button" data-empty-action="sample">
            Try sample favourites
          </button>

          <button class="b ghost" type="button" data-empty-action="ratings">
            Rate a film
          </button>
        </div>
      </div>`;

    $("#fav").textContent =
      "Rate a few films to see which favourites shape your recommendations.";

    $("#hid").innerHTML = "";

    syncGenreControls(new Float32Array(activeGenres.length));

    $("#lat").textContent = "Ready when you are";

    $("#cards").setAttribute("aria-busy", "false");

    refreshDisplayedPosters();
  }

  function renderRecommendations() {
    if (!ready) return;

    const startTime = performance.now();
    const ratings = currentRatings();

    $("#alphaTxt").textContent =
      `${Math.round((1 - mix) * 100)}% genre profile · ` +
      `${Math.round(mix * 100)}% similar-film details`;

    if (!ratings.length) {
      renderEmptyState();
      return;
    }

    const output = recommendMetadata(
      activeData.movies,
      ratings,
      {
        alpha: mix,
        genreNames: activeGenres,
        mult: genreWeights,
        hidden: hiddenMovies,
        explain: true,
        n: 5,
      }
    );

    $("#cards").innerHTML = output.res.map((item, index) => {
      const anchor = item.anchor;

      let explanation =
        "A strong fit from your genre profile, film details, IMDb rating and vote count.";

      if (anchor) {
        const sharedGenres = anchor.shared.length
          ? `both share <b>${anchor.shared.map(esc).join(", ")}</b> themes`
          : "have related directors, cast, or release eras";

        explanation =
          `Recommended because you rated <b>${esc(titleOf(anchor.j))}</b> ` +
          `${anchor.r} star${anchor.r > 1 ? "s" : ""} and ${sharedGenres}.`;

        if (anchor.cs > 0.05) {
          explanation +=
            ` Film-detail similarity: ${(anchor.cs * 100).toFixed(0)}%.`;
        }
      }

      const genreTags = genresOf(item.m).map(
        (genre) => `<span>${esc(genre)}</span>`
      ).join("");

      const movie = activeData.movies[item.m];

      const facts = [
        movie.certificate,
        movie.runtime,
        Number.isFinite(movie.rating)
          ? `IMDb ${movie.rating.toFixed(1)}/10`
          : "",
        movie.votes
          ? `${Number(movie.votes).toLocaleString()} votes`
          : "",
        movie.director
          ? `Dir. ${movie.director}`
          : "",
      ].filter(Boolean);

      const metadataMarkup = `
        <p class="movie-meta">${facts.map(esc).join(" · ")}</p>

        ${movie.description
          ? `<p class="movie-description">${esc(movie.description)}</p>`
          : ""}

        ${movie.stars?.length
          ? `<p class="movie-cast"><b>Starring:</b> ${esc(movie.stars.slice(0, 4).join(", "))}</p>`
          : ""}`;

      const contributionBars = item.weights.map((weight) => `
        <div class="w">
          <span>${esc(activeGenres[weight.g])}</span>
          <span class="t"><i style="width:${weight.pct}%"></i></span>
          <b>${weight.pct}%</b>
        </div>`
      ).join("");

      return `
        <article class="card" style="animation-delay:${index * 35}ms">
          <div class="poster">
            <img
              src="${generatedPoster(item.m)}"
              alt="Poster for ${esc(titleOf(item.m))}"
              data-m="${item.m}"
              loading="lazy"
              decoding="async"
            />
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
              >Less like this</button>

              <button
                class="b ghost"
                type="button"
                data-act="more"
                data-m="${item.m}"
              >More like this</button>
            </div>

            <details class="detail">
              <summary>Why this score?</summary>

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

    refreshDisplayedPosters();

    $("#hid").innerHTML = hiddenMovies.size
      ? `
        <div class="panel">
          <p class="panel-kicker">Hidden from your picks</p>

          ${[...hiddenMovies].map((movieId) => `
            <span class="chip">
              ${esc(titleOf(movieId))}

              <button
                type="button"
                data-act="unhide"
                data-m="${movieId}"
                aria-label="Restore ${esc(titleOf(movieId))}"
              >×</button>
            </span>`
          ).join("")}
        </div>`
      : "";

    $("#fav").innerHTML = ratings
      .slice()
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([movieId, rating]) => `
        <div>
          <span>${"★".repeat(rating)}</span>
          <span>${esc(titleOf(movieId))}</span>
        </div>`
      ).join("");

    syncGenreControls(output.profile);

    $("#lat").textContent =
      `Ranked ${activeData.movies.length.toLocaleString()} films · ` +
      `${(performance.now() - startTime).toFixed(1)} ms`;
  }

  function addSampleRatings() {
    const wantedGenres = [
      "Action", "Comedy", "Drama", "Sci-Fi",
      "Thriller", "Fantasy", "Crime",
    ];

    const selected = new Set();

    const candidates = activeData.movies
      .map((movie, movieId) => ({ movie, movieId }))
      .filter(({ movie }) =>
        Number.isFinite(movie.rating) && movie.rating > 0
      )
      .sort((a, b) =>
        (b.movie.rating + Math.log1p(b.movie.votes || 0) * 0.12) -
        (a.movie.rating + Math.log1p(a.movie.votes || 0) * 0.12)
      );

    for (const genre of wantedGenres) {
      const match = candidates.find(({ movieId, movie }) =>
        !selected.has(movieId) && movie.genres.includes(genre)
      );

      if (match) {
        selected.add(match.movieId);
        customRatings.set(
          match.movieId,
          match.movie.rating >= 7.8 ? 5 : 4
        );
      }

      if (selected.size >= 5) break;
    }

    for (const { movieId, movie } of candidates) {
      if (selected.size >= 5) break;
      if (selected.has(movieId)) continue;

      selected.add(movieId);

      customRatings.set(
        movieId,
        movie.rating >= 7.8 ? 5 : 4
      );
    }

    drawCustomRatings();
    renderRecommendations();
  }

  // --------------------------------------------------
  // Navigation and theme
  // --------------------------------------------------

  function switchTab(tabName) {
    document.querySelectorAll(".tabs button[data-tab]").forEach(
      (button) => {
        const selected = button.dataset.tab === tabName;

        button.classList.toggle("on", selected);
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
    );

    ["rec", "eval", "how"].forEach((name) => {
      const section = $(`#tab-${name}`);

      if (section) {
        section.classList.toggle("hide", name !== tabName);
      }
    });
  }

  function updateThemeLabel() {
    const effectiveTheme = explicitTheme || (
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
    );

    if ($("#themeToggle")) {
      $("#themeToggle").textContent =
        effectiveTheme === "dark" ? "Light theme" : "Dark theme";
    }
  }

  function switchTheme() {
    const currentTheme = explicitTheme || (
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
    );

    explicitTheme = currentTheme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = explicitTheme;

    updateThemeLabel();
  }

  function updateMixCopy() {
    $("#mixLeft").textContent = "Genre taste";
    $("#mixRight").textContent = "Similar films";

    $("#mixHelp").textContent =
      "Balance shared genres against similarities in director, cast and release era. IMDb ratings and votes help break ties.";

    $("#alpha").setAttribute(
      "aria-label",
      "Balance genre profile and similar-film details"
    );
  }

  // --------------------------------------------------
  // Loading screen
  // --------------------------------------------------

  function setLoadingScreen(
    title,
    message,
    detail = "",
    hasError = false
  ) {
    const loader = $("#appLoader");

    if (!loader) return;

    loader.classList.remove("is-done");
    loader.classList.toggle("has-error", hasError);
    loader.setAttribute("aria-hidden", "false");

    $("#loaderTitle").textContent = title;
    $("#loaderMessage").textContent = message;

    const detailNode = $("#loaderDetail");

    detailNode.textContent = detail;
    detailNode.hidden = !detail;

    $("#loaderRetry").hidden = !hasError;
  }

  function finishLoadingScreen() {
    const loader = $("#appLoader");

    if (!loader) return;

    loader.classList.remove("has-error");
    loader.classList.add("is-done");
    loader.setAttribute("aria-hidden", "true");
  }

  function applyMetadataDatabase(
    database,
    statusMessage = "loaded from this device"
  ) {
    activeData = { movies: database.movies };

    activeGenres = [
      "unknown",
      ...database.genres.filter(
        (genre) => genre.toLowerCase() !== "unknown"
      ),
    ];

    ready = true;
    customRatings.clear();
    hiddenMovies.clear();

    genreWeights = new Float32Array(activeGenres.length).fill(1);
    mix = Number($("#alpha").value) / 100;

    $("#run").disabled = true;

    $("#benchmarkHeading").textContent =
      "Benchmarking needs individual rating histories";

    $("#benchmarkCopy").textContent =
      "These CSVs provide aggregate IMDb ratings and votes, but no per-user rating history.";

    $("#evst").textContent =
      "Not available for metadata-only CSVs.";

    $("#dbStatus").textContent =
      `${database.movies.length.toLocaleString()} unique movies · ${statusMessage}.`;

    $("#q").disabled = false;
    $("#demo").disabled = false;
    $("#clr").disabled = false;
    $("#refreshCatalogue").disabled = false;

    $("#lat").textContent =
      `${database.movies.length.toLocaleString()} movies ready`;

    updateMixCopy();
    buildGenreControls();
    drawCustomRatings();
    renderRecommendations();
  }

  function showCatalogueError(message, detail = "") {
    ready = false;
    activeData = { movies: [] };

    $("#dbStatus").textContent =
      "Catalogue could not be opened. See details above.";

    $("#lat").textContent = "Catalogue unavailable";

    $("#run").disabled = true;
    $("#q").disabled = true;
    $("#demo").disabled = true;
    $("#clr").disabled = true;
    $("#refreshCatalogue").disabled = true;

    setLoadingScreen(
      "We couldn’t open your movie catalogue",
      message,
      detail,
      true
    );
  }

  // --------------------------------------------------
  // IndexedDB catalogue loading
  // --------------------------------------------------

  let catalogueLoading = false;

  async function tryLoadLocalDataset(forceRefresh = false) {
    if (catalogueLoading) return;

    catalogueLoading = true;

    const refreshButton = $("#refreshCatalogue");

    if (refreshButton) {
      refreshButton.disabled = true;
    }

    $("#q").disabled = true;
    $("#demo").disabled = true;
    $("#clr").disabled = true;

    setLoadingScreen(
      forceRefresh ? "Refreshing your catalogue" : "Getting your films ready",
      forceRefresh
        ? "Downloading the latest CSV files. Your saved catalogue remains available if this refresh fails."
        : "Checking this device for your saved catalogue."
    );

    let cachedDatabase = null;

    try {
      cachedDatabase = await window.MovieDatabase.getCachedDatabase(
        CATALOGUE_CACHE_KEY
      );
    } catch (error) {
      console.warn(
        "Could not read the local catalogue cache.",
        error
      );
    }

    if (
      cachedDatabase &&
      !forceRefresh &&
      Array.isArray(cachedDatabase.movies) &&
      cachedDatabase.movies.length
    ) {
      applyMetadataDatabase(
        cachedDatabase,
        "opened from this device’s saved copy"
      );

      finishLoadingScreen();

      catalogueLoading = false;

      if (refreshButton) {
        refreshButton.disabled = false;
      }

      return;
    }

    if (!/^https?:$/.test(window.location.protocol)) {
      if (cachedDatabase?.movies?.length) {
        applyMetadataDatabase(
          cachedDatabase,
          "opened from this device’s saved copy"
        );

        finishLoadingScreen();
      } else {
        showCatalogueError(
          "Open this site through GitHub Pages or a local HTTP server to download the catalogue.",
          "Browsers cannot fetch dataset/*.csv directly from a file:// page."
        );
      }

      catalogueLoading = false;

      if (refreshButton) {
        refreshButton.disabled = !ready;
      }

      return;
    }

    setLoadingScreen(
      forceRefresh
        ? "Refreshing your catalogue"
        : "Preparing your movie catalogue",
      forceRefresh
        ? "Downloading the latest CSV files."
        : "First visit: downloading the catalogue and saving it on this device. Later visits will use the saved copy."
    );

    try {
      let completedFiles = 0;

      const files = await Promise.all(
        CSV_GENRE_FILES.map(async (genre) => {
          const url = new URL(
            `./dataset/${genre}.csv`,
            document.baseURI
          );

          const response = await fetch(url.href, {
            cache: forceRefresh ? "reload" : "default",
          });

          if (!response.ok) {
            throw new Error(
              `${url.pathname} returned HTTP ${response.status}`
            );
          }

          const blob = await response.blob();

          completedFiles += 1;

          setLoadingScreen(
            forceRefresh
              ? "Refreshing your catalogue"
              : "Preparing your movie catalogue",
            `Downloading catalogue files (${completedFiles} of ${CSV_GENRE_FILES.length}).`
          );

          return new File(
            [blob],
            `${genre}.csv`,
            { type: "text/csv" }
          );
        })
      );

      setLoadingScreen(
        "Organising your films",
        "Combining CSV files and removing duplicate IMDb IDs."
      );

      const database = await window.MovieDatabase.fromFiles(files);

      let savedLocally = false;

      setLoadingScreen(
        "Saving your catalogue",
        "Keeping a copy on this device for faster future visits."
      );

      try {
        await window.MovieDatabase.saveCachedDatabase(
          CATALOGUE_CACHE_KEY,
          database
        );

        savedLocally = true;

        try {
          if (navigator.storage?.persist) {
            await navigator.storage.persist();
          }
        } catch {
          // Persistent-storage permission is optional.
        }
      } catch (error) {
        console.warn(
          "The catalogue loaded, but could not be saved locally.",
          error
        );
      }

      applyMetadataDatabase(
        database,
        savedLocally
          ? "saved on this device for faster future visits"
          : "loaded for this visit; browser storage was unavailable"
      );

      finishLoadingScreen();
    } catch (error) {
      if (cachedDatabase?.movies?.length) {
        applyMetadataDatabase(
          cachedDatabase,
          "using this device’s saved copy; refresh failed"
        );

        finishLoadingScreen();
      } else {
        showCatalogueError(
          "Check that all 13 CSV files are published inside the site's dataset/ folder.",
          error?.message || String(error)
        );
      }
    } finally {
      catalogueLoading = false;

      if (refreshButton) {
        refreshButton.disabled = !ready;
      }
    }
  }

  // --------------------------------------------------
  // Event handlers
  // --------------------------------------------------

  if (!$("#mine")) {
    const ratingsMount = document.createElement("div");

    ratingsMount.id = "mine";
    ratingsMount.className = "mine";

    const customBox = $("#customBox");
    const actions = $("#demo")?.parentElement;

    if (customBox) {
      if (actions?.parentElement === customBox) {
        customBox.insertBefore(ratingsMount, actions);
      } else {
        customBox.append(ratingsMount);
      }
    }
  }

  listen("#mine", "click", (event) => {
    const starButton = event.target.closest("button[data-r]");
    const removeButton = event.target.closest("button[data-del]");

    if (starButton) {
      customRatings.set(
        Number(starButton.dataset.m),
        Number(starButton.dataset.r)
      );
    }

    if (removeButton) {
      customRatings.delete(Number(removeButton.dataset.del));
    }

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

    for (
      let movieId = 0;
      movieId < activeData.movies.length && matches.length < 8;
      movieId += 1
    ) {
      if (
        titleOf(movieId).toLowerCase().includes(query) &&
        !customRatings.has(movieId)
      ) {
        matches.push(movieId);
      }
    }

    results.classList.remove("hide");

    results.innerHTML = matches.length
      ? matches.map((movieId) => `
          <div>
            <span>${esc(titleOf(movieId))}</span>
            ${starPicker(0, `data-m="${movieId}"`)}
          </div>
        `).join("")
      : '<div class="mut">No matching films. Try another title.</div>';
  });

  listen("#qres", "click", (event) => {
    const button = event.target.closest("button[data-r]");

    if (!button) return;

    customRatings.set(
      Number(button.dataset.m),
      Number(button.dataset.r)
    );

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

  listen("#cards", "click", (event) => {
    const button = event.target.closest("button[data-act]");
    const emptyAction = event.target.closest("button[data-empty-action]");

    if (emptyAction) {
      if (emptyAction.dataset.emptyAction === "sample") {
        addSampleRatings();
      } else {
        $("#q").focus();
      }

      return;
    }

    if (!button) return;

    const movieId = Number(button.dataset.m);

    genresOf(movieId).forEach((genre) => {
      const index = activeGenres.indexOf(genre);

      if (index < 0) return;

      const factor = button.dataset.act === "less" ? 0.6 : 1.4;

      genreWeights[index] = Math.min(
        3,
        Math.max(0.1, genreWeights[index] * factor)
      );
    });

    if (button.dataset.act === "less") {
      hiddenMovies.add(movieId);
    }

    renderRecommendations();
  });

  listen("#hid", "click", (event) => {
    const button = event.target.closest(
      'button[data-act="unhide"]'
    );

    if (!button) return;

    hiddenMovies.delete(Number(button.dataset.m));
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

  document.querySelectorAll(".tabs button[data-tab]").forEach(
    (button) => {
      button.addEventListener("click", () => {
        switchTab(button.dataset.tab);
      });
    }
  );

  listen("#themeToggle", "click", switchTheme);
  listen("#tmdbApply", "click", applyTmdbToken);
  listen("#tmdbClear", "click", clearTmdbToken);

  listen("#loaderRetry", "click", () => {
    tryLoadLocalDataset(false);
  });

  listen("#refreshCatalogue", "click", () => {
    tryLoadLocalDataset(true);
  });

  // Initial state.
  $("#run").disabled = true;
  $("#refreshCatalogue").disabled = true;

  $("#benchmarkHeading").textContent =
    "Benchmarking needs individual rating histories";

  $("#benchmarkCopy").textContent =
    "The dataset contains aggregate IMDb scores and votes, not per-user ratings.";

  $("#evst").textContent =
    "Unavailable for this dataset.";

  updateMixCopy();
  updateThemeLabel();

  tryLoadLocalDataset(false);
})();
