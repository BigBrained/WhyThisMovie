/*
 * Metadata-based recommendation scoring for the user-provided CSV catalogue.
 * No bundled movie data or DOM dependencies are used here.
 */
(function () {
  "use strict";

  function recommendMetadata(movies, ratings, options = {}) {
    const genreNames = options.genreNames || [];
    const genreWeights = options.mult || new Float32Array(genreNames.length).fill(1);
    const hidden = options.hidden || new Set();
    const limit = options.n || 5;
    const alpha = options.alpha ?? 0.6;
    const seen = new Set(ratings.map(([movieId]) => movieId));
    const genreIndex = new Map(genreNames.map((name, index) => [String(name).toLowerCase(), index]));

    const vectors = movies.map((movie) => {
      const vector = new Float32Array(genreNames.length);
      for (const genre of movie.genres || []) {
        const index = genreIndex.get(String(genre).toLowerCase());
        if (index !== undefined) vector[index] = 1;
      }
      return vector;
    });

    const lengths = vectors.map((vector) => Math.hypot(...vector) || 1);
    const profile = new Float32Array(genreNames.length);

    for (const [movieId, rating] of ratings) {
      const movie = movies[movieId];
      if (!movie) continue;
      const signal = rating - 3;
      for (let genre = 0; genre < genreNames.length; genre += 1) {
        profile[genre] += signal * vectors[movieId][genre];
      }
    }

    const weightedProfile = profile.map((value, genre) => value * (genreWeights[genre] ?? 1));
    const profileLength = Math.hypot(...weightedProfile);
    const positiveRatings = ratings.filter(([, rating]) => rating >= 4)
      .sort((left, right) => right[1] - left[1]);
    const fallbackRatings = ratings.filter(([, rating]) => rating >= 3)
      .sort((left, right) => right[1] - left[1]);
    const anchorRatings = (positiveRatings.length ? positiveRatings : fallbackRatings).slice(0, 40);

    const ratedRows = movies.filter((movie) => Number.isFinite(movie.rating) && movie.rating > 0);
    const globalMean = ratedRows.length
      ? ratedRows.reduce((sum, movie) => sum + movie.rating, 0) / ratedRows.length
      : 6.5;
    const maxVotes = Math.max(1, movies.reduce((largest, movie) => Math.max(largest, Number(movie.votes) || 0), 0));
    const maxLogVotes = Math.log1p(maxVotes) || 1;
    const priorVotes = 1000;

    function filmSimilarity(leftId, rightId) {
      const left = movies[leftId];
      const right = movies[rightId];
      const leftGenres = new Set(left.genres || []);
      const rightGenres = new Set(right.genres || []);
      let intersection = 0;
      for (const genre of leftGenres) if (rightGenres.has(genre)) intersection += 1;
      const union = new Set([...leftGenres, ...rightGenres]).size;
      const genreScore = union ? intersection / union : 0;

      const directorScore = left.director && right.director &&
        left.director.trim().toLowerCase() === right.director.trim().toLowerCase() ? 1 : 0;
      const leftStars = new Set((left.stars || []).map((star) => star.toLowerCase()));
      const rightStars = new Set((right.stars || []).map((star) => star.toLowerCase()));
      let sharedStars = 0;
      for (const star of leftStars) if (rightStars.has(star)) sharedStars += 1;
      const starUnion = new Set([...leftStars, ...rightStars]).size;
      const castScore = starUnion ? sharedStars / starUnion : 0;
      const yearScore = left.year && right.year ? Math.exp(-Math.abs(left.year - right.year) / 20) : 0;

      return 0.70 * genreScore + 0.15 * directorScore + 0.10 * castScore + 0.05 * yearScore;
    }

    const candidates = [];
    for (let movieId = 0; movieId < movies.length; movieId += 1) {
      if (seen.has(movieId) || hidden.has(movieId)) continue;

      let dot = 0;
      for (let genre = 0; genre < genreNames.length; genre += 1) {
        dot += weightedProfile[genre] * vectors[movieId][genre];
      }
      const cosine = profileLength
        ? dot / (profileLength * lengths[movieId])
        : 0;
      // Shift cosine from [-1, 1] to [0, 1], so disliked genres lower a candidate's score.
      const contentScore = profileLength ? (cosine + 1) / 2 : 0.5;

      let similarity = 0;
      let anchor = null;
      let bestAnchorScore = -1;
      for (const [likedId, rating] of anchorRatings) {
        if (!movies[likedId]) continue;
        const score = filmSimilarity(movieId, likedId);
        if (score > similarity) similarity = score;
        const relevance = Math.max(0.25, (rating - 2) / 3);
        const anchorScore = score * relevance;
        if (anchorScore > bestAnchorScore) {
          bestAnchorScore = anchorScore;
          const shared = (movies[movieId].genres || [])
            .filter((genre) => (movies[likedId].genres || []).includes(genre));
          anchor = { j: likedId, r: rating, cs: score, gs: score, shared };
        }
      }

      const voteCount = Math.max(0, Number(movies[movieId].votes) || 0);
      const rating = Number(movies[movieId].rating);
      const bayesianRating = Number.isFinite(rating) && rating > 0
        ? (rating * voteCount + globalMean * priorVotes) / (voteCount + priorVotes)
        : globalMean;
      const quality = Math.max(0, Math.min(1, bayesianRating / 10));
      const popularity = Math.log1p(voteCount) / maxLogVotes;

      let weightSum = 0;
      let totalWeight = 0;
      for (let genre = 0; genre < genreNames.length; genre += 1) {
        if (!vectors[movieId][genre]) continue;
        const value = Math.max(0, weightedProfile[genre]);
        weightSum += value;
        totalWeight += value;
      }
      const weights = [];
      for (let genre = 0; genre < genreNames.length; genre += 1) {
        if (!vectors[movieId][genre]) continue;
        const value = Math.max(0, weightedProfile[genre]);
        weights.push({
          g: genre,
          v: value,
          pct: totalWeight > 0
            ? Math.round((100 * value) / totalWeight)
            : Math.round(100 / Math.max(1, (movies[movieId].genres || []).length)),
        });
      }
      weights.sort((left, right) => right.pct - left.pct);

      // There is no user-to-user ratings matrix in this database. The right-hand
      // mix therefore means similarity to films the user rated, not crowd filtering.
      let feedbackLogSum = 0;
      let candidateGenreCount = 0;
      for (let genre = 1; genre < genreNames.length; genre += 1) {
        if (!vectors[movieId][genre]) continue;
        feedbackLogSum += Math.log(Math.max(0.01, genreWeights[genre] ?? 1));
        candidateGenreCount += 1;
      }
      const feedbackFactor = candidateGenreCount
        ? Math.exp(feedbackLogSum / candidateGenreCount)
        : 1;
      const score = (
        0.68 * ((1 - alpha) * contentScore + alpha * similarity) +
        0.22 * quality +
        0.10 * popularity
      ) * feedbackFactor;

      candidates.push({
        m: movieId,
        content: contentScore,
        cf: similarity,
        cfN: similarity,
        qual: quality,
        pop: popularity,
        popN: popularity,
        f: 1,
        score,
        weights,
        anchor,
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    return { res: candidates.slice(0, limit), profile };
  }


  window.MovieRecommender = { recommendMetadata };
})();
