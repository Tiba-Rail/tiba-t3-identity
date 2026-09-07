import fs from "node:fs";
import { discoverCheckDelegation, NODE_URLS } from "@terminal3/t3n-sdk";
const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const state = JSON.parse(fs.readFileSync(new URL(".agent-state.json", import.meta.url), "utf8"));
const opts = { baseUrl: NODE_URLS.testnet, apiKey: state.apiKey };

for (const fn of ["kyc-status", "otp-request"]) {
  try {
    const r = await discoverCheckDelegation(opts, {
      contract: "tee:user/contracts",
      pii_did: env.T3_ACCOUNT_DID,
      functions: [fn],
      scopes: [],
    });
    console.log(fn, "->", JSON.stringify(r));
  } catch (e) {
    console.log(fn, "-> ERROR", e.message);
  }
}
