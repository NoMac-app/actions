// NoMac's phone API with the account's key (https://nomac.app/docs/simulator): each request answered with its body and
// the server's clock, a busy or lost answer asked again with the same idempotency key, a tool call followed to its
// result and a long build to its job's end. No dependencies.
import { apiBase } from "../lib/nomac.mjs";

const SESSIONS = "/api/v1/simulator/sessions";
// job_status's words (simulator-use's tools/jobs.ts), as the SDK reads them.
const JOB = /Next: job_status \{job_id: "([^"]+)"\}/;
const STILL_RUNNING = /\nNext: job_status again, or job_cancel\./;

export class NoMacError extends Error {
  constructor(code, message, status = 0, body = undefined) { super(message); this.code = code; this.status = status; this.body = body; }
}

export function phones(apiKey, { base = apiBase(), pollMs = 1500 } = {}) {
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  let n = 0;
  const run = `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${Date.now().toString(36)}`;
  /** A fresh idempotency key: the same call asked again keeps its own. */
  const key = (what) => `proof-${run}-${++n}-${what}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);

  async function request(method, path, body, idempotencyKey) {
    for (let attempt = 1; ; attempt++) {
      let response, answer;
      try {
        response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(150_000),
          headers: { authorization: `Bearer ${apiKey}`, "user-agent": "nomac-proof/1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        answer = await response.json().catch(() => ({}));
      } catch (error) {
        if (attempt < 5) { await sleep(pollMs * 2 * attempt); continue; }
        throw new NoMacError("unreachable", `NoMac did not answer: ${error.message}`);
      }
      const busy = [502, 503, 504].includes(response.status) || (response.status === 429 && answer?.error?.code === "rate_limited");
      if (busy && attempt < 6) { await sleep(Math.max(pollMs, Number(response.headers.get("retry-after") ?? 0) * 1000) * attempt); continue; }
      if (!response.ok) throw new NoMacError(answer?.error?.code ?? `http_${response.status}`, answer?.error?.message ?? `NoMac answered HTTP ${response.status}.`, response.status, answer);
      const date = Date.parse(response.headers.get("date") ?? "");
      return { ...answer, server_ms: Number.isFinite(date) ? date : Date.now() };
    }
  }

  /** A tool's answer: its text, whether it is an error, and the server's clock when it was asked. */
  async function tool(phone, name, args = {}, { by = Date.now() + 15 * 60_000 } = {}) {
    let answer = await request("POST", `${SESSIONS}/${phone}/tools/${name}`, args, key(name));
    const asked = answer.server_ms;
    while (answer.state === "running" && typeof answer.id === "string") {
      if (Date.now() > by) throw new NoMacError("timeout", `${name} was still running on the phone.`);
      await sleep(pollMs);
      answer = await request("GET", `${SESSIONS}/${phone}/calls/${answer.id}`);
    }
    if (!answer.result) throw new NoMacError(answer.error?.code ?? answer.error ?? "tool_failed", `${name} failed on the phone: ${answer.message ?? answer.error?.message ?? answer.state}.`, 0, answer);
    const text = (answer.result.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
    return { text, isError: Boolean(answer.result.isError), asked };
  }

  /** A tool that may hand back a job (a build past 40 s): followed with job_status until it ends. */
  async function toolToEnd(phone, name, args, { by = Date.now() + 30 * 60_000 } = {}) {
    let result = await tool(phone, name, args, { by });
    const job = !result.isError ? JOB.exec(result.text)?.[1] : undefined;
    for (let rounds = 0; job; rounds++) {
      const status = await tool(phone, "job_status", { job_id: job }, { by });
      result = { ...status, asked: result.asked };
      if (status.isError || !STILL_RUNNING.test(status.text)) break;
      if (Date.now() > by || rounds > 2000) throw new NoMacError("timeout", `${name} was still running on the phone.`);
    }
    return result;
  }

  /** An operation the phone runs for a while (a git fetch, a state save): the same request with the same key, until it ends. */
  async function operation(phone, path, body, { by = Date.now() + 15 * 60_000 } = {}) {
    const k = key(path.split("/").pop());
    for (;;) {
      const answer = await request("POST", `${SESSIONS}/${phone}${path}`, body, k);
      if (answer.state !== "running") {
        if (answer.state === "failed") throw new NoMacError(answer.error ?? "operation_failed", answer.message ?? "The phone could not do it.", 0, answer);
        return answer;
      }
      if (Date.now() > by) throw new NoMacError("timeout", "The phone was still at it.");
      await sleep(pollMs);
    }
  }

  return {
    key, request, tool, toolToEnd, operation,
    start: (body, idempotencyKey) => request("POST", SESSIONS, body, idempotencyKey),
    read: (phone) => request("GET", `${SESSIONS}/${phone}`),
    stop: (phone) => request("DELETE", `${SESSIONS}/${phone}`),
    view: (phone, body) => request("POST", `${SESSIONS}/${phone}/view`, body),
    states: (label) => request("GET", `/api/v1/simulator/states?label=${encodeURIComponent(label)}`),
    deleteState: (id) => request("DELETE", `/api/v1/simulator/states/${id}`),
  };
}
