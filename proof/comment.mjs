// The pull request's comment and the job's summary: what was built, each flow's result with its recording, the phone
// link, and what the run cost at the server's price. Words only, no emoji, no em dash.
const MOST = 60_000; // GitHub takes 65,536 characters.

/** Microdollars as copy: cents under a dollar ("1.5¢"), else dollars ("$1.13"). */
export function money(micro) {
  const cents = Number(micro) / 10_000;
  return cents < 100 ? `${Number(cents.toFixed(1))}¢` : `$${(cents / 100).toFixed(2)}`;
}
/** An hourly price from microdollars an hour: "$0.90 an hour". */
export const hourly = (micro) => `$${(Number(micro) / 1_000_000).toFixed(2)} an hour`;
const minutes = (seconds) => { const m = Math.max(1, Math.round(seconds / 60)); return `${m} ${m === 1 ? "minute" : "minutes"}`; };
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const cell = (text) => String(text).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const code = (text) => { const s = String(text).replace(/\r?\n/g, " "); const ticks = s.includes("`") ? "``" : "`"; return `${ticks}${ticks.length > 1 ? " " : ""}${s}${ticks.length > 1 ? " " : ""}${ticks}`; };
const block = (text, most = 6000) => { const s = String(text).trim(); const cut = s.length > most ? `${s.slice(0, most)}\n…` : s; return `\`\`\`text\n${cut.replace(/```/g, "'''")}\n\`\`\``; };
const DEVICES = { iphone: "an iPhone", ipad: "an iPad", "iphone-pro-max": "an iPhone Pro Max" };

/** The marker that finds this Action's comment again: one per job and device, so a matrix keeps one each. */
export const marker = (id) => `<!-- nomac-proof:${String(id).replace(/[^A-Za-z0-9._:/ -]/g, "-").slice(0, 120)} -->`;

/** A flow's line in the table. */
function flowRow(flow, links) {
  const result = flow.ok
    ? `Passed: ${flow.steps} ${flow.steps === 1 ? "step" : "steps"} in ${flow.seconds} s`
    : `Failed at step ${flow.failed.step}${flow.failed.line ? `, ${code(flow.failed.line)}` : ""}: ${cell(flow.failed.message)}`;
  const recording = !links ? "" : [flow.recording?.watch ? `[Watch](${flow.recording.watch})` : "", flow.recording?.mp4 ? `[MP4](${flow.recording.mp4})` : ""].filter(Boolean).join(" · ");
  return `| ${cell(flow.name)} | ${cell(result)} | ${recording || "-"} |`;
}

/**
 * The comment's text. report: {status, sha, device, build?, flows, note?, phoneLink?, replay?, dashboard?, cost?, screen?,
 * runUrl, links (whether links that open without sign-in may be shown), previous? (the last result, while a new run goes)}.
 */
export function render(report, id) {
  const head = `${marker(id)}\n### NoMac Proof · ${{ running: "Running", passed: "Passed", failed: "Failed", skipped: "Skipped", closed: "Closed" }[report.status] ?? report.status}`;
  const sha = report.sha ? code(report.sha.slice(0, 7)) : "";
  if (report.status === "running") {
    const previous = report.previous ? `\n\nThe result below is for the last run; it is replaced when this one ends.\n\n${report.previous}` : "";
    return `${head}\n\nBuilding ${sha} on ${DEVICES[report.device] ?? "a phone"} Simulator on NoMac.${previous}`.slice(0, MOST);
  }
  const lines = [head, ""];
  if (report.note) lines.push(report.note, "");
  const build = report.build;
  if (build?.ok) lines.push(`Built ${code(build.scheme ?? "the app")} from ${sha} in ${build.seconds} s on ${DEVICES[report.device] ?? "a phone"} Simulator, in this repository's NoMac workspace.`, "");
  else if (build) lines.push(`The build of ${sha} failed${build.seconds ? ` after ${build.seconds} s` : ""}:`, "", block(build.errors || build.text, 4000), "");
  if (report.flows.length) {
    lines.push("| Flow | Result | Recording |", "| --- | --- | --- |", ...report.flows.map(flow => flowRow(flow, report.links)), "");
  } else if (build?.ok) lines.push(report.flowsNote ?? "No flow ran: the app was built and launched.", "");
  if (report.phoneLink) {
    const link = report.phoneLink;
    lines.push(`**Try this build:** [open it on a phone](${link.url}), no sign-in, until ${day(link.expires_at)}. Opening it starts a phone with this build on this repository's NoMac account, billed per minute: at most ${link.phones} ${link.phones === 1 ? "phone" : "phones"} of ${link.minutes} minutes, ${money(link.most_microunits)} in all.`, "");
  }
  if (!report.links && report.dashboard) lines.push(`The recordings and the replay are on [NoMac](${report.dashboard}) (sign-in): this repository is public, so the comment has no link that opens without one.`, "");
  const facts = [];
  if (report.cost) facts.push(`This run: ${minutes(report.cost.billed_seconds)}, ${money(report.cost.accrued_microunits)} at ${hourly(report.cost.rate_microunits_per_hour)}.`);
  if (report.links && report.replay) facts.push(`Recordings open about a minute after the run and are kept 7 days; [the whole session](${report.replay}).`);
  if (report.runUrl) facts.push(`[Run log](${report.runUrl})`);
  if (facts.length) lines.push(`<sub>${facts.join(" ")}</sub>`, "");
  if (report.screen) lines.push("<details><summary>The last screen, as text</summary>", "", block(report.screen), "", "</details>");
  return lines.join("\n").trim().slice(0, MOST);
}

/** The last result, as a new run's comment keeps it: its own head and marker taken off. */
export const previousOf = (body, id) => body ? body.replace(marker(id), "").replace(/^\s*### NoMac Proof · [^\n]*\n+/, "").replace(/^Building `[^`\n]*` on [^\n]*\n+/, "").replace(/^The result below is for the last run;[^\n]*\n+/, "").trim() : undefined;
