// The steps against a stand-in for GitHub's token service and NoMac: each call takes a fresh token, a job NoMac has not
// heard of yet is asked again, and a refusal fails the step with NoMac's words. node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function stand(answers) {
  const seen = [], bodies = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.url.startsWith("/token")) { seen.push("token " + new URL(req.url, "http://x").searchParams.get("audience")); return res.end(JSON.stringify({ value: `t${seen.length}.p.s` })); }
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`); bodies.push(body);
      const [status, answer] = answers.shift();
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, bodies, close: () => server.close() };
}
function step(name, url, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nomac-step-")), output = join(dir, "output"), vars = join(dir, "env");
  writeFileSync(output, ""); writeFileSync(vars, "");
  return new Promise(done => {
    const child = spawn(process.execPath, [new URL(`../${name}/index.mjs`, import.meta.url).pathname], { env: { PATH: process.env.PATH, HOME: "/Users/runner",
      ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner", NOMAC_API_URL: url, GITHUB_OUTPUT: output, GITHUB_ENV: vars, ...env } });
    let out = "";
    child.stdout.on("data", data => { out += data; });
    child.on("exit", code => done({ code, out, outputs: readFileSync(output, "utf8"), env: readFileSync(vars, "utf8") }));
  });
}

test("sign hands the files to the next steps, after asking again for a job NoMac had not heard of yet", async () => {
  const nomac = await stand([[409, { error: { code: "ci_job_unknown", message: "not yet" } }],
    [200, { team_id: "TEAM123456", build_number: 7, files: { xcconfig: "~/.nomac/signing/TEAM123456.xcconfig", export_options: "~/.nomac/signing/TEAM123456-ExportOptions.plist" },
      project: { scheme: "App" }, identity: { name: "Apple Distribution: Acme" }, changes: [], profiles: [], commands: { xcodebuild: ["xcodebuild archive ..."] } }]]);
  try {
    const result = await step("sign", nomac.url, { INPUT_PATH: "ios", GITHUB_WORKSPACE: "/tmp/checkout" });
    assert.equal(result.code, 0, result.out);
    assert.match(result.env, /^NOMAC_XCCONFIG<<(NOMAC_[0-9a-f]{16})\n\/Users\/runner\/\.nomac\/signing\/TEAM123456\.xcconfig\n\1$/m);
    assert.match(result.env, /^NOMAC_BUILD_NUMBER<<(NOMAC_[0-9a-f]{16})\n7\n\1$/m);
    assert.match(result.outputs, /^team-id<<(NOMAC_[0-9a-f]{16})\nTEAM123456\n\1$/m);
    assert.equal(JSON.parse(nomac.bodies.at(-1)).path, "/tmp/checkout/ios", "the project's path on this Mac, from the job's checkout");
    const calls = nomac.seen.filter(line => line.startsWith("POST"));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].split(" ").pop(), calls[1].split(" ").pop(), "a fresh token for each call");
    assert.ok(nomac.seen.includes("token https://nomac.app/ci"));
  } finally { nomac.close(); }
});

test("a refusal fails the step with NoMac's words and the person's steps", async () => {
  const nomac = await stand([[403, { error: { code: "ci_signing_off", message: "Signing from jobs is off for acme/app." } }]]);
  try {
    const result = await step("sign", nomac.url);
    assert.equal(result.code, 1);
    assert.match(result.out, /::error::NoMac: Signing from jobs is off for acme\/app\. \(ci_signing_off\)/);
  } finally { nomac.close(); }
});

test("testflight waits until Apple has the build, asking with a fresh token each time", async () => {
  const sending = { id: "tfu_1", state: "sending", message: "sending", app: { bundle_id: "com.acme.app", version: "1.0", build_number: "7" } };
  const nomac = await stand([[200, sending], [200, sending], [200, { ...sending, state: "processing", message: "Apple has the build." }]]);
  try {
    const ipa = join(mkdtempSync(join(tmpdir(), "nomac-ipa-")), "App.ipa"); writeFileSync(ipa, "ipa");
    const result = await step("testflight", nomac.url, { INPUT_IPA: ipa });
    assert.equal(result.code, 0, result.out);
    assert.match(result.outputs, /^state<<(NOMAC_[0-9a-f]{16})\nprocessing\n\1$/m);
    assert.match(nomac.bodies[0], /"request_key":"3-\d+"/);
    assert.equal(nomac.seen.filter(line => line.startsWith("GET /api/v1/ci/testflight/tfu_1")).length, 2);
  } finally { nomac.close(); }
});

test("without permissions: id-token: write, it says so", async () => {
  const result = await step("sign", "http://127.0.0.1:9", { ACTIONS_ID_TOKEN_REQUEST_URL: "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" });
  assert.equal(result.code, 1);
  assert.match(result.out, /permissions: id-token: write/);
});

test("a spent day's TestFlight limit fails at once, not after five tries", async () => {
  const nomac = await stand([[429, { error: { code: "ci_testflight_limit", message: "acme/app's jobs sent 20 builds to TestFlight in the last day." } }]]);
  const ipa = join(mkdtempSync(join(tmpdir(), "nomac-ipa-")), "App.ipa"); writeFileSync(ipa, "ipa");
  try {
    const result = await step("testflight", nomac.url, { INPUT_IPA: ipa });
    assert.equal(result.code, 1);
    assert.equal(nomac.seen.filter(line => line.startsWith("POST")).length, 1);
  } finally { nomac.close(); }
});

test("testflight hands the build's bundle ID, version and number to the publish step", async () => {
  const nomac = await stand([[200, { id: "tfu_1", state: "processing", message: "Apple has the build.", app: { bundle_id: "com.acme.app", version: "1.2", build_number: "7" } }]]);
  try {
    const ipa = join(mkdtempSync(join(tmpdir(), "nomac-ipa-")), "App.ipa"); writeFileSync(ipa, "ipa");
    const result = await step("testflight", nomac.url, { INPUT_IPA: ipa });
    assert.equal(result.code, 0, result.out);
    assert.match(result.outputs, /^bundle-id<<(NOMAC_[0-9a-f]{16})\ncom\.acme\.app\n\1$/m);
    assert.match(result.outputs, /^version<<(NOMAC_[0-9a-f]{16})\n1\.2\n\1$/m);
    assert.match(result.outputs, /^build-number<<(NOMAC_[0-9a-f]{16})\n7\n\1$/m);
  } finally { nomac.close(); }
});

const publishInputs = { "INPUT_BUNDLE-ID": "com.acme.app", INPUT_VERSION: "1.2", INPUT_BUILD: "7" };

test("publish waits while Apple processes the build and Apple confirms, asking the same thing with a fresh token each time", async () => {
  const nomac = await stand([
    [409, { error: { code: "build_processing", message: "Apple is still processing build 1.2 (7).", retry_after_seconds: 0 } }],
    [409, { error: { code: "apple_edit_in_progress", message: "Another change to this Apple app is still running.", retry_after_seconds: 0 } }],
    [202, { state: "pending", staged: false, request_key: "ci-1-abc", error: { code: "apple_request_pending", message: "Apple has not confirmed the review submission.", retry_after_seconds: 0 } }],
    [200, { submission_id: "sub_n", asc_submission_id: "asc_sub_1", state: "submitted", message: "Submitted com.acme.app 1.2 (7) for App Review." }]]);
  try {
    const result = await step("publish", nomac.url, publishInputs);
    assert.equal(result.code, 0, result.out);
    assert.match(result.outputs, /^submission-id<<(NOMAC_[0-9a-f]{16})\nasc_sub_1\n\1$/m);
    assert.match(result.outputs, /^state<<(NOMAC_[0-9a-f]{16})\nsubmitted\n\1$/m);
    assert.match(result.out, /Submitted com\.acme\.app 1\.2 \(7\) for App Review\./);
    assert.match(result.out, /apple_request_pending: .*, request ci-1-abc/, "the request's key, for finishing it by hand");
    const calls = nomac.seen.filter(line => line.startsWith("POST /api/v1/ci/publish"));
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map(line => line.split(" ").pop())).size, 4, "a fresh token for each call");
    assert.deepEqual(nomac.bodies.map(body => JSON.parse(body)), Array(4).fill({ bundle_id: "com.acme.app", version: "1.2", build: "7" }));
  } finally { nomac.close(); }
});

test("publish asks NoMac to mark a rejected version fixed only when told to", async () => {
  const nomac = await stand([[200, { asc_submission_id: "asc_sub_1", state: "submitted" }]]);
  try {
    const result = await step("publish", nomac.url, { ...publishInputs, "INPUT_RESOLVE-REJECTION": "true" });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(JSON.parse(nomac.bodies[0]), { bundle_id: "com.acme.app", version: "1.2", build: "7", resolve_rejection: true });
  } finally { nomac.close(); }
});

test("publish fails at once on a refusal, a spent day or Apple's blockers, with NoMac's words", async () => {
  // An earlier change to the app that was interrupted (no retry_after_seconds) waits for a person, not for the step.
  for (const [status, code] of [[403, "ci_publish_off"], [429, "ci_publish_limit"], [422, "ci_publish_other_items"], [422, "lint_gate_red"], [409, "apple_edit_in_progress"]]) {
    const nomac = await stand([[status, { error: { code, message: `Refused: ${code}.` } }]]);
    try {
      const result = await step("publish", nomac.url, publishInputs);
      assert.equal(result.code, 1, code);
      assert.match(result.out, new RegExp(`::error::NoMac: Refused: ${code}\\. \\(${code}\\)`));
      assert.equal(nomac.seen.filter(line => line.startsWith("POST")).length, 1, code);
    } finally { nomac.close(); }
  }
});

test("publish stops waiting for Apple's processing after wait-minutes, and needs the build named", async () => {
  const nomac = await stand([[409, { error: { code: "build_processing", message: "Apple is still processing build 1.2 (7).", retry_after_seconds: 0 } }]]);
  try {
    const result = await step("publish", nomac.url, { ...publishInputs, "INPUT_WAIT-MINUTES": "0" });
    assert.equal(result.code, 1);
    assert.match(result.out, /::error::NoMac: Apple is still processing build 1\.2 \(7\)\. \(build_processing; still so after the step's wait\)/);
  } finally { nomac.close(); }
  const unnamed = await step("publish", "http://127.0.0.1:9", { "INPUT_BUNDLE-ID": "com.acme.app" });
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.out, /needs bundle-id, version and build/);
});

test("never sends the job's token anywhere but NoMac or a stand-in on this computer", async () => {
  const { apiBase } = await import("../lib/nomac.mjs");
  assert.equal(apiBase(""), "https://nomac.app");
  for (const elsewhere of ["https://evil.example", "http://nomac.app", "http://localhost:3000", "http://127.0.0.1.evil.example:80", "http://127.0.0.1:80/x"]) assert.equal(apiBase(elsewhere), "https://nomac.app", elsewhere);
  assert.equal(apiBase("http://127.0.0.1:4321"), "http://127.0.0.1:4321");
});
