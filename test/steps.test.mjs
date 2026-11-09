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

test("never sends the job's token anywhere but NoMac or a stand-in on this computer", async () => {
  const { apiBase } = await import("../lib/nomac.mjs");
  assert.equal(apiBase(""), "https://nomac.app");
  for (const elsewhere of ["https://evil.example", "http://nomac.app", "http://localhost:3000", "http://127.0.0.1.evil.example:80", "http://127.0.0.1:80/x"]) assert.equal(apiBase(elsewhere), "https://nomac.app", elsewhere);
  assert.equal(apiBase("http://127.0.0.1:4321"), "http://127.0.0.1:4321");
});
