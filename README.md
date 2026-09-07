# Tiba x Terminal 3

> **Merged into Tiba.** This integration now lives in the Tiba product itself, wired
> into the payout decision it was built for: https://github.com/Tiba-Rail/tiba
> See the "Terminal 3 Identity" section of that README, and run it with `npm run t3:demo`.
> This repo is kept only as the standalone build history.


An org-owned Terminal 3 agent, delegated exactly one function, proven live, driving
a real pay/refuse decision for [Tiba](https://github.com/Tiba-Rail/tiba) -- a wallet
for AI agents that pays real people within owner-set limits, only after two isolated
model checks agree, and settles on Sui testnet with a public receipt for every outcome.

Tiba's recipients carry `kycStatus` / `kycProvider` fields today backed by a mock
provider (`prisma/schema.prisma`, `src/lib/identity.ts` in the Tiba repo). This is
the start of replacing that mock with Terminal 3's real identity + delegation stack.

Built for the AI Tinkerers KL x Terminal 3 Agent Dev Kit build night, 7 September 2026.

## Run it

```
npm install
cp .env.example .env   # fill in T3_ACCOUNT_DID and T3_API_KEY
npm run demo
```

`T3_API_KEY` is a secp256k1 private key -- get your own at go.terminal3.io (Agent
Dev Kit). Nothing here is a fixture or a mock server: every step is a real call to
Terminal 3's `cn-api.sg.testnet.t3n.terminal3.io` testnet node.

## What it does, in order

1. **Authenticates as the human owner** -- WASM handshake + Ethereum signature,
   `@terminal3/t3n-sdk` 5.2.0 (pinned; 5.10.0 breaks against this testnet cluster,
   see below).
2. **Provisions Tiba a payment agent** -- `createOrganisation("Tiba Payments")`,
   then `createAgent(org, "tiba-payment-agent")`. A fresh secp256k1 wallet is
   minted for the agent inside the TEE; the script only ever sees its one-time
   opaque bearer `apiKey`. Idempotent: a second run reuses the org/agent recorded
   in `.agent-state.json` instead of minting new ones.
3. **Grants the agent exactly one function, for one hour** -- a `BoundGrant` on
   `tee:user/contracts`, `functions: ["kyc-status"]`, with `allowed_hosts: []`
   (no egress) and a 3600s validity window. Nothing else this agent might ask
   for is in scope.
4. **Proves the grant live, as the agent** -- `discoverCheckDelegation`, called
   with the agent's own `apiKey` (not the owner's session), asks "can I call
   kyc-status?" (yes) and "can I call otp-request?" (no, never granted). Same
   key, same contract, two different answers -- the scope is enforced
   server-side, not decorative.
5. **Loads a recipient from Tiba's payout queue** -- a local stand-in, see
   *What's real vs. stubbed* below.
6. **Runs the actual KYC check the grant authorizes** -- `tee:user::kyc-status`.
7. **Tiba decides** -- pay only on a live, explicit `"verified"` answer.
   Everything else, including an error, refuses. No result is faked to make
   the demo look better than the account's real KYC state.
8. **Pulls the audit trail back from Terminal 3** -- `getActivityLog()`, showing
   every call this run just made, its outcome, and its per-entry hash, straight
   off the node's append-only ledger.

## What's real vs. what's stubbed

**Real, live, on Faris's actual testnet account, every run:**
- Human authentication, org creation, agent creation, the delegation grant,
  the two `discoverCheckDelegation` checks, the `kyc-status` call, and the
  activity log pull. Nothing here is replayed output -- rerun it and you get
  fresh `seq_no`s and hashes from the node.

**Stubbed, and why:**
- **The "recipient" is a local JSON file** (`recipients.json`), not Tiba's
  Postgres database. Wiring it to the real DB is a schema/API-boundary change
  inside the Tiba repo, not a Terminal 3 limitation -- out of scope for a
  100-minute build window, straightforward for a follow-up PR.
- **The recipient's Terminal 3 identity is Faris's own DID**, not a
  third party's. This isn't a shortcut we chose -- it's a hard platform
  constraint, confirmed live tonight: `tee:user::kyc-status` is self-only on
  this SDK (the type signature takes no target-DID param, and there is no
  agent-registry equivalent for a third party's KYC). The only path visible
  in the SDK for a real recipient is for *them* to hold their own Terminal 3
  account and run their own Veriff session. So the honest thing to demo is
  the mechanism checking the one real identity available, not a fabricated
  "verified" for someone who was never actually checked.
- **The KYC answer is "refused" (`precondition_failed`), not "verified."**
  This is also not faked or worked around: `create-kyc-provider-session` --
  the step that's supposed to fire automatically after `submitUserInput`
  mints a `t3n.user-input.kyc.1` event -- never fires on this testnet
  cluster (confirmed by direct activity-log inspection: the event that should
  trigger it commits, the session row that should follow it never appears).
  Tiba's refuse-by-default decision logic is exactly what it would do in
  production against this exact state, honestly reported, not routed around.

## Confirmed platform boundaries (found live tonight, not guessed)

- **`invoke()` (the agent's stateless, api-key, no-session call path) is
  restricted to `z:` (tenant-published) contracts.** A raw call to
  `POST /api/invoke` against `tee:user/contracts` returns `400`:
  `"invoke is restricted to z: (tenant) contracts"`. So an org agent's
  zero-session credential is scoped to *your own* published business
  contracts, not Terminal 3's core `tee:` contracts directly -- the design
  intent looks like: your `z:` contract runs inside the TEE and calls into
  `tee:` on the agent's behalf there, not from an external caller. Tiba
  would need to publish its own tenant contract to let an agent exercise
  `kyc-status` end to end without the owner's session in the loop; that's
  the concrete next step, not attempted tonight (contract publishing is a
  separate, unexplored SDK surface).
- **SDK pinned to `@terminal3/t3n-sdk@5.2.0`.** `5.10.0` throws `"Trust
  manifest is malformed"` -- it demands an `rtmr1_allowlist` this testnet
  cluster's deployed manifest doesn't publish (only `rtmr3_allowlist`).
- **`createOrganisation()` / `createAgent()` / `authenticate()` return a
  `Did` object** (`{value, toString()}`), not a plain string. Passing one
  straight into another call's `string`-typed parameter serialises it as a
  nested map and the node 400s (`"parse input: invalid type: map, expected
  a string"`). Every call site here does `String(did)` first.
- **`getActivityLog()` refuses once the caller belongs to more than one
  organisation** (`"the caller belongs to 2 organisations; the report scope
  is ambiguous"`) -- there's no org-scoping parameter to disambiguate. The
  demo self-heals this (see `deleteOrganisation` cleanup in `demo.mjs`,
  step 2) in case an earlier run left a stray org behind.
- **The session-based `client.checkDelegation()` is not a per-agent check.**
  Called from the owner's own authenticated session it answers "would *I*,
  the owner, be allowed to do this for myself" -- which is trivially true
  regardless of any grant, so it can't prove an agent's specific scope. The
  real per-agent check is `discoverCheckDelegation()`, called with the
  agent's own `apiKey` over `/api/discover` -- that's what step 4 uses, and
  it's the one that actually returns `false` for an ungranted function.

## Files

- `demo.mjs` -- the whole live demo, one command, numbered steps.
- `recipients.json` -- the local Tiba payout-queue stand-in (see above).
- `probe-invoke.mjs` / `probe-discover.mjs` -- the raw-fetch / SDK probes that
  found the `z:`-only boundary and validated `discoverCheckDelegation`; kept
  for reference, not needed to run the demo.
- `.agent-state.json` (gitignored, created on first run) -- the org DID, agent
  DID, and agent `apiKey` this demo provisioned, so reruns don't mint fresh
  ones every time. Contains a live bearer credential -- never commit it.

## Never in this repo

- `.env` (the real private key / API key) -- gitignored.
- `.agent-state.json` (the agent's bearer `apiKey`) -- gitignored.
- The private key itself is never printed, logged, or included in any error
  message (the SDK's own `invoke()`/`InvokeError` error-hygiene design
  deliberately strips it from every failure path too).
