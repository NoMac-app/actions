// After the job, cancelled or not: a phone the run started and did not stop (the run was cancelled, or crashed) is
// stopped now, so it bills no longer. The phone stops by itself after 10 idle minutes anyway.
import { input } from "../lib/nomac.mjs";
import { phones } from "./nomac.mjs";

const phone = process.env.STATE_phone, apiKey = input("api-key");
if (phone && process.env.STATE_stopped !== "1" && apiKey && /^ses_[A-Za-z0-9_-]{1,80}$/.test(phone)) {
  console.log(`::add-mask::${apiKey}`);
  try {
    await phones(apiKey).stop(phone);
    console.log(`Stopped the phone ${phone}, which the run left running.`);
  } catch (error) {
    console.log(`::warning::The phone ${phone} did not stop (${error.message}); it stops by itself after 10 idle minutes.`);
  }
}
