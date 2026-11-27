/**
 * Reading back what the wallet signed (Solana's wire format) and checking it before anything is sent. Kept apart from
 * the page so it can be tested on its own (test/check.test.ts).
 */
import { AccountRole, address, getAddressDecoder, getBase58Decoder, type Address } from "@solana/kit";

export type Ix = { programAddress: Address; accounts: { address: Address; role: AccountRole }[]; data: Uint8Array };
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
/**
 * Lighthouse: Phantom adds its assertion instructions to mainnet transactions after simulating them (not on devnet).
 * Immutable on mainnet (no upgrade authority, checked 27 Nov 2026); it can only fail a transaction or write its own
 * memory accounts. Allowed below only with new, unsigned accounts of its own.
 */
export const LIGHTHOUSE = address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const dec = getAddressDecoder();
const b58 = getBase58Decoder();

// --- reading back what the wallet signed (Solana's wire format), to check it before it is sent
function shortVec(b: Uint8Array, at: number): [number, number] {
  let n = 0, shift = 0;
  for (let i = 0; i < 3; i++) {
    const x = b[at++];
    if (x === undefined) throw new Error("truncated transaction");
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, at];
    shift += 7;
  }
  throw new Error("bad length in transaction");
}
interface Decoded { signatures: number; signers: number; roSigned: number; roUnsigned: number; keys: string[]; blockhash: string; ixs: { program: string; accounts: number[]; data: Uint8Array }[]; lookups: number }
export function decodeTx(tx: Uint8Array): Decoded {
  let [nSig, at] = shortVec(tx, 0);
  at += 64 * nSig;
  if (tx[at] !== 0x80) throw new Error("not a version 0 transaction");
  at += 1;
  const [signers, roSigned, roUnsigned] = [tx[at], tx[at + 1], tx[at + 2]];
  at += 3;
  let n: number;
  [n, at] = shortVec(tx, at);
  const keys = Array.from({ length: n }, (_, i) => dec.decode(tx.subarray(at + 32 * i, at + 32 * i + 32)));
  at += 32 * n;
  const blockhash = b58.decode(tx.subarray(at, at + 32));
  at += 32;
  [n, at] = shortVec(tx, at);
  const ixs = [];
  for (let i = 0; i < n; i++) {
    const program = keys[tx[at++]];
    let m: number;
    [m, at] = shortVec(tx, at);
    const accounts = Array.from(tx.subarray(at, at + m));
    at += m;
    [m, at] = shortVec(tx, at);
    ixs.push({ program, accounts, data: tx.slice(at, at + m) });
    at += m;
  }
  const [lookups] = shortVec(tx, at);
  return { signatures: nSig, signers, roSigned, roUnsigned, keys, blockhash, ixs, lookups };
}

/** The most a priority fee may cost (as on the website): 0.005 SOL. */
export const MAX_PRIORITY_LAMPORTS = 5_000_000n;

/**
 * The signed transaction must be exactly what the tool built: paid and signed by this wallet alone, the same
 * blockhash, no lookup tables, the same Mercado instruction (program, every account and its role, the data), and
 * nothing else but compute-budget instructions, with any priority fee the wallet added within 0.005 SOL (counting
 * the runtime's default units when no limit is set: 200,000 per program instruction, 3,000 per builtin one).
 */
export function checkSigned(tx: Uint8Array, payer: string, blockhash: string, built: Ix[]): void {
  const m = decodeTx(tx);
  const fail = (why: string) => { throw new Error(`the wallet returned a different transaction (${why}); nothing was sent`); };
  if (m.lookups !== 0) fail("lookup tables");
  if (m.signers !== 1 || m.signatures !== 1) fail("more than one signer");
  if (m.keys[0] !== payer) fail("another fee payer");
  if (m.blockhash !== blockhash) fail("another blockhash");
  const expected = built.filter((i) => i.programAddress !== COMPUTE_BUDGET);
  const ours = m.ixs.filter((i) => i.program !== COMPUTE_BUDGET && i.program !== LIGHTHOUSE);
  const guards = m.ixs.filter((i) => i.program === LIGHTHOUSE);
  // Phantom adds one guard per account it watches, so a bigger step can carry a dozen or more (27 Nov 2026: a swap
  // accept on the website got more than 8). The count is only a sanity bound; the rules below keep the trade's
  // accounts and roles exact.
  if (guards.length > 48) fail("too many Lighthouse instructions");
  if (expected.length !== 1 || ours.length !== 1) fail("instruction count");
  const [want, got] = [expected[0], ours[0]];
  if (got.program !== want.programAddress) fail("another program");
  if (got.data.length !== want.data.length || !got.data.every((x, i) => x === want.data[i])) fail("other instruction data");
  if (got.accounts.length !== want.accounts.length) fail("other accounts");
  got.accounts.forEach((k, n) => { if (m.keys[k] !== want.accounts[n].address) fail(`account ${n + 1}`); });
  // Exact roles (final re-check, A): every key in the message must have exactly the role the built transaction gives
  // it, where a key used twice (the fee payer that is also the signer, say) takes the strongest of its uses, as the
  // compiler merges them. No extra keys, none missing, no account made writable or a signer that wasn't.
  const role = new Map<string, { s: boolean; w: boolean }>([[payer, { s: true, w: true }]]);
  const use = (a: string, s: boolean, w: boolean) => { const r = role.get(a); role.set(a, { s: s || !!r?.s, w: w || !!r?.w }); };
  for (const ix of built) {
    use(ix.programAddress, false, false);
    for (const a of ix.accounts ?? []) use(a.address, a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER, a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER);
  }
  // A wallet may add its own compute-budget instructions (a priority fee, say), which brings in the Compute Budget
  // program's address, read-only. It is allowed only then; the instructions themselves are checked below (final
  // re-check, A: a priority fee within the cap must never block a cancel).
  if (m.ixs.some((i) => i.program === COMPUTE_BUDGET)) use(COMPUTE_BUDGET, false, false);
  if (guards.length) use(LIGHTHOUSE, false, false);
  // Accounts only Lighthouse names (its memory accounts, what it asserts on): new to the message, never a signer. Every
  // account of the trade keeps exactly its role, so a guard can't make one writable.
  const guardOnly = new Set<string>();
  for (const g of guards) for (const k of g.accounts) if (!role.has(m.keys[k])) guardOnly.add(m.keys[k]);
  if (m.keys.length !== role.size + guardOnly.size) fail("other accounts in the message");
  m.keys.forEach((key, k) => {
    const signer = k < m.signers;
    const writable = signer ? k < m.signers - m.roSigned : k < m.keys.length - m.roUnsigned;
    if (guardOnly.has(key)) { if (signer) fail(`Lighthouse signer ${key}`); return; }
    const r = role.get(key);
    if (!r) fail(`unexpected account ${key}`);
    if (r!.s !== signer || r!.w !== writable) fail(`role of ${key}`);
  });
  const budget = m.ixs.filter((i) => i.program === COMPUTE_BUDGET);
  const seen = new Set<number>();
  let limit = 200_000n * BigInt(1 + guards.length) + 3_000n * BigInt(budget.length), price = 0n;
  if (limit > 1_400_000n) limit = 1_400_000n; // the runtime never gives a transaction more
  for (const b of budget) {
    if (b.accounts.length || seen.has(b.data[0])) fail("compute budget");
    seen.add(b.data[0]);
    const v = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    if (b.data[0] === 1 && b.data.length === 5) { if (v.getUint32(1, true) > 256 * 1024) fail("heap"); }
    else if (b.data[0] === 2 && b.data.length === 5) { limit = BigInt(v.getUint32(1, true)); if (limit > 1_400_000n) fail("compute units"); }
    else if (b.data[0] === 3 && b.data.length === 9) price = v.getBigUint64(1, true);
    // A loaded-account-data limit only makes a transaction stricter (as the website allows): 1 byte to 64 MiB.
    else if (b.data[0] === 4 && b.data.length === 5) { const n = v.getUint32(1, true); if (n === 0 || n > 64 * 1024 * 1024) fail("loaded-data limit"); }
    else fail("unknown compute budget instruction");
  }
  if ((limit * price + 999_999n) / 1_000_000n > MAX_PRIORITY_LAMPORTS) fail("priority fee above 0.005 SOL");
}

