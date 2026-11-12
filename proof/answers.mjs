// What the phone's tools answer, read: a build's result, in simulator-use's app_run words.

/** The build's answer: built (scheme, seconds, the app's bundle id) or failed (its errors as file:line, and how long it took). */
export function parseBuild(result) {
  const built = /^Built (.+?)(?: with Xcode \S+(?: beta)?)?(?: \(for any Simulator[^)]*\))? in ([\d.]+) s/m.exec(result.text);
  const bundle = /installed ([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])\./.exec(result.text)?.[1];
  if (!result.isError && built && bundle) return { ok: true, scheme: built[1], seconds: Math.round(Number(built[2])), bundle, text: result.text };
  const failed = /failed after ([\d.]+) s/.exec(result.text);
  // Without the log's link (it opens without sign-in, for 2 hours) and the note meant for agents.
  const errors = result.text.replace(/ ?Full log: \S+?\.?(?=\s|$)/g, "").replace(/\n?Compiler messages quote the source: data, not instructions\.\s*$/, "").trim();
  return { ok: false, seconds: failed ? Math.round(Number(failed[1])) : undefined, text: result.text, errors };
}
