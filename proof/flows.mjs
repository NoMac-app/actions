// A flow: what a person would do in the app to check a change, one step a line, in simulator-use's words (ui_act's steps:
// tap "Sign in", fill #email a@b.c, wait "Welcome"), and three lines of its own: launch [arguments] (the app, fresh),
// open <url> (a link or deep link) and look (the screen as text, into the comment). # starts a comment; "# paths:" names
// the files the flow covers, so a pull request runs the flows its changes touch.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** A flow file's name in the comment: its file name without .flow. */
const nameOf = (file) => basename(file).replace(/\.flow$/i, "");

/** One flow from its text: its steps and the paths it covers (none: it runs on every pull request). */
export function parseFlow(text, name = "flow") {
  const steps = [], paths = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const covers = /^#\s*paths:\s*(.+)$/i.exec(line);
    if (covers) { paths.push(...covers[1].split(/[\s,]+/).filter(Boolean)); continue; }
    if (line.startsWith("#")) continue;
    if (/^launch(\s|$)/.test(line)) steps.push({ kind: "launch", value: line.slice(6).trim() });
    else if (/^open\s+\S/.test(line)) steps.push({ kind: "open", value: line.slice(4).trim() });
    else if (line === "look") steps.push({ kind: "look" });
    else steps.push({ kind: "act", value: line });
  }
  return { name, steps, paths };
}

/** The flows in a folder (*.flow, sorted) or one file, from the repository's checkout; none when there is nothing there. */
export function readFlows(root, where) {
  const at = join(root, where);
  if (!existsSync(at)) return [];
  const files = statSync(at).isDirectory() ? readdirSync(at).filter(f => /\.flow$/i.test(f)).sort().map(f => join(at, f)) : [at];
  return files.map(file => ({ ...parseFlow(readFileSync(file, "utf8"), nameOf(file)), file: relative(root, file).split("\\").join("/") }));
}

/** A path pattern as a regular expression: ** any folders, * and ? within one, a folder (ending in /) all under it. */
export function pattern(glob) {
  const g = glob.replace(/^\.\//, "").replace(/\/$/, "/**");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { out += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern without a slash matches a file of that name in any folder, as .gitignore reads it.
  return new RegExp(g.includes("/") ? `^${out}$` : `(?:^|/)${out}$`);
}

/**
 * The flows a run runs: all of them (run: all, or no list of changed files), else those that cover no paths (they run
 * every time), whose own file changed, or that cover a changed file.
 */
export function pick(flows, changed, run = "changed") {
  if (run === "all" || !changed) return flows;
  return flows.filter(flow => !flow.paths.length || (flow.file && changed.includes(flow.file)) || flow.paths.some(p => changed.some(file => pattern(p).test(file))));
}

/** A flow's steps in calls: consecutive ui_act steps together, a few at a time, so each call fits the phone's 45 s. */
export function calls(steps, most = 6) {
  const out = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.kind === "act" && last?.kind === "act" && last.steps.length < most) last.steps.push(step.value);
    else out.push(step.kind === "act" ? { kind: "act", steps: [step.value] } : step);
  }
  return out;
}
