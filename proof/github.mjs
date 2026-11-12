// GitHub's REST API with the job's token: the pull request's changed files, and the Action's one comment on it, found by
// its marker and edited in place on every push. The token goes only to GitHub's API (GITHUB_API_URL, the runner's own).
const api = () => process.env.GITHUB_API_URL || "https://api.github.com";

export function github(token) {
  async function request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${api()}${path}`, { method, signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "nomac-proof/1", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }).catch(error => ({ ok: false, status: 0, error }));
      if ((response.status === 0 || response.status >= 500) && attempt < 4) { await new Promise(done => setTimeout(done, 2000 * attempt)); continue; }
      const answer = response.status === 0 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`GitHub answered ${response.status || "nothing"} to ${method} ${path.split("?")[0]}${answer.message ? `: ${answer.message}` : ""}`);
        error.status = response.status;
        throw error;
      }
      return answer;
    }
  }

  /** Every page of a list, up to `pages` of 100. */
  async function all(path, pages = 30) {
    const out = [];
    for (let page = 1; page <= pages; page++) {
      const items = await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  return {
    /** The pull request's files, renamed ones under both names (GitHub lists up to 3,000). */
    async changedFiles(repo, number) {
      const files = await all(`/repos/${repo}/pulls/${number}/files`);
      return files.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
    },
    /** The comment that carries this marker, written by GitHub Actions (the job's token), or nothing: anyone may paste a marker. */
    async findComment(repo, number, marker) {
      const comments = await all(`/repos/${repo}/issues/${number}/comments`);
      return comments.find(c => c.user?.login === "github-actions[bot]" && typeof c.body === "string" && c.body.includes(marker));
    },
    /** The comment written: edited in place when there is one, else a new one. Answers its id. */
    async writeComment(repo, number, id, body) {
      if (id) return (await request("PATCH", `/repos/${repo}/issues/comments/${id}`, { body })).id;
      return (await request("POST", `/repos/${repo}/issues/${number}/comments`, { body })).id;
    },
  };
}
