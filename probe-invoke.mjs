// One-off diagnostic: raw fetch to /api/invoke to see the real error body
// the SDK's invoke() deliberately hides (error-hygiene wrapper).
import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const state = JSON.parse(fs.readFileSync(new URL(".agent-state.json", import.meta.url), "utf8"));

const res = await fetch("https://cn-api.sg.testnet.t3n.terminal3.io/api/invoke", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-T3N-Api-Key": state.apiKey },
  body: JSON.stringify({
    contract_id: "tee:user/contracts",
    contract_version: "3.6.0",
    function_name: "kyc-status",
    pii_did: env.T3_ACCOUNT_DID,
    input: { provider_id: "veriff" },
  }),
});
console.log("status:", res.status);
console.log(await res.text());
