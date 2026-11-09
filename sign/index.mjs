// NoMac's sign step: the project on this job's NoMac Mac gets App Store profiles from NoMac's CI certificate and a
// keychain of its own; the files and commands that sign the archive come back. Only a workflow the account allowed on
// nomac.app/dash/ci, on the default branch (or a tag, if allowed), signs.
import { fail, hand, input, nomac, onMac } from "../lib/nomac.mjs";

const answer = await nomac("POST", "/api/v1/ci/sign", { path: input("path", "."), ...(input("scheme") ? { scheme: input("scheme") } : {}), ...(input("container") ? { container: input("container") } : {}) });
if (!answer?.files?.xcconfig) fail("NoMac's answer named no signing files.");
const build = answer.build_number ? String(answer.build_number) : answer.app_record ? "1" : undefined;
const xcconfig = onMac(answer.files.xcconfig), exportOptions = onMac(answer.files.export_options);
hand({ xcconfig, "export-options": exportOptions, "team-id": answer.team_id, "build-number": build },
  { NOMAC_XCCONFIG: xcconfig, NOMAC_EXPORT_OPTIONS: exportOptions, NOMAC_TEAM_ID: answer.team_id, NOMAC_BUILD_NUMBER: build });
console.log(`Signing ${answer.project.scheme} for team ${answer.team_id} with ${answer.identity?.name ?? "NoMac's CI certificate"}.`);
for (const change of answer.changes ?? []) console.log(`  ${change}`);
for (const profile of answer.profiles ?? []) console.log(`  profile ${profile.name} for ${profile.bundle_id}`);
if (answer.app_record?.message) console.log(`::warning::${answer.app_record.message}`);
console.log(`\nNOMAC_XCCONFIG=${xcconfig}\nNOMAC_EXPORT_OPTIONS=${exportOptions}${build ? `\nNOMAC_BUILD_NUMBER=${build}` : ""}\n\nThe commands:\n  ${answer.commands.xcodebuild.join("\n  ")}`);
