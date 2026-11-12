// NoMac's publish step: the build this job names (bundle ID, version and build number), already on App Store Connect,
// is submitted for App Review by NoMac's server, which keeps the App Store Connect key. Only a workflow the account
// allowed on nomac.app/dash/ci, with Submit for App Review turned on, from a job in the environment it names. Never a
// release: once Apple approves, the version follows its own release setting.
import { fail, hand, input, nomac } from "../lib/nomac.mjs";

const bundleId = input("bundle-id"), version = input("version"), build = input("build");
if (!bundleId || !version || !build) fail("publish needs bundle-id, version and build: the testflight step's outputs, or the build's own.");
const resolve = input("resolve-rejection", "false");
if (!["true", "false"].includes(resolve)) fail("resolve-rejection is true or false.");
const minutes = Number(input("wait-minutes", "30"));
if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120) fail("wait-minutes is a number of minutes, from 0 to 120.");

// The same request each time: NoMac submits a build once per job, however often it is asked.
const body = { bundle_id: bundleId, version, build, ...(resolve === "true" ? { resolve_rejection: true } : {}) };
// Apple still processing the build, NoMac finishing another change to the app, or Apple yet to confirm the submission.
const WAIT = new Set(["build_processing", "apple_edit_in_progress", "in_flight", "apple_request_pending", "project_changed"]);
const processing = Date.now() + minutes * 60_000;
let confirming;
let answer;
for (;;) {
  answer = await nomac("POST", "/api/v1/ci/publish", body, { keep: WAIT });
  const code = answer?.error?.code;
  // Another change to the app still running is a moment's wait; one interrupted (no retry_after_seconds) waits for a person.
  if (!WAIT.has(code) || (code === "apple_edit_in_progress" && answer.error.retry_after_seconds === undefined)) break;
  // Waiting for Apple's processing ends at wait-minutes; a submission Apple has yet to confirm is followed 10 minutes more.
  // The request's key, for finishing it by hand should the job end first.
  const key = answer.request_key ? `, request ${answer.request_key}` : "";
  if (code === "build_processing" ? Date.now() >= processing : Date.now() >= (confirming ??= Date.now() + 10 * 60_000))
    fail(`NoMac: ${answer.error.message ?? code} (${code}${key}; still so after the step's wait)`);
  console.log(`${code}: ${answer.error.message ?? ""}${key}`);
  const seconds = Number(answer.error.retry_after_seconds ?? (code === "build_processing" ? 60 : 5));
  await new Promise(done => setTimeout(done, Math.max(0, Math.min(seconds, 120)) * 1000));
}
if (answer?.error) fail(`NoMac: ${answer.error.message ?? "the submission failed"}${answer.error.code ? ` (${answer.error.code})` : ""}`);
hand({ "submission-id": answer.asc_submission_id, state: answer.state }, {});
console.log(answer.message ?? `Submitted ${bundleId} ${version} (${build}) for App Review.`);
