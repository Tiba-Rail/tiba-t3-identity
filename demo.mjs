// Tiba x Terminal 3 -- live demo.
//
// REAL, live against Faris's testnet account, every run:
//   - human auth (WASM handshake + Ethereum signature)
//   - org + org-owned agent provisioning
//   - a one-function delegation grant (BoundGrant)
//   - proof of that grant, evaluated AS THE AGENT via its own opaque api
//     key (discoverCheckDelegation) -- both a call it's allowed to make
//     and one it isn't
//   - the actual KYC status read the grant authorizes (tee:user::kyc-status)
//   - the append-only activity log entry Terminal 3 recorded for it
// STAND-IN, local only: the "recipient" Tiba is paying -- see README and
// recipients.json for exactly why, and what a real integration needs.
//
// One command: `npm run demo` (or `node demo.mjs`)
import fs from "node:fs";
import {
  T3nClient, loadWasmComponent, createEthAuthInput, eth_get_address,
  metamask_sign, fetchTrustedManifest, NODE_URLS, discoverCheckDelegation,
} from "@terminal3/t3n-sdk";

const ROOT = new URL("./", import.meta.url);
const STATE_FILE = new URL("./.agent-state.json", ROOT);
const RECIPIENTS_FILE = new URL("./recipients.json", ROOT);

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", ROOT), "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const baseUrl = NODE_URLS.testnet;
let step = 0;
const say = (s) => console.log(`\n[${++step}] ${s}`);
const line = (s = "") => console.log(s);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---------------------------------------------------------------------------
say("Authenticating as Faris (human, WASM handshake + Ethereum signature)");
const pk = env.T3_API_KEY;
const address = eth_get_address(pk);
const client = new T3nClient({
  baseUrl,
  trustAnchor: await fetchTrustedManifest("testnet", { baseUrl }),
  wasmComponent: await loadWasmComponent(),
  handlers: { EthSign: metamask_sign(address, undefined, pk) },
});
await client.handshake();
// authenticate() / createOrganisation() / createAgent() all return a `Did`
// object ({value, toString()}), not a plain string -- coerce with String()
// or the wire request nests it as a map and the node 400s ("parse input:
// invalid type: map, expected a string").
const ownerDid = String(await client.authenticate(createEthAuthInput(address)));
line(`    authenticated as ${ownerDid}`);

// ---------------------------------------------------------------------------
say("Getting Tiba a payment agent on Terminal 3 (org + agent + one-function grant)");
let state = loadState();

if (state?.orgDid && state?.agentDid && state?.apiKey) {
  line(`    reusing org + agent created by an earlier run of this demo:`);
  line(`    org:   ${state.orgDid}`);
  line(`    agent: ${state.agentDid}`);
} else {
  let orgDid = state?.orgDid;
  if (!orgDid) {
    orgDid = String(await client.createOrganisation("Tiba Payments"));
    line(`    createOrganisation("Tiba Payments") -> ${orgDid}`);
    state = { orgDid };
    saveState(state); // don't lose the org DID if agent creation below fails
  } else {
    line(`    reusing org from an earlier run: ${orgDid}`);
  }

  const created = await client.createAgent(orgDid, "tiba-payment-agent", { defaultCard: false });
  const agentDidStr = String(created.agentDid);
  line(`    createAgent(org, "tiba-payment-agent") -> ${agentDidStr}`);
  line(`    one-time apiKey captured (never printed again, never committed)`);

  state = { orgDid, agentDid: agentDidStr, apiKey: created.apiKey };
  saveState(state);
}
const { orgDid, agentDid, apiKey } = state;

// getActivityLog's scope resolves to "every org the caller belongs to" and
// refuses ("ambiguous... no single admin roster can gate it") once that's
// more than one. A misfire earlier tonight left a second, agent-less org on
// this account -- clean it up so step 6 below can run.
const orgs = (await client.myOrgs()).map(String);
for (const stray of orgs.filter((o) => o !== orgDid)) {
  try {
    await client.deleteOrganisation(stray);
    line(`    removed a stray empty org from an earlier crashed run: ${stray}`);
  } catch (e) {
    line(`    left stray org ${stray} in place (${e.message})`);
  }
}

// ---------------------------------------------------------------------------
say("Granting the agent EXACTLY one function, for one hour: kyc-status on tee:user/contracts");
const now = Math.floor(Date.now() / 1000);
const grant = {
  grantee: agentDid,
  contract_id: "tee:user/contracts",
  functions: ["kyc-status"],
  scopes: [],
  read_scopes: [],
  allowed_hosts: [],
  window: { valid_from_secs: now, valid_until_secs: now + 3600 },
};
await client.updateMemberDelegation(grant);
line(`    updateMemberDelegation(...) committed. Grant: ${JSON.stringify(grant.functions)} only, expires in 1h.`);

// ---------------------------------------------------------------------------
say("Proving the grant live -- checked AS THE AGENT, with its own api key, not the owner session");
const grantedCheck = await discoverCheckDelegation(
  { baseUrl, apiKey },
  { contract: "tee:user/contracts", pii_did: ownerDid, functions: ["kyc-status"], scopes: [] },
);
line(`    agent asks "can I call kyc-status?"   -> authorised: ${grantedCheck.authorised}`);
const deniedCheck = await discoverCheckDelegation(
  { baseUrl, apiKey },
  { contract: "tee:user/contracts", pii_did: ownerDid, functions: ["otp-request"], scopes: [] }, // never granted
);
line(`    agent asks "can I call otp-request?" -> authorised: ${deniedCheck.authorised}`);
line(`    same key, same contract, two different answers -- the scope is enforced server-side, not decorative.`);

// ---------------------------------------------------------------------------
say("Loading a recipient from Tiba's payout queue (local stand-in -- see README)");
const recipients = JSON.parse(fs.readFileSync(RECIPIENTS_FILE, "utf8"));
const recipient = recipients[0];
line(`    recipient: ${recipient.name}  ->  invoice ${recipient.invoiceUsd} USD`);
line(`    t3n identity on file: ${recipient.t3nDid}`);

// ---------------------------------------------------------------------------
say("Running the actual KYC check the grant authorizes");
line(`    (tee:user::kyc-status is hard self-only on this SDK -- no third-party target DID exists on any`);
line(`     path, session or agent. So this checks the one live identity in the sandbox: the recipient`);
line(`     stand-in above is that same DID, standing in for "a recipient who has done their own T3 KYC".`);
line(`     A stateless api-key invoke() to tee:user/contracts itself is also platform-refused --`);
line(`     confirmed live: "invoke is restricted to z: (tenant) contracts" -- so tee:* reads still run`);
line(`     on the org's own session, which is exactly the authority this grant just proved the agent holds.)`);
let kyc;
let kycError = null;
try {
  kyc = await client.kycStatus("veriff");
  line(`    kyc-status responded: ${JSON.stringify(kyc)}`);
} catch (e) {
  kycError = e?.message ?? String(e);
  line(`    kyc-status refused: ${kycError}`);
}

// ---------------------------------------------------------------------------
say("Tiba decides: pay only on a live, explicit 'verified' answer -- everything else refuses");
const verified = !kycError && kyc?.status === "verified";
const decision = verified ? "PAY" : "REFUSE";
const reason = kycError
  ? `Terminal 3 could not confirm KYC (${kycError.split(":").slice(0, 2).join(":")})`
  : verified
    ? "Terminal 3 confirmed status: verified"
    : `Terminal 3 reports status: ${kyc?.status}, not verified`;
line(`    decision: ${decision}`);
line(`    reason:   ${reason}`);

// ---------------------------------------------------------------------------
say("Pulling the org's audit trail back from Terminal 3 -- proof of what just happened, hash-stamped and append-only");
const agentLog = await client.getActivityLog({ did: agentDid, limit: 10 });
line(`    entries attributed to the agent DID itself: ${agentLog.entries.length}`);
line(`    (expected zero -- discoverCheckDelegation is a read, and this account's agent has no z:`);
line(`     contract to dispatch through invoke(); nothing for it to have DONE yet, only been AUTHORIZED to.)`);
const orgLog = await client.getActivityLog({ limit: 8 });
line(`    last ${orgLog.entries.length} entries for this org (newest first) -- this run, on the ledger:`);
for (const e of orgLog.entries) {
  line(`      seq ${e.seq_no}  ${e.caller_type.padEnd(6)} ${e.contract}::${e.function}  -> ${e.outcome}  hash ${e.hash.slice(0, 12)}...`);
}

// ---------------------------------------------------------------------------
line();
line("=".repeat(72));
line(`Tiba receipt: ${decision} ${recipient.name} $${recipient.invoiceUsd} -- ${reason}`);
line(`Org:   ${orgDid}`);
line(`Agent: ${agentDid}`);
line("=".repeat(72));
