// NoMac's TestFlight step: the .ipa on this job's NoMac Mac goes to Apple from here, and NoMac's server, which keeps the
// App Store Connect key, commits it. The step waits until Apple has the build (the Mac must run until then), or until it
// is on TestFlight. Only a workflow the account allowed on nomac.app/dash/ci sends, for its allowed bundle IDs.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fail, hand, input, nomac } from "../lib/nomac.mjs";

const wait = input("wait", "sent");
if (!["sent", "testflight"].includes(wait)) fail("wait is sent or testflight.");
const ipa = resolve(input("ipa"));
let file;
try { file = statSync(ipa); } catch { fail(`No .ipa at ${ipa}.`); }
// The file itself names the send: a second build sent from the same path in this job is a send of its own.
let view = await nomac("POST", "/api/v1/ci/testflight", { path: ipa, request_key: `${file.size}-${Math.round(file.mtimeMs)}`, ...(input("notes") ? { notes: input("notes") } : {}) });
// A step a person must take (needs_human) ends the wait: the Mac is not needed for it.
const done = (state) => state === "failed" || state === "on_testflight" || (state === "processing" && (wait === "sent" || Boolean(view.needs_human)));
const until = Date.now() + (wait === "sent" ? 70 : 100) * 60_000;
while (!done(view.state) && Date.now() < until) {
  console.log(`${view.state}: ${view.message ?? ""}`);
  view = await nomac("GET", `/api/v1/ci/testflight/${view.id}`);
}
hand({ "upload-id": view.id, state: view.state, "bundle-id": view.app?.bundle_id, version: view.app?.version, "build-number": view.app?.build_number }, {});
if (view.state === "failed") fail(`TestFlight: ${view.error?.message ?? "the send failed"}${view.next_action ? ` ${view.next_action}` : ""}`);
if (!done(view.state)) fail(`TestFlight: still ${view.state} after the step's wait; NoMac goes on with it (send ${view.id}).`);
if (view.needs_human) console.log(`::warning::${view.needs_human.message ?? view.message} ${view.needs_human.url ?? ""}`.trim());
console.log(`${view.app?.bundle_id} ${view.app?.version} (${view.app?.build_number}): ${view.message}`);
