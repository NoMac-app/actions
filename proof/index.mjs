// NoMac Proof: a pull request's iOS app built on a NoMac phone (an iPhone Simulator on a Mac), in the repository's own
// workspace there, kept between runs, so only what the pull request changed is rebuilt; the flows its changes touch run
// on the phone with simulator-use, each recorded; and one comment on the pull request, edited on every push, says how it
// went, with the recordings and a link that opens this build on a phone. It runs on any runner: the runner only asks.
import { appendFileSync, readFileSync } from "node:fs";
import { hand, input } from "../lib/nomac.mjs";
import { calls, parseFlow, pick, readFlows } from "./flows.mjs";
import { github } from "./github.mjs";
import { hourly, marker, money, previousOf, render } from "./comment.mjs";
import { NoMacError, phones } from "./nomac.mjs";
import { parseBuild } from "./answers.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const POLL_MS = Number(process.env.NOMAC_PROOF_POLL_MS ?? 2000);
const ENDED = ["stopping", "stopped", "failed"];
const DEVICES = ["iphone", "ipad", "iphone-pro-max"];
const log = (line) => console.log(line);
const warn = (line) => console.log(`::warning::${line.replace(/\r?\n/g, " ")}`);
const stop = (message) => { console.log(`::error::${message.replace(/\r?\n/g, " ")}`); process.exit(1); };

// ---- What this run is ----------------------------------------------------------------------------------------------------
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
const pr = event.pull_request;
const repository = event.repository ?? {};
const repo = process.env.GITHUB_REPOSITORY ?? repository.full_name ?? "";
const server = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
const runUrl = `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
const sha = pr?.head?.sha ?? process.env.GITHUB_SHA ?? "";
const headRepo = pr?.head?.repo?.full_name ?? repo;
const fork = Boolean(pr) && pr.head?.repo?.id !== repository.id;
const isPrivate = repository.private === true || ["private", "internal"].includes(repository.visibility);

const apiKey = input("api-key");
const token = input("github-token");
const device = input("device", "iphone");
const path = input("path", ".").replace(/^\.\/?/, "").replace(/\/+$/, "");
const label = input("label", repository.id ? `github:${repository.id}` : "github");
const id = input("comment-id", `${process.env.GITHUB_JOB ?? "proof"}:${device}`);
const links = isPrivate || input("public-links", "false") === "true";
const linkMode = input("phone-link", "auto");
const number = pr?.number;
const commentOn = Boolean(number) && input("comment", "true") === "true";
const numberOf = (name, fallback, least, most) => {
  const value = Number(input(name, fallback));
  if (!Number.isFinite(value) || value < least || value > most) stop(`${name} is a number from ${least} to ${most}.`);
  return value;
};
const maxMinutes = numberOf("max-minutes", "30", 5, 480), waitMinutes = numberOf("wait-minutes", "10", 0, 60);
const maxCost = numberOf("max-cost", "1", 0.05, 100);
const linkPhones = numberOf("phone-link-phones", "3", 1, 10), linkMinutes = numberOf("phone-link-minutes", "15", 5, 60);

if (!DEVICES.includes(device)) stop(`device is ${DEVICES.join(", ")}.`);
if (path.split("/").includes("..")) stop("path is a folder inside the repository.");
if (!["auto", "on", "off"].includes(linkMode)) stop("phone-link is auto, on or off.");
if (!["changed", "all"].includes(input("run", "changed"))) stop("run is changed or all.");
if (server !== "https://github.com") stop("NoMac Proof fetches the repository from github.com; GitHub Enterprise Server is not supported yet.");
if (apiKey) console.log(`::add-mask::${apiKey}`);

const gh = github(token);
const summary = (text) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text.replace(marker(id), "").trim()}\n`); };
/** The comment written, or the reason it was not (the run goes on without it). */
async function comment(body, existing) {
  if (!commentOn) return existing;
  try { return await gh.writeComment(repo, number, existing, body); }
  catch (error) { warn(`The pull request's comment was not written (${error.message}). The workflow needs permissions: pull-requests: write.`); return existing; }
}

// ---- The phone -----------------------------------------------------------------------------------------------------------

/** A phone of the repository's label (its workspace and saved states), waiting while the account's phones are all in use. */
async function startPhone(nomac) {
  const by = Date.now() + waitMinutes * 60_000, key = nomac.key("start");
  const body = { device, label, limits: { max_duration_seconds: maxMinutes * 60, idle_timeout_seconds: 600, spend_cap_microunits: String(Math.round(maxCost * 1_000_000)) } };
  for (;;) {
    try { return await nomac.start(body, key); }
    catch (error) {
      const wait = error instanceof NoMacError && ["session_limit_reached", "start_rate_limited", "device_unavailable"].includes(error.code);
      if (!wait || Date.now() > by) throw error;
      log(`Waiting for a phone: ${error.message}`);
      await sleep(Math.max(POLL_MS, 15_000 * (POLL_MS / 2000)));
    }
  }
}

async function waitReady(nomac, phone) {
  const by = Date.now() + 7 * 60_000;
  for (;;) {
    const { session } = await nomac.read(phone);
    if (session.state === "ready") return session;
    if (ENDED.includes(session.state)) throw new NoMacError(session.failure_code ?? "phone_ended", session.message ?? `The phone ended before it was ready (${session.failure_code ?? session.state}).`);
    if (Date.now() > by) throw new NoMacError("timeout", "The phone was not ready within 7 minutes.");
    await sleep(POLL_MS);
  }
}

/** One flow on the phone, recorded: the app launched fresh, its steps in order, the first that fails ends it. */
async function runFlow(nomac, phone, flow, bundle, readyAt, replay) {
  const result = { name: flow.name, ok: true, steps: 0, seconds: 0, recording: {} };
  log(`Flow ${flow.name}: ${flow.steps.length} steps`);
  if (flow.steps[0]?.kind !== "launch") await nomac.tool(phone, "app_control", { action: "launch", app: bundle });
  const recording = await nomac.tool(phone, "screen_record", { action: "start" });
  const began = Date.now();
  const failAt = (step, line, message) => { result.ok = false; result.failed = { step, line, message: message.trim().slice(0, 300) }; };
  for (const call of calls(flow.steps)) {
    if (call.kind === "launch" || call.kind === "open") {
      const answer = await nomac.tool(phone, "app_control", call.kind === "launch" ? { action: "launch", app: bundle, ...(call.value ? { value: call.value } : {}) } : { action: "open_url", value: call.value });
      result.steps++;
      if (answer.isError) failAt(result.steps, `${call.kind}${call.kind === "open" ? ` ${call.value}` : ""}`, answer.text.split("\n")[0]);
    } else if (call.kind === "look") {
      result.look = (await nomac.tool(phone, "ui_look", {})).text;
      result.steps++;
    } else {
      let rest = call.steps;
      while (rest.length && result.ok) {
        const answer = await nomac.tool(phone, "ui_act", { steps: rest });
        const over = /^Stopped before step (\d+): this call ran past/m.exec(answer.text);
        const done = over ? Number(over[1]) - 1 : undefined;
        if (done !== undefined && done > 0) { result.steps += done; rest = rest.slice(done); continue; }
        if (answer.isError) {
          // ui_act names the step as it may be shown: typed text left out.
          const failed = /^Step (\d+) \((.*)\) failed: (.*)$/m.exec(answer.text);
          const n = failed ? Number(failed[1]) : 1;
          result.steps += n - 1;
          failAt(result.steps + 1, failed?.[2], failed?.[3] ?? answer.text.split("\n")[0]);
          break;
        }
        result.steps += rest.length; rest = [];
      }
    }
    if (!result.ok) break;
  }
  result.seconds = Math.max(1, Math.round((Date.now() - began) / 1000));
  const stopped = await nomac.tool(phone, "screen_record", { action: "stop" });
  result.recording.mp4 = /(https:\/\/\S+?\/api\/v1\/simulator\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(stopped.text)?.[1];
  // The replay at the flow's start: the server's clocks (its answer's Date, the phone's ready_at), a second early.
  const offset = Math.max(0, Math.floor((recording.asked - Date.parse(readyAt)) / 1000) - 1);
  if (replay) result.recording.watch = `${replay}?t=${offset}`;
  log(`  ${result.ok ? "passed" : `failed at step ${result.failed.step}: ${result.failed.message}`}`);
  return result;
}

/**
 * The link that opens this build on a phone (NoMac's relaunch, RM-19): the phone's apps and data saved under the pull
 * request's name, then a link that, once this phone has stopped, starts a phone with that state for whoever opens it.
 */
async function phoneLink(nomac, phone, bundle) {
  const state = `proof-pr-${number}-${device}`;
  const saved = await nomac.operation(phone, "/state", { action: "save", name: state }, { by: Date.now() + 8 * 60_000 });
  if (saved.uploaded === false) throw new Error("the build was saved on the phone but not kept for other phones");
  const link = await nomac.view(phone, { control: true, relaunch: { state, app: bundle, phones: linkPhones, minutes: linkMinutes } });
  if (!link.relaunch) throw new Error("NoMac made a link that does not outlive the phone");
  return { url: link.url, expires_at: link.expires_at, phones: link.relaunch.phones, minutes: link.relaunch.minutes, most_microunits: link.relaunch.most_microunits };
}

/** After the stop: what the run cost, once the phone has stopped (else from when its stop was asked, as NoMac bills it). */
async function finalCost(nomac, phone) {
  let session;
  for (let i = 0; i < 20; i++) {
    session = (await nomac.read(phone)).session;
    if (["stopped", "failed"].includes(session.state)) break;
    await sleep(POLL_MS);
  }
  const rate = session.offer?.rate_microunits_per_hour;
  if (["stopped", "failed"].includes(session.state) || !session.ready_at || !session.stop_requested_at || !rate) {
    return { accrued_microunits: session.cost?.accrued_microunits ?? "0", billed_seconds: session.cost?.billed_seconds ?? 0, rate_microunits_per_hour: rate ?? "0" };
  }
  const told = Math.ceil((Date.parse(session.stop_requested_at) - Date.parse(session.ready_at)) / 1000);
  const billed = Math.ceil(Math.max(told, session.billing?.minimum_seconds ?? 60) / 60) * 60;
  return { accrued_microunits: String(Math.ceil(billed * Number(rate) / 3600)), billed_seconds: billed, rate_microunits_per_hour: rate };
}

// ---- A closed pull request -------------------------------------------------------------------------------------------------

/** Its build's state deleted, so its phone link starts no more phones, and the comment says so. */
async function closed(nomac, existing) {
  const state = `proof-pr-${number}-${device}`;
  const { states = [] } = await nomac.states(label);
  for (const kept of states.filter(s => s.name === state)) await nomac.deleteState(kept.id);
  log(`Pull request #${number} closed: ${states.some(s => s.name === state) ? `deleted its build (${state})` : "no build was kept for it"}.`);
  if (existing?.body?.includes("**Try this build:**")) {
    await comment(existing.body.replace(/\*\*Try this build:\*\*[^\n]*/, "**Try this build:** this pull request is closed, so its phone link no longer opens a phone."), existing.id);
  }
}

// ---- The run ---------------------------------------------------------------------------------------------------------------

async function main() {
  const report = { status: "failed", sha, device, flows: [], links, runUrl };
  const skip = (why) => { log(why); report.status = "skipped"; report.note = why; summary(render(report, id)); hand({ result: "skipped" }, {}); };
  if (!apiKey) return skip("NoMac Proof skipped: the api-key input is empty (a pull request from a fork gets no secrets, or the secret is not set).");
  if (fork && input("forks", "false") !== "true") return skip("NoMac Proof skipped: this pull request comes from a fork. Set forks: true to build them (anyone who opens one then spends this account's credit).");
  const nomac = phones(apiKey, { pollMs: Math.min(POLL_MS, 1500) });
  const existing = commentOn ? await gh.findComment(repo, number, marker(id)).catch(error => { warn(`The pull request's comments were not read (${error.message}).`); return undefined; }) : undefined;
  if (pr && event.action === "closed") return closed(nomac, existing);

  let commentId = await comment(render({ status: "running", sha, device, previous: previousOf(existing?.body, id) }, id), existing?.id);
  let phone, readyAt, replay;
  const by = Date.now() + maxMinutes * 60_000;
  const halt = async () => { if (phone) await nomac.stop(phone).catch(() => undefined); process.exit(1); };
  process.once("SIGINT", halt); process.once("SIGTERM", halt);
  try {
    const started = await startPhone(nomac);
    phone = started.session.id;
    replay = started.links?.replay;
    if (process.env.GITHUB_STATE) appendFileSync(process.env.GITHUB_STATE, `phone=${phone}\n`);
    log(`Phone ${phone} (${device}, label ${label}), at ${hourly(started.session.offer?.rate_microunits_per_hour ?? 0)}.`);
    readyAt = (await waitReady(nomac, phone)).ready_at;
    report.dashboard = `https://nomac.app/dash/simulators/${phone}`;

    const fetched = await nomac.operation(phone, "/sync/git", { url: `https://github.com/${headRepo}`, ...(sha ? { ref: sha } : {}), ...(isPrivate && token ? { token } : {}) }, { by });
    log(`Fetched ${headRepo} at ${fetched.commit ?? sha.slice(0, 12)}.`);
    const args = { path: path ? `${fetched.root}/${path}` : fetched.root, ...Object.fromEntries(["scheme", "configuration", "env"].map(k => [k, input(k)]).filter(([, v]) => v)) };
    report.build = parseBuild(await nomac.toolToEnd(phone, "app_run", args, { by }));
    log(report.build.ok ? `Built ${report.build.scheme} in ${report.build.seconds} s: ${report.build.bundle}.` : `The build failed:\n${report.build.errors}`);

    if (report.build.ok) {
      const inline = input("flow");
      const flows = inline ? [parseFlow(inline, "flow")] : readFlows(process.env.GITHUB_WORKSPACE ?? process.cwd(), input("flows", ".nomac/flows"));
      const run = input("run", "changed");
      const changed = pr && run === "changed" && !inline ? await gh.changedFiles(repo, number).catch(error => { warn(`The pull request's files were not read (${error.message}): every flow runs.`); return undefined; }) : undefined;
      const chosen = pick(flows, changed, run);
      report.flowsNote = flows.length ? "No flow covers what this pull request changed: the app was built and launched." : `No flow ran: there is no flow in ${input("flows", ".nomac/flows")} (check out the repository first). The app was built and launched.`;
      for (const flow of chosen) report.flows.push(await runFlow(nomac, phone, flow, report.build.bundle, readyAt, links ? replay : undefined));
      report.screen = (await nomac.tool(phone, "ui_look", {})).text;
      const wanted = linkMode === "on" || (linkMode === "auto" && links);
      if (wanted && number && links) {
        try { report.phoneLink = await phoneLink(nomac, phone, report.build.bundle); }
        catch (error) { warn(`No phone link this time: ${error.message}`); }
      }
    }
    report.status = report.build.ok && report.flows.every(flow => flow.ok) ? "passed" : "failed";
  } catch (error) {
    report.status = "failed";
    report.note = `NoMac Proof could not finish: ${error.message}${error.code ? ` (${error.code})` : ""}`;
    console.log(`::error::${report.note}`);
  } finally {
    if (phone) {
      await nomac.stop(phone).catch(error => warn(`The phone did not stop (${error.message}); it stops by itself after 10 idle minutes.`));
      if (process.env.GITHUB_STATE) appendFileSync(process.env.GITHUB_STATE, "stopped=1\n");
      report.cost = await finalCost(nomac, phone).catch(() => undefined);
      report.replay = links ? replay : undefined;
    }
  }
  const text = render(report, id);
  commentId = await comment(text, commentId);
  summary(text);
  if (report.cost) log(`This run: ${money(report.cost.accrued_microunits)} at ${hourly(report.cost.rate_microunits_per_hour)}.`);
  hand({ result: report.status, "phone-id": phone, "phone-link": report.phoneLink?.url, replay: report.replay, "cost-microunits": report.cost?.accrued_microunits }, {});
  if (report.status === "failed") process.exit(1);
}

await main();
