import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";

const RPC = new URLSearchParams(location.search).get("rpc") ?? "http://127.0.0.1:8545";
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const MAX = ethers.MaxUint256;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupError(html) {
  const box = $("#setupError");
  box.innerHTML = html;
  box.hidden = false;
}

const SETUP_STEPS = `<pre>anvil                                  # terminal 1
make demo-deploy                       # terminal 2: deploy + export ABIs
make demo                              # serve http://localhost:5173</pre>`;

let ADDRESSES, ABIS;
try {
  ({ ADDRESSES, ABIS } = await import("./contracts.js"));
} catch {
  setupError(`<h3>No deployment found</h3><p><code>frontend/contracts.js</code> is missing. Run:</p>${SETUP_STEPS}`);
  throw new Error("contracts.js missing");
}

const provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 100 });
const C = {};
const NAME_BY_ADDRESS = {};
for (const [name, addr] of Object.entries(ADDRESSES)) {
  const address = ethers.getAddress(addr);
  C[name] = new ethers.Contract(address, ABIS[name], provider);
  NAME_BY_ADDRESS[address.toLowerCase()] = name;
}

// One interface holding every custom error, so errors bubbling up through other contracts still decode.
const ERRORS = (() => {
  const seen = new Map();
  for (const abi of Object.values(ABIS)) {
    for (const f of abi) if (f.type === "error") seen.set(`${f.name}(${f.inputs.map((i) => i.type)})`, f);
  }
  return new ethers.Interface([...seen.values()]);
})();

const ROLE = Object.fromEntries(
  ["REGISTRAR_ROLE", "DAO_ROLE", "PAUSER_ROLE", "ALLOCATOR_ROLE", "GOVERNOR_ROLE", "MINT_REQUESTER_ROLE", "SETTLER_ROLE", "MINTER_ROLE", "BURNER_ROLE"].map(
    (r) => [r, ethers.id(r)],
  ),
);
const ROLE_NAME = { [ethers.ZeroHash]: "DEFAULT_ADMIN_ROLE", ...Object.fromEntries(Object.entries(ROLE).map(([k, v]) => [v, k])) };

const ROLE_DEFS = [
  { key: "admin", label: "Admin / DAO Timelock", check: (a) => C.AssetRegistry.hasRole(ethers.ZeroHash, a) },
  { key: "governor", label: "Governor", check: (a) => C.CollateralController.hasRole(ROLE.GOVERNOR_ROLE, a) },
  { key: "registrar", label: "Registrar", check: (a) => C.AssetRegistry.hasRole(ROLE.REGISTRAR_ROLE, a) },
  { key: "allocator", label: "Allocator", check: (a) => C.ReserveManager.hasRole(ROLE.ALLOCATOR_ROLE, a) },
  { key: "member", label: "DAO member", check: (a) => C.AssetApprovalDAO.isMember(a) },
  { key: "treasuryOps", label: "Treasury ops", check: (a) => C.CollateralController.hasRole(ROLE.MINT_REQUESTER_ROLE, a) },
  { key: "settler", label: "Settler", check: (a) => C.RedemptionModule.hasRole(ROLE.SETTLER_ROLE, a) },
  { key: "pauser", label: "Pauser multisig", check: (a) => C.VittaStablecoin.hasRole(ROLE.PAUSER_ROLE, a) },
];

const ASSET_STATUS = ["None", "Pending", "Approved", "Rejected", "Suspended", "Retired"];
const ASSET_BADGE = ["", "info", "ok", "bad", "warn", ""];
const DAO_ACTION = ["Approve asset", "Reject asset", "Suspend asset", "Reinstate asset", "Retire asset", "Revalue asset", "Add member", "Remove member"];
const PROPOSAL_STATE = ["None", "Active", "Succeeded", "Defeated", "Executed", "Cancelled"];
const PROPOSAL_BADGE = ["", "info", "ok", "bad", "ok", ""];
const MINT_STATUS = ["None", "Pending", "Executed", "Rejected", "Cancelled"];
const MINT_BADGE = ["", "info", "ok", "bad", ""];
const REDEMPTION_STATUS = ["None", "Pending", "Approved", "Settled", "Rejected", "Cancelled"];
const REDEMPTION_BADGE = ["", "info", "warn", "ok", "bad", ""];
const PAUSABLE = ["AssetRegistry", "VittaStablecoin", "CollateralController", "RedemptionModule"];

/** Latest on-chain state, rebuilt by refresh(). */
const S = { accounts: [], roles: new Map(), members: [], proposals: new Map() };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (s, dp = 2) => Number(s).toLocaleString(undefined, { maximumFractionDigits: dp });
const tok = (v, dec = 18, dp = 2) => num(ethers.formatUnits(v, dec), dp);
const usd = (v, dp = 2) => "$" + tok(v, 18, dp);
const usdc = (v) => tok(v, 6, 2) + " USDC";
const vgusd = (v) => tok(v, 18, 2) + " VGUSD";
const pct = (bps) => (bps === MAX ? "∞" : num(Number(bps) / 100, 2) + "%");
const time = (ts) => (Number(ts) === 0 ? "—" : new Date(Number(ts) * 1000).toLocaleString());
const badge = (text, cls = "") => `<span class="badge ${cls}">${esc(text)}</span>`;
const isErr = (v) => v && typeof v === "object" && "__err" in v;

function dur(seconds) {
  let s = Math.abs(Number(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  s = s % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function b32Label(v) {
  try {
    return ethers.decodeBytes32String(v);
  } catch {
    return v.slice(0, 10) + "…";
  }
}

/** Short strings are stored readable; longer ones (or raw 0x..32 bytes) are hashed / passed through. */
function toBytes32(s) {
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  return ethers.toUtf8Bytes(s).length <= 31 ? ethers.encodeBytes32String(s) : ethers.id(s);
}
const hashText = (s) => (/^0x[0-9a-fA-F]{64}$/.test(s) ? s : ethers.id(s));

function accountName(addr) {
  if (!addr) return "—";
  const a = ethers.getAddress(addr);
  const i = S.accounts.indexOf(a);
  if (i >= 0) return `#${i} ${roleLabel(a)}`;
  const contract = NAME_BY_ADDRESS[a.toLowerCase()];
  if (contract) return contract;
  if (a === ethers.ZeroAddress) return "0x0";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function roleLabel(addr) {
  const keys = S.roles.get(addr) ?? new Set();
  const labels = ROLE_DEFS.filter((r) => keys.has(r.key) && !(r.key === "governor" && keys.has("admin"))).map((r) => r.label);
  if (labels.length) return labels.join(" · ");
  return addr === S.holder ? "Holder" : "No role";
}

const who = (addr) => `<span title="${esc(addr)}">${esc(accountName(addr))}</span>`;

function fmtValue(key, v, contract) {
  if (typeof v === "bigint") {
    if (v === MAX) return "∞";
    const dec = contract === "MockUSDC" || /usdc/i.test(key) ? 6 : 18;
    if (/bps|ratio/i.test(key) || v < 10n ** BigInt(dec - 4)) return v.toString();
    return tok(v, dec, 4);
  }
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return accountName(v);
  if (typeof v === "string" && ROLE_NAME[v]) return ROLE_NAME[v];
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return b32Label(v);
  if (Array.isArray(v)) return `[${v.map((x) => fmtValue("", x, contract)).join(", ")}]`;
  return String(v);
}

// ---------------------------------------------------------------------------
// Errors & events
// ---------------------------------------------------------------------------

function revertData(e) {
  const seen = new Set();
  const stack = [e];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    if (typeof x.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(x.data)) return x.data;
    for (const k of ["info", "error", "cause", "data"]) stack.push(x[k]);
  }
  return null;
}

function decodeError(e) {
  const data = revertData(e);
  if (data) {
    try {
      const p = ERRORS.parseError(data);
      const args = p.fragment.inputs.map((inp, i) => `${inp.name || i}=${fmtValue(inp.name, p.args[i])}`);
      return `${p.name}(${args.join(", ")})`;
    } catch {}
    try {
      if (data.startsWith("0x08c379a0")) return `Error("${ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]}")`;
      if (data.startsWith("0x4e487b71")) return `Panic(0x${ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10))[0].toString(16)})`;
    } catch {}
    return `revert ${data.slice(0, 10)}`;
  }
  return e?.shortMessage ?? e?.message ?? String(e);
}

function decodeLogs(rc) {
  const out = [];
  for (const log of rc.logs) {
    const contract = NAME_BY_ADDRESS[log.address.toLowerCase()];
    if (!contract) continue;
    try {
      const p = C[contract].interface.parseLog(log);
      if (!p) continue;
      const args = p.fragment.inputs.map((inp, i) => `${inp.name}=${fmtValue(inp.name, p.args[i], contract)}`);
      out.push({ contract, name: p.name, args: p.args, text: `${contract}.<b>${p.name}</b>(${esc(args.join(", "))})` });
    } catch {}
  }
  return out;
}

const eventArg = (events, name, arg) => events.find((e) => e.name === name)?.args[arg];

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function logEntry(title, from) {
  const li = document.createElement("li");
  li.className = "entry";
  li.innerHTML = `<div class="t">${esc(title)}</div>${from ? `<div class="from">from ${esc(accountName(from))} · pending…</div>` : ""}`;
  $("#log").prepend(li);
  const setFrom = (txt) => {
    const el = $(".from", li);
    if (el) el.textContent = `from ${accountName(from)} · ${txt}`;
  };
  return {
    ok(rc, events) {
      li.classList.add("ok");
      setFrom(`block ${rc.blockNumber} · gas ${rc.gasUsed}`);
      li.insertAdjacentHTML("beforeend", events.map((e) => `<div class="ev">${e.text}</div>`).join(""));
    },
    fail(msg) {
      li.classList.add("fail");
      setFrom("reverted");
      li.insertAdjacentHTML("beforeend", `<div class="err">✗ ${esc(msg)}</div>`);
    },
    expected(msg) {
      li.classList.add("expected");
      setFrom("reverted as expected");
      li.insertAdjacentHTML("beforeend", `<div class="err">✓ ${esc(msg)}</div>`);
    },
  };
}

function logStep(text, cls = "step") {
  const li = document.createElement("li");
  li.className = `entry ${cls}`;
  li.innerHTML = text;
  $("#log").prepend(li);
}
const logNote = (text) => logStep(`<span class="from">${text}</span>`, "note");

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

class TxFailed extends Error {}

/** Account a transaction is sent from: the role holder in auto mode (or when forced), else the acting account. */
function pickFrom(as, force) {
  const selected = $("#accountSelect").value;
  if (!as || (!force && !$("#autoRole").checked)) return selected;
  if (as.startsWith("0x")) return ethers.getAddress(as);
  if (as === "holder") return S.holder ?? selected;
  for (const [addr, keys] of S.roles) if (keys.has(as)) return addr;
  return selected;
}

/**
 * Sends a transaction and logs it. With `expect`, a revert whose decoded error contains that text is a pass
 * and success is a failure — used by scenarios to assert negative paths.
 */
async function send({ as, contract, method, args = [], label, force = false, expect }) {
  const from = pickFrom(as, force);
  const entry = logEntry(label ?? `${contract}.${method}`, from);
  let rc, events;
  try {
    const signer = await provider.getSigner(from);
    const tx = await C[contract].connect(signer)[method](...args);
    rc = await tx.wait();
    events = decodeLogs(rc);
  } catch (e) {
    const msg = decodeError(e);
    if (expect && msg.includes(expect)) {
      entry.expected(msg);
      return { reverted: msg };
    }
    entry.fail(expect ? `expected ${expect}, got ${msg}` : msg);
    throw new TxFailed(msg);
  }
  if (expect) {
    entry.fail(`expected revert ${expect}, but it succeeded`);
    throw new TxFailed("unexpected success");
  }
  entry.ok(rc, events);
  return { rc, events };
}

async function warp(seconds) {
  await provider.send("evm_increaseTime", [Number(seconds)]);
  await provider.send("evm_mine", []);
  logNote(`⏱ advanced chain time by ${dur(seconds)}`);
}

let busy = false;
async function run(btn, fn) {
  if (busy) return;
  busy = true;
  $$("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof TxFailed)) {
      console.error(e);
      logStep(`<span class="err">${esc(decodeError(e))}</span>`, "fail");
    }
  } finally {
    busy = false;
    $$("button").forEach((b) => (b.disabled = false));
    await refresh();
  }
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/** Resolves an object of promises; a rejected read becomes { __err } instead of failing the refresh. */
async function all(obj) {
  const keys = Object.keys(obj);
  const vals = await Promise.all(keys.map((k) => Promise.resolve(obj[k]).catch((e) => ({ __err: decodeError(e) }))));
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

async function loadRoles() {
  const results = await Promise.all(S.accounts.map((a) => Promise.all(ROLE_DEFS.map((r) => r.check(a)))));
  S.roles = new Map(S.accounts.map((a, i) => [a, new Set(ROLE_DEFS.filter((_, j) => results[i][j]).map((r) => r.key))]));
  S.holder = S.accounts.find((a) => S.roles.get(a).size === 0) ?? S.accounts.at(-1);
}

async function refresh() {
  try {
    await refreshInner();
  } catch (e) {
    console.error(e);
    setupError(`<h3>Cannot read chain state</h3><p>${esc(decodeError(e))}</p><p>Is anvil running at <code>${esc(RPC)}</code> with the contracts deployed?</p>${SETUP_STEPS}`);
  }
}

async function refreshInner() {
  const block = await provider.getBlock("latest");
  S.now = BigInt(block.timestamp);
  S.block = block.number;
  await loadRoles();

  const R = C.AssetRegistry, D = C.AssetApprovalDAO, RM = C.ReserveManager, P = C.ProofOfReserve;
  const T = C.VittaStablecoin, CC = C.CollateralController, RD = C.RedemptionModule, O = C.ChainlinkPriceOracle;

  const g = await all({
    nextAssetId: R.nextAssetId(),
    members: D.members(),
    quorum: D.quorum(),
    threshold: D.approvalThresholdBps(),
    votingPeriod: D.votingPeriod(),
    proposalCount: D.proposalCount(),
    poolCount: RM.poolCount(),
    reserveValue: RM.totalReserveValue(),
    summary: P.reserveSummary(),
    snapshotCount: P.snapshotCount(),
    snapshotInterval: P.minSnapshotInterval(),
    supply: T.totalSupply(),
    ratio: CC.collateralRatioBps(),
    minRatio: CC.minCollateralRatioBps(),
    ceiling: CC.debtCeiling(),
    maxMintable: CC.maxMintable(),
    healthy: CC.isHealthy(),
    nextMintId: CC.nextMintRequestId(),
    reservedUSDC: RD.reservedUSDC(),
    locked: RD.lockedAmount(),
    discount: RD.discountBps(),
    minRedemption: RD.minRedemptionAmount(),
    nextRedemptionId: RD.nextRedemptionId(),
    quote100: RD.quote(ethers.parseEther("100")),
    price: O.price(),
    feedPrice: O.feedPrice(),
    fallbackPrice: O.fallbackPrice(),
    fallbackUntil: O.fallbackValidUntil(),
    maxStaleness: O.maxStaleness(),
    feedAnswer: C.MockPriceFeed.answer(),
    feedUpdatedAt: C.MockPriceFeed.updatedAt(),
    treasuryUSDC: C.MockTreasury.availableUSDC(),
    treasuryAuth: C.MockTreasury.authorized(RD.target),
    paused: Promise.all(PAUSABLE.map((n) => C[n].paused())),
  });
  Object.assign(S, g);
  S.members = [...g.members].map((a) => ethers.getAddress(a));

  const range = (from, to) => Array.from({ length: Math.max(0, Number(to) - from) }, (_, i) => BigInt(i + from));

  [S.assets, S.proposalList, S.pools, S.mints, S.redemptions, S.snapshots, S.balances] = await Promise.all([
    Promise.all(
      range(1, g.nextAssetId).map(async (id) => ({
        id,
        ...(await all({
          a: R.getAsset(id),
          owner: R.ownerOf(id),
          allocated: RM.allocatedBps(id),
          reserve: RM.assetReserveValue(id),
          openProposal: D.openProposalForAsset(id),
        })),
      })),
    ),
    Promise.all(
      range(1, g.proposalCount + 1n).map(async (id) => {
        const [p, state] = await Promise.all([D.getProposal(id), D.state(id)]);
        const voters = await Promise.all(
          S.members.map(async (m) => ({ m, voted: await D.hasVoted(id, m), since: await D.memberSince(m) })),
        );
        return { id, p, state: Number(state), canVote: voters.filter((v) => !v.voted && v.since <= p.createdAt).map((v) => v.m) };
      }),
    ),
    Promise.all(range(1, g.poolCount + 1n).map(async (id) => ({ id, pool: await RM.getPool(id), assets: await RM.poolAssets(id) }))),
    Promise.all(range(1, g.nextMintId).map(async (id) => ({ id, r: await CC.getMintRequest(id) }))),
    Promise.all(range(1, g.nextRedemptionId).map(async (id) => ({ id, r: await RD.getRedemption(id) }))),
    g.snapshotCount > 0n ? P.getSnapshots(g.snapshotCount > 10n ? g.snapshotCount - 10n : 0n, 10n) : [],
    Promise.all(
      S.accounts.map(async (a) => ({
        a,
        ...(await all({
          eth: provider.getBalance(a),
          vgusd: T.balanceOf(a),
          usdc: C.MockUSDC.balanceOf(a),
          nfts: R.balanceOf(a),
          allowance: T.allowance(a, RD.target),
        })),
      })),
    ),
  ]);
  S.proposals = new Map(S.proposalList.map((p) => [p.id, p]));

  $("#setupError").hidden = true;
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function table(headers, rows, empty = "Nothing yet.") {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td${c?.cls ? ` class="${c.cls}"` : ""}>${c?.html ?? c ?? ""}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}
const actions = (html) => ({ cls: "actions", html });
const btn = (action, label, data = {}, cls = "small") =>
  `<button class="${cls}" data-action="${action}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ")}>${label}</button>`;
const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

function render() {
  $("#chainInfo").textContent = `Anvil · block ${S.block} · ${time(S.now)} · ${RPC}`;
  renderSelects();
  renderStats();
  renderAssets();
  renderDao();
  renderReserves();
  renderMints();
  renderRedemptions();
  renderOracle();
  renderPause();
  renderAccounts();
  fillParamForms();
}

function renderSelects() {
  const accountOpts = S.accounts.map((a, i) => `<option value="${a}">#${i} ${esc(roleLabel(a))} — ${a.slice(0, 6)}…${a.slice(-4)}</option>`).join("");
  for (const sel of [$("#accountSelect"), ...$$("select[data-accounts]")]) {
    const prev = sel.value;
    sel.innerHTML = accountOpts;
    if (prev) sel.value = prev;
    else if (sel.dataset.default === "holder") sel.value = S.holder;
  }
  const memberOpts = S.members.map((m) => `<option value="${m}">${esc(accountName(m))}</option>`).join("");
  for (const sel of $$("select[data-members]")) {
    const prev = sel.value;
    sel.innerHTML = memberOpts;
    if (prev && S.members.includes(prev)) sel.value = prev;
  }
  const poolOpts = S.pools.map(({ id, pool }) => `<option value="${id}">#${id} ${esc(pool.name)}</option>`).join("");
  for (const sel of $$("select[data-pools]")) {
    const prev = sel.value;
    sel.innerHTML = poolOpts;
    if (prev) sel.value = prev;
  }
}

function stat(k, v, s = "", cls = "") {
  return `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}

function renderStats() {
  const sum = S.summary;
  const openProps = S.proposalList.filter((p) => p.state === 1 || p.state === 2).length;
  $("#stats").innerHTML = [
    stat("Reserve value", usd(S.reserveValue, 0), "ReserveManager.totalReserveValue"),
    stat("Approved asset value", usd(sum.approvedAssetValue, 0), `unallocated ${usd(sum.unallocatedValue, 0)}`),
    stat("VGUSD supply", tok(S.supply, 18, 0), `debt ceiling ${tok(S.ceiling, 18, 0)}`),
    stat("Collateral ratio", pct(S.ratio), `minimum ${pct(S.minRatio)}`, S.healthy ? "good" : "bad"),
    stat("Max mintable", tok(S.maxMintable, 18, 0), "VGUSD right now"),
    stat("Oracle price", isErr(S.price) ? "no price" : usd(S.price, 4), S.feedPrice[0] ? "from feed" : isErr(S.price) ? "feed stale, no fallback" : "fallback active", isErr(S.price) ? "bad" : ""),
    stat("Treasury USDC", tok(S.treasuryUSDC, 6, 0), `reserved ${tok(S.reservedUSDC, 6, 0)}`),
    stat("Locked in redemptions", tok(S.locked, 18, 0), "VGUSD"),
    stat("Assets", sum.totalAssets.toString(), `${sum.pendingAssets} pending · ${sum.approvedAssets} approved · ${sum.suspendedAssets} suspended`),
    stat("Open proposals", String(openProps), `${S.proposalCount} total`),
    stat("Paused", String(S.paused.filter(Boolean).length), PAUSABLE.filter((_, i) => S.paused[i]).join(", ") || "none", S.paused.some(Boolean) ? "bad" : ""),
  ].join("");
}

function renderAssets() {
  const rows = S.assets.map(({ id, a, owner, allocated, reserve, openProposal }) => {
    const st = Number(a.status);
    const open = openProposal && S.proposals.get(openProposal);
    const hasOpen = open && (open.state === 1 || open.state === 2);
    let acts = "";
    if (hasOpen) acts = `<span class="hint">proposal #${openProposal} open</span>`;
    else if (st === 1) acts = btn("quickPropose", "Propose approve", { id, kind: 0 }) + btn("quickPropose", "Propose reject", { id, kind: 1 }, "small ghost");
    else if (st === 2)
      acts =
        btn("prefillAllocate", "Allocate…", { id }) +
        btn("quickPropose", "Suspend", { id, kind: 2 }, "small ghost") +
        btn("prefillRevalue", "Revalue…", { id, val: ethers.formatEther(a.valuation) }, "small ghost") +
        btn("quickPropose", "Retire", { id, kind: 4 }, "small ghost");
    else if (st === 4) acts = btn("quickPropose", "Propose reinstate", { id, kind: 3 }) + btn("quickPropose", "Retire", { id, kind: 4 }, "small ghost");
    if (st === 1 || st === 3) acts += btn("prefillUpdate", st === 3 ? "Resubmit…" : "Edit…", { id, val: ethers.formatEther(a.valuation) }, "small ghost");
    return [
      `#${id}`,
      esc(b32Label(a.assetClass)),
      `<span class="mono">${esc(b32Label(a.externalRef))}</span>`,
      usd(a.valuation, 0),
      badge(ASSET_STATUS[st], ASSET_BADGE[st]),
      pct(allocated),
      usd(reserve, 0),
      who(owner),
      actions(acts),
    ];
  });
  $("#assetsTable").innerHTML = table(["#", "Class", "Ref", "Valuation", "Status", "Allocated", "In reserves", "Owner", ""], rows, "No assets registered yet — register one above or run scenario A.");
}

function renderDao() {
  $("#daoInfo").innerHTML = kv([
    ["Members", S.members.map((m) => who(m)).join(", ")],
    ["Rules", `quorum ${S.quorum} · threshold ${pct(S.threshold)} of For+Against · voting period ${dur(S.votingPeriod)}`],
    ["Early decision", `when For votes ≥ quorum and For ≥ ${pct(S.threshold)} of all eligible members`],
  ]);
  const rows = [...S.proposalList].reverse().map(({ id, p, state, canVote }) => {
    const action = Number(p.action);
    const target = action <= 5 ? `asset #${p.assetId}${action === 5 ? ` → ${usd(p.newValuation, 0)}` : ""}` : who(p.account);
    const left = p.deadline - S.now;
    let acts = "";
    if ((state === 1 || state === 2) && left > 0n && canVote.length) {
      acts += `<select>${canVote.map((m) => `<option value="${m}">${esc(accountName(m))}</option>`).join("")}</select>`;
      acts += btn("vote", "For", { id, support: 1 }) + btn("vote", "Against", { id, support: 0 }, "small ghost") + btn("vote", "Abstain", { id, support: 2 }, "small ghost");
    }
    if (state === 2) acts += btn("execute", "Execute", { id });
    if (state === 1 || state === 2) acts += btn("cancelProposal", "Cancel", { id, proposer: p.proposer }, "small ghost");
    return [
      `#${id}`,
      DAO_ACTION[action],
      target,
      who(p.proposer),
      `${p.forVotes} / ${p.againstVotes} / ${p.abstainVotes} <span class="hint">of ${p.eligibleVoters}</span>`,
      left > 0n ? `in ${dur(left)}` : "ended",
      badge(PROPOSAL_STATE[state], PROPOSAL_BADGE[state]),
      actions(acts),
    ];
  });
  $("#proposalsTable").innerHTML = table(["#", "Action", "Target", "Proposer", "For / Against / Abstain", "Deadline", "State", ""], rows, "No proposals yet.");
}

function renderReserves() {
  $("#poolsTable").innerHTML = table(
    ["#", "Pool", "Value", "Assets", ""],
    S.pools.map(({ id, pool, assets }) => [
      `#${id}`,
      `${esc(pool.name)} ${pool.active ? "" : badge("inactive", "warn")}`,
      usd(pool.value, 0),
      assets.length ? assets.map((a) => `#${a}`).join(", ") : "—",
      actions(btn("setPoolActive", pool.active ? "Deactivate" : "Activate", { id, value: !pool.active }, "small ghost")),
    ]),
  );

  const sum = S.summary;
  $("#porSummary").innerHTML = kv([
    ["Reserve value", usd(sum.reserveValue)],
    ["Approved asset value", usd(sum.approvedAssetValue)],
    ["Unallocated", usd(sum.unallocatedValue)],
    ["Liabilities (VGUSD supply)", vgusd(sum.liabilities)],
    ["Reserve ratio", pct(sum.reserveRatioBps)],
    ["Asset counts", `${sum.totalAssets} total · ${sum.pendingAssets} pending · ${sum.approvedAssets} approved · ${sum.rejectedAssets} rejected · ${sum.suspendedAssets} suspended · ${sum.retiredAssets} retired`],
    ["Last snapshot", time(sum.lastSnapshotAt)],
  ]);

  const next = sum.lastSnapshotAt === 0n ? 0n : sum.lastSnapshotAt + S.snapshotInterval;
  $("#snapshotHint").textContent =
    next <= S.now ? `Allowed now (min interval ${dur(S.snapshotInterval)}).` : `Next allowed in ${dur(next - S.now)} — earlier calls revert with SnapshotTooSoon.`;

  const first = S.snapshotCount > 10n ? S.snapshotCount - 10n : 0n;
  $("#snapshotsTable").innerHTML = table(
    ["#", "Time", "Block", "Reserve", "Approved value", "Liabilities", "Ratio", "Approved assets"],
    [...S.snapshots]
      .map((s, i) => [
        `#${first + BigInt(i)}`,
        time(s.timestamp),
        s.blockNumber.toString(),
        usd(s.reserveValue, 0),
        usd(s.approvedAssetValue, 0),
        tok(s.liabilities, 18, 0),
        pct(s.liabilities === 0n ? MAX : (s.reserveValue * 10000n) / s.liabilities),
        s.approvedAssetCount.toString(),
      ])
      .reverse(),
    "No snapshots recorded yet.",
  );
}

function renderMints() {
  $("#maxMintHint").textContent = `Max mintable now: ${vgusd(S.maxMintable)} (ratio ≥ ${pct(S.minRatio)}, ceiling ${vgusd(S.ceiling)}).`;
  const rows = [...S.mints].reverse().map(({ id, r }) => {
    const st = Number(r.status);
    const acts =
      st === 1
        ? btn("approveMint", "Approve", { id }) + btn("rejectMint", "Reject", { id }, "small ghost") + btn("cancelMint", "Cancel", { id, requester: r.requester }, "small ghost")
        : "";
    return [`#${id}`, who(r.to), vgusd(r.amount), who(r.requester), time(r.createdAt), badge(MINT_STATUS[st], MINT_BADGE[st]), actions(acts)];
  });
  $("#mintsTable").innerHTML = table(["#", "Recipient", "Amount", "Requester", "Created", "Status", ""], rows, "No mint requests yet.");
}

function renderRedemptions() {
  const holder = S.balances.find((b) => b.a === S.holder);
  $("#redeemInfo").innerHTML =
    `<h3>Redemption module</h3>` +
    kv([
      ["Holder balance", holder ? vgusd(holder.vgusd) : "—"],
      ["Holder USDC", holder ? usdc(holder.usdc) : "—"],
      ["Discount", `${S.discount} bps`],
      ["Minimum", vgusd(S.minRedemption)],
      ["Quote for 100", isErr(S.quote100) ? `<span class="badge bad">${esc(S.quote100.__err)}</span>` : usdc(S.quote100)],
      ["Locked", vgusd(S.locked)],
      ["Reserved USDC", usdc(S.reservedUSDC)],
      ["Treasury available", usdc(S.treasuryUSDC)],
    ]);
  updateQuote();

  const rows = [...S.redemptions].reverse().map(({ id, r }) => {
    const st = Number(r.status);
    let acts = "";
    if (st === 1) acts = btn("approveRedemption", "Approve", { id }) + btn("rejectRedemption", "Reject", { id }, "small ghost") + btn("cancelRedemption", "Cancel", { id, redeemer: r.redeemer }, "small ghost");
    if (st === 2) acts = btn("settle", "Settle", { id }) + btn("rejectRedemption", "Reject", { id }, "small ghost");
    return [
      `#${id}`,
      who(r.redeemer),
      vgusd(r.amount),
      r.priceUsed ? usd(r.priceUsed, 4) : "—",
      r.usdcAmount ? usdc(r.usdcAmount) : "—",
      time(r.createdAt),
      badge(REDEMPTION_STATUS[st], REDEMPTION_BADGE[st]),
      actions(acts),
    ];
  });
  $("#redemptionsTable").innerHTML = table(["#", "Redeemer", "Amount", "Price", "USDC payout", "Created", "Status", ""], rows, "No redemptions yet.");
}

let quoteSeq = 0;
async function updateQuote() {
  const seq = ++quoteSeq;
  const input = $('[data-form="requestRedemption"] [name="amount"]');
  let text;
  try {
    const q = await C.RedemptionModule.quote(ethers.parseEther(input.value || "0"));
    text = `Payout at current price: ${usdc(q)}`;
  } catch (e) {
    text = `Quote unavailable: ${decodeError(e)}`;
  }
  if (seq === quoteSeq) $("#quoteHint").textContent = text;
}

function renderOracle() {
  const age = S.now - S.feedUpdatedAt;
  const fresh = S.feedPrice[0];
  $("#oracleInfo").innerHTML =
    `<h3>ChainlinkPriceOracle</h3>` +
    kv([
      ["Effective price()", isErr(S.price) ? badge(S.price.__err, "bad") : usd(S.price, 4)],
      ["Feed answer", `${num(ethers.formatUnits(S.feedAnswer, 8), 6)} (8 decimals)`],
      ["Feed age", `${dur(age)} ${fresh ? badge("fresh", "ok") : badge("stale", "bad")}`],
      ["Max staleness", dur(S.maxStaleness)],
      ["Fallback price", S.fallbackPrice ? usd(S.fallbackPrice, 4) : "not set"],
      ["Fallback valid until", S.fallbackPrice ? `${time(S.fallbackUntil)} ${S.fallbackUntil >= S.now ? badge("active", "ok") : badge("expired")}` : "—"],
      ["Redemption price", "min(oracle, $1) − discount"],
    ]);
  $("#treasuryAuth").innerHTML = `RedemptionModule may call <code>releaseUSDC</code>: ${S.treasuryAuth ? badge("authorised", "ok") : badge("not authorised", "bad")}`;
}

function renderPause() {
  $("#pauseTable").innerHTML = table(
    ["Contract", "State", ""],
    PAUSABLE.map((name, i) => [
      name,
      S.paused[i] ? badge("paused", "bad") : badge("live", "ok"),
      actions(btn("pause", "Pause · Pauser", { contract: name }, "small ghost") + btn("unpause", "Unpause · Admin", { contract: name })),
    ]),
  );
}

function renderAccounts() {
  const acting = $("#accountSelect").value;
  $("#accountsTable").innerHTML = table(
    ["#", "Roles", "Address", "ETH", "VGUSD", "USDC", "Asset NFTs", ""],
    S.balances.map((b, i) => [
      `#${i}`,
      esc(roleLabel(b.a)),
      `<span class="addr">${b.a}</span>`,
      num(ethers.formatEther(b.eth), 2),
      tok(b.vgusd, 18, 2),
      tok(b.usdc, 6, 2),
      b.nfts.toString(),
      actions(b.a === acting ? badge("acting", "info") : btn("useAccount", "Act as", { addr: b.a }, "small ghost")),
    ]),
  );
}

function fillParamForms() {
  const set = (form, name, value) => {
    const el = $(`[data-form="${form}"] [name="${name}"]`);
    if (!el.dataset.touched && document.activeElement !== el) el.value = value;
  };
  set("daoSettings", "votingPeriod", S.votingPeriod.toString());
  set("daoSettings", "quorum", S.quorum.toString());
  set("daoSettings", "threshold", S.threshold.toString());
  set("controllerParams", "ratio", String(Number(S.minRatio) / 100));
  set("controllerParams", "ceiling", ethers.formatEther(S.ceiling));
  set("redemptionParams", "discount", S.discount.toString());
  set("redemptionParams", "minAmount", ethers.formatEther(S.minRedemption));
  set("snapshotInterval", "interval", S.snapshotInterval.toString());
}

// ---------------------------------------------------------------------------
// Flow helpers (shared by buttons and scenarios)
// ---------------------------------------------------------------------------

async function propose(action, assetId, proposer, evidence = "verification-report", force = false) {
  const { events } = await send({
    as: proposer ?? S.members[0],
    force,
    contract: "AssetApprovalDAO",
    method: "proposeAssetAction",
    args: [action, assetId, hashText(evidence), `${DAO_ACTION[action]} #${assetId}`],
    label: `Propose: ${DAO_ACTION[action]} #${assetId}`,
  });
  return eventArg(events, "ProposalCreated", "id");
}

/** Votes For with eligible members until the proposal succeeds (warping past the deadline if needed), then executes. */
async function passProposal(id) {
  const D = C.AssetApprovalDAO;
  const p = await D.getProposal(id);
  for (const m of S.members) {
    if ((await D.state(id)) === 2n) break;
    if ((await D.hasVoted(id, m)) || (await D.memberSince(m)) > p.createdAt) continue;
    await send({ as: m, force: true, contract: "AssetApprovalDAO", method: "castVote", args: [id, 1, "demo vote"], label: `Vote For on #${id}` });
  }
  if ((await D.state(id)) === 1n) await warp(p.deadline - BigInt((await provider.getBlock("latest")).timestamp) + 1n);
  await send({ as: "holder", force: true, contract: "AssetApprovalDAO", method: "execute", args: [id], label: `Execute proposal #${id}` });
}

async function ensureFreshPrice() {
  const [ok] = await C.ChainlinkPriceOracle.feedPrice();
  if (!ok) {
    const answer = await C.MockPriceFeed.answer();
    await send({ as: "holder", force: true, contract: "MockPriceFeed", method: "setAnswer", args: [answer > 0n ? answer : 10n ** 8n], label: "Refresh stale price feed" });
  }
}

async function redeem(amount, force) {
  await send({ as: "holder", force, contract: "VittaStablecoin", method: "approve", args: [C.RedemptionModule.target, amount], label: `Approve ${vgusd(amount)} to RedemptionModule` });
  const { events } = await send({ as: "holder", force, contract: "RedemptionModule", method: "requestRedemption", args: [amount], label: `Request redemption of ${vgusd(amount)}` });
  return eventArg(events, "RedemptionRequested", "id");
}

const settlementRef = (id) => ethers.id(`SETTLEMENT-${id}-${Date.now()}`);
const randomRef = () => `GIA-${Math.floor(1e9 + Math.random() * 9e9)}`;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = {
  async happy() {
    logStep("▶ Scenario A · Happy path");
    await ensureFreshPrice();

    logStep("1. Registrar registers a $1.5M gem lot");
    const ref = randomRef();
    const { events } = await send({
      as: "registrar", force: true, contract: "AssetRegistry", method: "registerAsset",
      args: [S.accounts[0], toBytes32("GEMSTONE"), toBytes32(ref), hashText(`${ref}-docs.zip`), ethers.parseEther("1500000"), "ipfs://demo-gem"],
      label: `Register ${ref}`,
    });
    const assetId = eventArg(events, "AssetRegistered", "assetId");

    logStep(`2. DAO approves asset #${assetId}`);
    await passProposal(await propose(0, assetId, null, "gia-verification", true));

    logStep("3. Allocator allocates 100% to the Stablecoin Reserve pool");
    await send({ as: "allocator", force: true, contract: "ReserveManager", method: "allocate", args: [assetId, 1n, 10000n], label: `Allocate #${assetId} → pool #1 (100%)` });

    logStep("4. Proof of Reserve snapshot");
    try {
      await send({ as: "holder", force: true, contract: "ProofOfReserve", method: "recordSnapshot", label: "recordSnapshot()" });
    } catch {
      logNote("Snapshot rate-limited — continuing (use +1m to allow the next one).");
    }

    const mintAmount = [ethers.parseEther("500000"), await C.CollateralController.maxMintable()].reduce((a, b) => (a < b ? a : b));
    logStep(`5. Treasury ops request ${vgusd(mintAmount)} → governor approves`);
    const m = await send({ as: "treasuryOps", force: true, contract: "CollateralController", method: "requestMint", args: [S.holder, mintAmount], label: `Request mint ${vgusd(mintAmount)} → holder` });
    const mintId = eventArg(m.events, "MintRequested", "id");
    await send({ as: "governor", force: true, contract: "CollateralController", method: "approveMint", args: [mintId], label: `Approve mint #${mintId}` });

    logStep("6. Holder redeems 100,000 VGUSD → DAO approves → Settlement API settles");
    const rid = await redeem(ethers.parseEther("100000"), true);
    await send({ as: "governor", force: true, contract: "RedemptionModule", method: "approveRedemption", args: [rid], label: `Approve redemption #${rid}` });
    await send({ as: "settler", force: true, contract: "RedemptionModule", method: "settle", args: [rid, settlementRef(rid)], label: `Settle redemption #${rid}` });

    const [bal, usdcBal, ratio] = await Promise.all([C.VittaStablecoin.balanceOf(S.holder), C.MockUSDC.balanceOf(S.holder), C.CollateralController.collateralRatioBps()]);
    logStep(`✔ Done · holder has ${vgusd(bal)} and ${usdc(usdcBal)} · collateral ratio ${pct(ratio)}`, "ok");
  },

  async suspend() {
    logStep("▶ Scenario B · Backing asset suspended");
    await refreshInner();
    const target = [...S.assets].reverse().find((x) => Number(x.a.status) === 2 && x.reserve > 0n && !openAssetProposal(x));
    if (!target) return logStep("No approved, allocated asset without an open proposal — run scenario A first.", "fail");

    logNote(`Before: reserves ${usd(S.reserveValue, 0)}, ratio ${pct(S.ratio)}, max mintable ${vgusd(S.maxMintable)}`);
    logStep(`1. DAO suspends asset #${target.id}`);
    await passProposal(await propose(2, target.id, null, "audit-finding", true));

    const [reserve, ratio, healthy] = await Promise.all([C.ReserveManager.totalReserveValue(), C.CollateralController.collateralRatioBps(), C.CollateralController.isHealthy()]);
    logNote(`After: reserves ${usd(reserve, 0)}, ratio ${pct(ratio)}, healthy = ${healthy}`);

    logStep("2. Keeper runs checkReserveRatio()");
    const { events } = await send({ as: "holder", force: true, contract: "CollateralController", method: "checkReserveRatio", label: "checkReserveRatio()" });
    logNote(events.some((e) => e.name === "ReserveRatioAlert") ? "ReserveRatioAlert emitted ✓" : "No alert (still healthy — other assets back the supply).");

    logStep("3. A new mint must now fail the collateral check");
    const m = await send({ as: "treasuryOps", force: true, contract: "CollateralController", method: "requestMint", args: [S.holder, ethers.parseEther("1")], label: "Request mint 1 VGUSD" });
    const mintId = eventArg(m.events, "MintRequested", "id");
    const r = await send({ as: "governor", force: true, contract: "CollateralController", method: "approveMint", args: [mintId], label: `Approve mint #${mintId}`, expect: healthy ? undefined : "InsufficientCollateral" });
    if (r.reverted) await send({ as: "governor", force: true, contract: "CollateralController", method: "rejectMint", args: [mintId, "insufficient collateral"], label: `Reject mint #${mintId}` });
    logStep("✔ Done · run scenario C to reinstate the asset", "ok");
  },

  async reinstate() {
    logStep("▶ Scenario C · Reinstate & revalue");
    await refreshInner();
    const target = [...S.assets].reverse().find((x) => Number(x.a.status) === 4 && !openAssetProposal(x));
    if (!target) return logStep("No suspended asset without an open proposal — run scenario B first.", "fail");

    logStep(`1. DAO reinstates asset #${target.id}`);
    await passProposal(await propose(3, target.id, null, "remediation-report", true));
    logNote(`Reserves ${usd(await C.ReserveManager.totalReserveValue(), 0)} · max mintable ${vgusd(await C.CollateralController.maxMintable())}`);

    const newVal = (target.a.valuation * 12n) / 10n;
    logStep(`2. DAO revalues asset #${target.id} from ${usd(target.a.valuation, 0)} to ${usd(newVal, 0)}`);
    const { events } = await send({
      as: S.members[0], force: true, contract: "AssetApprovalDAO", method: "proposeRevaluation",
      args: [target.id, newVal, hashText("appraisal-2026"), "Annual revaluation +20%"], label: `Propose revaluation #${target.id}`,
    });
    await passProposal(eventArg(events, "ProposalCreated", "id"));
    const [reserve, ratio, max] = await Promise.all([C.ReserveManager.totalReserveValue(), C.CollateralController.collateralRatioBps(), C.CollateralController.maxMintable()]);
    logStep(`✔ Done · reserves ${usd(reserve, 0)} · ratio ${pct(ratio)} · max mintable ${vgusd(max)}`, "ok");
  },

  async pause() {
    logStep("▶ Scenario D · Emergency pause");
    await refreshInner();
    for (const name of ["VittaStablecoin", "CollateralController"]) {
      const i = PAUSABLE.indexOf(name);
      if (!S.paused[i]) await send({ as: "pauser", force: true, contract: name, method: "pause", label: `Pause ${name}` });
    }
    logStep("1. While paused, transfers and mint requests revert");
    await send({ as: "holder", force: true, contract: "VittaStablecoin", method: "transfer", args: [S.accounts[0], 0n], label: "Holder transfers VGUSD", expect: "EnforcedPause" });
    await send({ as: "treasuryOps", force: true, contract: "CollateralController", method: "requestMint", args: [S.holder, ethers.parseEther("1")], label: "Request mint", expect: "EnforcedPause" });

    logStep("2. The pauser multisig cannot unpause");
    await send({ as: "pauser", force: true, contract: "VittaStablecoin", method: "unpause", label: "Pauser tries unpause", expect: "AccessControlUnauthorizedAccount" });

    logStep("3. The DAO admin unpauses");
    await send({ as: "admin", force: true, contract: "VittaStablecoin", method: "unpause", label: "Admin unpauses VittaStablecoin" });
    await send({ as: "admin", force: true, contract: "CollateralController", method: "unpause", label: "Admin unpauses CollateralController" });
    await send({ as: "holder", force: true, contract: "VittaStablecoin", method: "transfer", args: [S.accounts[0], 0n], label: "Holder transfers VGUSD" });
    logStep("✔ Done", "ok");
  },

  async access() {
    logStep("▶ Scenario E · Access control (every call from the plain holder)");
    const h = S.holder;
    const denied = "AccessControlUnauthorizedAccount";
    const tries = [
      ["AssetRegistry", "registerAsset", [h, toBytes32("GEMSTONE"), toBytes32(randomRef()), ethers.id("x"), 1n, ""], denied],
      ["AssetRegistry", "setStatus", [1n, 2, "hack"], denied],
      ["AssetApprovalDAO", "proposeAssetAction", [0, 1n, ethers.ZeroHash, "hack"], "NotMember"],
      ["ReserveManager", "allocate", [1n, 1n, 100n], denied],
      ["ReserveManager", "createPool", ["hack"], denied],
      ["VittaStablecoin", "mint", [h, 1n], denied],
      ["VittaStablecoin", "burn", [1n], denied],
      ["CollateralController", "requestMint", [h, 1n], denied],
      ["CollateralController", "approveMint", [1n], denied],
      ["CollateralController", "setDebtCeiling", [MAX], denied],
      ["RedemptionModule", "approveRedemption", [1n], denied],
      ["RedemptionModule", "settle", [1n, ethers.ZeroHash], denied],
      ["RedemptionModule", "setDiscount", [0n], denied],
      ["ChainlinkPriceOracle", "setFallbackPrice", [1n, MAX], denied],
      ["VittaStablecoin", "pause", [], denied],
    ];
    for (const [contract, method, args, expect] of tries) {
      await send({ as: h, force: true, contract, method, args, label: `${contract}.${method}`, expect });
    }
    logStep(`✔ All ${tries.length} unauthorised calls reverted`, "ok");
  },

  async oracle() {
    logStep("▶ Scenario F · Oracle edge cases");
    await refreshInner();
    const amount = ethers.parseEther("20");
    const bal = await C.VittaStablecoin.balanceOf(S.holder);
    if (bal < amount * 2n) return logStep("Holder needs ≥ 40 VGUSD — run scenario A first.", "fail");

    logStep("1. Depeg: feed reports $0.97");
    await send({ as: "holder", force: true, contract: "MockPriceFeed", method: "setAnswer", args: [97_000_000n], label: "Feed → $0.97" });
    logNote(`Quote for 100 VGUSD: ${usdc(await C.RedemptionModule.quote(ethers.parseEther("100")))}`);
    let rid = await redeem(amount, true);
    await send({ as: "governor", force: true, contract: "RedemptionModule", method: "approveRedemption", args: [rid], label: `Approve redemption #${rid} at $0.97` });
    await send({ as: "settler", force: true, contract: "RedemptionModule", method: "settle", args: [rid, settlementRef(rid)], label: `Settle #${rid}` });

    logStep("2. Price above peg is capped at $1");
    await send({ as: "holder", force: true, contract: "MockPriceFeed", method: "setAnswer", args: [102_000_000n], label: "Feed → $1.02" });
    logNote(`Quote for 100 VGUSD: ${usdc(await C.RedemptionModule.quote(ethers.parseEther("100")))} (capped at $1 minus discount)`);

    logStep("3. Stale feed with no fallback blocks approvals");
    await send({ as: "governor", force: true, contract: "ChainlinkPriceOracle", method: "setFallbackPrice", args: [0n, 0n], label: "Clear fallback price" });
    const staleness = await C.ChainlinkPriceOracle.maxStaleness();
    await warp(staleness + 1n);
    rid = await redeem(amount, true);
    await send({ as: "governor", force: true, contract: "RedemptionModule", method: "approveRedemption", args: [rid], label: `Approve redemption #${rid}`, expect: "NoValidPrice" });

    logStep("4. DAO sets a 1-hour fallback price of $0.999 → approval works");
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    await send({ as: "governor", force: true, contract: "ChainlinkPriceOracle", method: "setFallbackPrice", args: [ethers.parseEther("0.999"), now + 3600n], label: "Fallback $0.999 for 1h" });
    await send({ as: "governor", force: true, contract: "RedemptionModule", method: "approveRedemption", args: [rid], label: `Approve redemption #${rid} (fallback)` });
    await send({ as: "settler", force: true, contract: "RedemptionModule", method: "settle", args: [rid, settlementRef(rid)], label: `Settle #${rid}` });

    await send({ as: "holder", force: true, contract: "MockPriceFeed", method: "setAnswer", args: [100_000_000n], label: "Feed back to $1.00" });
    logStep("✔ Done", "ok");
  },
};

function openAssetProposal(x) {
  const p = x.openProposal && S.proposals.get(x.openProposal);
  return p && (p.state === 1 || p.state === 2);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const ACTIONS = {
  quickPropose: (d) => propose(Number(d.kind), BigInt(d.id), "member"),
  vote: (d, el) =>
    send({
      as: el.closest("td").querySelector("select").value,
      contract: "AssetApprovalDAO", method: "castVote", args: [BigInt(d.id), Number(d.support), ""],
      label: `Vote ${["Against", "For", "Abstain"][d.support]} on #${d.id}`,
    }),
  execute: (d) => send({ as: "holder", contract: "AssetApprovalDAO", method: "execute", args: [BigInt(d.id)], label: `Execute proposal #${d.id}` }),
  cancelProposal: (d) => send({ as: d.proposer, contract: "AssetApprovalDAO", method: "cancel", args: [BigInt(d.id)], label: `Cancel proposal #${d.id}` }),
  approveMint: (d) => send({ as: "governor", contract: "CollateralController", method: "approveMint", args: [BigInt(d.id)], label: `Approve mint #${d.id}` }),
  rejectMint: (d) => send({ as: "governor", contract: "CollateralController", method: "rejectMint", args: [BigInt(d.id), "rejected in demo"], label: `Reject mint #${d.id}` }),
  cancelMint: (d) => send({ as: d.requester, contract: "CollateralController", method: "cancelMint", args: [BigInt(d.id)], label: `Cancel mint #${d.id}` }),
  approveRedemption: (d) => send({ as: "governor", contract: "RedemptionModule", method: "approveRedemption", args: [BigInt(d.id)], label: `Approve redemption #${d.id}` }),
  rejectRedemption: (d) => send({ as: "governor", contract: "RedemptionModule", method: "rejectRedemption", args: [BigInt(d.id), "rejected in demo"], label: `Reject redemption #${d.id}` }),
  cancelRedemption: (d) => send({ as: d.redeemer, contract: "RedemptionModule", method: "cancelRedemption", args: [BigInt(d.id)], label: `Cancel redemption #${d.id}` }),
  settle: (d) => send({ as: "settler", contract: "RedemptionModule", method: "settle", args: [BigInt(d.id), settlementRef(d.id)], label: `Settle redemption #${d.id}` }),
  recordSnapshot: () => send({ as: null, contract: "ProofOfReserve", method: "recordSnapshot", label: "recordSnapshot()" }),
  checkReserveRatio: () => send({ as: null, contract: "CollateralController", method: "checkReserveRatio", label: "checkReserveRatio()" }),
  setPoolActive: (d) => send({ as: "admin", contract: "ReserveManager", method: "setPoolActive", args: [BigInt(d.id), d.value === "true"], label: `Set pool #${d.id} active=${d.value}` }),
  pause: (d) => send({ as: "pauser", contract: d.contract, method: "pause", label: `Pause ${d.contract}` }),
  unpause: (d) => send({ as: "admin", contract: d.contract, method: "unpause", label: `Unpause ${d.contract}` }),
  authTreasury: (d) => send({ as: null, contract: "MockTreasury", method: "setAuthorized", args: [C.RedemptionModule.target, d.value === "true"], label: `Treasury authorise RedemptionModule = ${d.value}` }),
  makeStale: async () => {
    const t = BigInt((await provider.getBlock("latest")).timestamp) - (await C.ChainlinkPriceOracle.maxStaleness()) - 1n;
    return send({ as: null, contract: "MockPriceFeed", method: "setUpdatedAt", args: [t], label: "Make feed stale" });
  },
};

// Prefill helpers only move data into forms; they send nothing.
const PREFILL = {
  prefillAllocate: (d) => fill("allocate", { assetId: d.id }),
  prefillRevalue: (d) => fill("proposeRevalue", { assetId: d.id, valuation: d.val }),
  prefillUpdate: (d) => fill("updateAsset", { assetId: d.id, valuation: d.val }),
  useAccount: (d) => {
    $("#accountSelect").value = d.addr;
    renderAccounts();
  },
};

function fill(form, values) {
  const f = $(`[data-form="${form}"]`);
  for (const [k, v] of Object.entries(values)) $(`[name="${k}"]`, f).value = v;
  f.scrollIntoView({ block: "center" });
  f.animate([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], { duration: 1200 });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const FORMS = {
  registerAsset: (v, f) => {
    const p = send({
      as: "registrar", contract: "AssetRegistry", method: "registerAsset",
      args: [v.owner, toBytes32(v.assetClass), toBytes32(v.externalRef), hashText(v.doc), ethers.parseEther(v.valuation), v.uri],
      label: `Register ${v.externalRef}`,
    });
    return p.then(() => ($('[name="externalRef"]', f).value = randomRef()));
  },
  updateAsset: (v) =>
    send({ as: "registrar", contract: "AssetRegistry", method: "updateAsset", args: [BigInt(v.assetId), hashText(v.doc), ethers.parseEther(v.valuation), v.uri], label: `Update asset #${v.assetId}` }),
  transferNft: async (v) => {
    const owner = await C.AssetRegistry.ownerOf(BigInt(v.assetId));
    return send({ as: owner, contract: "AssetRegistry", method: "transferFrom", args: [owner, v.to, BigInt(v.assetId)], label: `Transfer asset NFT #${v.assetId}` });
  },
  proposeAsset: (v) => propose(Number(v.action), BigInt(v.assetId), v.proposer, v.evidence),
  proposeRevalue: (v) =>
    send({ as: v.proposer, contract: "AssetApprovalDAO", method: "proposeRevaluation", args: [BigInt(v.assetId), ethers.parseEther(v.valuation), hashText(v.evidence), v.description], label: `Propose revaluation #${v.assetId}` }),
  proposeMember: (v) =>
    send({ as: v.proposer, contract: "AssetApprovalDAO", method: "proposeMembership", args: [Number(v.action), v.account, v.description], label: `Propose ${DAO_ACTION[v.action]}` }),
  daoSettings: (v) =>
    send({ as: "admin", contract: "AssetApprovalDAO", method: "setSettings", args: [BigInt(v.votingPeriod), BigInt(v.quorum), BigInt(v.threshold)], label: "Update DAO settings" }),
  allocate: (v) =>
    send({ as: "allocator", contract: "ReserveManager", method: "allocate", args: [BigInt(v.assetId), BigInt(v.poolId), BigInt(Math.round(Number(v.pct) * 100))], label: `Allocate #${v.assetId} → pool #${v.poolId} (${v.pct}%)` }),
  createPool: (v) => send({ as: "admin", contract: "ReserveManager", method: "createPool", args: [v.name], label: `Create pool "${v.name}"` }),
  snapshotInterval: (v) => send({ as: "admin", contract: "ProofOfReserve", method: "setMinSnapshotInterval", args: [BigInt(v.interval)], label: "Set snapshot interval" }),
  requestMint: (v) => send({ as: "treasuryOps", contract: "CollateralController", method: "requestMint", args: [v.to, ethers.parseEther(v.amount)], label: `Request mint ${v.amount} VGUSD` }),
  controllerParams: (v, f, which) =>
    which === "ceiling"
      ? send({ as: "governor", contract: "CollateralController", method: "setDebtCeiling", args: [ethers.parseEther(v.ceiling)], label: "Set debt ceiling" })
      : send({ as: "governor", contract: "CollateralController", method: "setMinCollateralRatio", args: [BigInt(Math.round(Number(v.ratio) * 100))], label: "Set min collateral ratio" }),
  transferToken: (v) => send({ as: "holder", contract: "VittaStablecoin", method: "transfer", args: [v.to, ethers.parseEther(v.amount)], label: `Transfer ${v.amount} VGUSD` }),
  requestRedemption: (v) => redeem(ethers.parseEther(v.amount), false),
  redemptionParams: (v, f, which) =>
    which === "min"
      ? send({ as: "governor", contract: "RedemptionModule", method: "setMinRedemptionAmount", args: [ethers.parseEther(v.minAmount)], label: "Set min redemption" })
      : send({ as: "governor", contract: "RedemptionModule", method: "setDiscount", args: [BigInt(v.discount)], label: "Set discount" }),
  feedAnswer: (v) => send({ as: null, contract: "MockPriceFeed", method: "setAnswer", args: [ethers.parseUnits(v.price, 8)], label: `Feed → $${v.price}` }),
  fallback: async (v) => {
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    return send({ as: "governor", contract: "ChainlinkPriceOracle", method: "setFallbackPrice", args: [ethers.parseEther(v.price), now + BigInt(Math.round(Number(v.hours) * 3600))], label: `Fallback $${v.price} for ${v.hours}h` });
  },
  fundTreasury: (v) => send({ as: null, contract: "MockUSDC", method: "mint", args: [C.MockTreasury.target, ethers.parseUnits(v.amount, 6)], label: `Mint ${v.amount} USDC to treasury` }),
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action],[data-scenario],[data-warp]");
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.scenario) return run(el, SCENARIOS[d.scenario]);
  if (d.warp) return run(el, () => warp(BigInt(d.warp)));
  if (PREFILL[d.action]) return PREFILL[d.action](d);
  if (ACTIONS[d.action]) return run(el, () => ACTIONS[d.action](d, el));
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const which = e.submitter?.value;
  run(e.submitter, async () => {
    await FORMS[form.dataset.form](values, form, which);
    $$("[data-touched]", form).forEach((el) => delete el.dataset.touched);
  });
});

document.addEventListener("input", (e) => {
  if (e.target.matches("input")) e.target.dataset.touched = "1";
  if (e.target.closest('[data-form="requestRedemption"]')) updateQuote();
});

$("#accountSelect").addEventListener("change", renderAccounts);
$("#refreshBtn").addEventListener("click", () => run(null, async () => {}));
$("#clearLog").addEventListener("click", () => ($("#log").innerHTML = ""));
$$("[data-random-ref]").forEach((el) => (el.value = randomRef()));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

try {
  S.accounts = (await provider.send("eth_accounts", [])).map((a) => ethers.getAddress(a));
  if ((await provider.getCode(C.AssetRegistry.target)) === "0x") {
    setupError(`<h3>Contracts not found on this node</h3><p>anvil was probably restarted. Redeploy:</p>${SETUP_STEPS}`);
  } else {
    await refresh();
    $("#accountSelect").value = S.holder;
    renderAccounts();
    logNote(`Connected to ${RPC} · ${S.accounts.length} unlocked accounts`);
  }
} catch (e) {
  setupError(`<h3>Cannot reach anvil</h3><p>${esc(decodeError(e))}</p>${SETUP_STEPS}`);
}
