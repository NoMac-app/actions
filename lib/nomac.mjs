// What NoMac's steps share: the job's GitHub OIDC token (a fresh one per call), NoMac's answer, and what a step hands the
// next ones. No dependencies: it runs on the job's NoMac Mac with the runner's own Node.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

const AUDIENCE = "https://nomac.app/ci";
// NoMac, or a stand-in on this computer for the steps' own tests: the job's token goes nowhere else.
export const apiBase = (wanted = process.env.NOMAC_API_URL ?? "") => (/^http:\/\/127\.0\.0\.1:\d+$/.test(wanted) ? wanted : "https://nomac.app");
const API = apiBase();

export const input = (name, fallback = "") => (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim() || fallback;

export function fail(message) {
  console.log(`::error::${message.replace(/\r?\n/g, " ")}`);
  process.exit(1);
}

/** The job's token for NoMac: GitHub gives one only with permissions: id-token: write. */
export async function jobToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) fail("This step needs the job's OIDC token: add `permissions: id-token: write` (and `contents: read`) to the workflow or job.");
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, { headers: { authorization: `Bearer ${bearer}` } }).catch(() => undefined);
    const body = await response?.json().catch(() => ({}));
    if (response?.ok && typeof body?.value === "string") { console.log(`::add-mask::${body.value}`); return body.value; }
    if (attempt >= 4) fail(`GitHub gave no OIDC token${response ? ` (HTTP ${response.status})` : ""}.`);
    await new Promise(done => setTimeout(done, 2000 * attempt));
  }
}

/** A call to NoMac with a fresh token; a job NoMac has not heard of yet, a busy site or a lost answer is asked again. */
export async function nomac(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    let response, answer;
    try {
      response = await fetch(`${API}${path}`, { method, signal: AbortSignal.timeout(310_000),
        headers: { authorization: `Bearer ${await jobToken()}`, "user-agent": "nomac-actions/1", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      answer = await response.json().catch(() => ({}));
    } catch (error) {
      if (attempt < 4) { await new Promise(done => setTimeout(done, 5000 * attempt)); continue; }
      fail(`NoMac did not answer: ${error.message}`);
    }
    // A limit is not waited out: the day's sends are spent.
    const again = (response.status === 409 && answer?.error?.code === "ci_job_unknown") || ([429, 502, 503, 504].includes(response.status) && answer?.error?.code !== "ci_testflight_limit");
    if (again && attempt < 6) { await new Promise(done => setTimeout(done, 5000 * attempt)); continue; }
    if (!response.ok) {
      const error = answer?.error ?? {};
      const steps = error.needs_human?.steps?.length ? ` ${error.needs_human.steps.join(" ")}` : "";
      fail(`NoMac: ${error.message ?? `HTTP ${response.status}`}${steps}${error.code ? ` (${error.code})` : ""}`);
    }
    return answer;
  }
}

/** A path NoMac names on the Mac (~/...) as this Mac's own. */
export const onMac = (path) => (path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);

/** Outputs for later steps, and variables for every later step of the job. */
export function hand(outputs, env) {
  // GitHub's multiline form, with a delimiter no value can hold, so no value can add a line of its own.
  const write = (file, entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) continue;
      const end = `NOMAC_${randomBytes(8).toString("hex")}`;
      appendFileSync(file, `${key}<<${end}\n${value}\n${end}\n`);
    }
  };
  if (process.env.GITHUB_OUTPUT) write(process.env.GITHUB_OUTPUT, outputs);
  if (process.env.GITHUB_ENV) write(process.env.GITHUB_ENV, env);
}
