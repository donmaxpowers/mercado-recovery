/**
 * MERCADO MIGORY recovery tool.
 *
 * A single page that works without mercado.migory.com: it talks only to a Solana RPC node and the holder's wallet.
 * It can only use the exits the Mercado program always allows:
 *   - cancel_listing: the seller takes their own listing down; the item is thawed and released.
 *   - close_stale_listing: anyone closes a listing whose item moved or lost Mercado's delegate; the item is
 *     thawed first and the listing's rent goes back to its seller.
 *   - cancel_offer: the bidder takes back the SOL held in their offer (item offers and family offers).
 *   - end_swap: the offerer (any time), the lister (to decline) or anyone (after expiry) ends a swap offer; the SOL
 *     goes back to the offerer. It releases no items, so one stuck item can't block the refund.
 *   - release_swap_items: anyone thaws an ended swap offer's items and hands them back, a few per transaction.
 * Every transaction is built here from the program's published interface (idl/mercado.json): the instruction's
 * discriminator and account order come from that file, and nothing else is added. Since v1.3.0 the wallet only signs:
 * the tool checks the signed bytes against what it built (payer, blockhash, the one Mercado instruction, its accounts
 * and data, compute-budget limits, priority fee at most 0.005 SOL), checks the RPC is the chosen network, sends the
 * transaction itself and reports it only once the network confirms it.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import { getWallets } from "@wallet-standard/app";
import idl from "../idl/mercado.json";

const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const SYSTEM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const NETWORKS: Record<string, { rpc: string; chain: string; program: string }> = {
  mainnet: { rpc: "https://api.mainnet-beta.solana.com", chain: "solana:mainnet", program: "" }, // filled in at mainnet launch
  devnet: { rpc: "https://api.devnet.solana.com", chain: "solana:devnet", program: idl.address },
  localnet: { rpc: "http://127.0.0.1:8899", chain: "solana:localnet", program: idl.address },
};

// ------------------------------------------------------------------ text (English / Spanish)
const T = {
  en: {
    title: "MERCADO MIGORY recovery tool",
    intro: "Use this if mercado.migory.com is down or you don't trust it. It talks only to Solana and your wallet. It can only take things back out of Mercado: cancel listings, close stale ones, cancel your offers and end swap offers.",
    network: "Network", rpc: "RPC address", program: "Mercado program", connect: "Connect wallet", noWallet: "No Phantom, Solflare or Backpack wallet found in this browser.",
    yours: "Your listings", none: "No Mercado listings for this wallet.", cancel: "Cancel listing", price: "Price", id: "Listing",
    stale: "Close a stale listing", staleHelp: "For a listing whose item moved or lost Mercado's delegate. Anyone can do this; the item is thawed and the rent goes to its seller.",
    asset: "Item address", close: "Close it", sent: "Confirmed", failed: "Failed", loading: "Loading…", connected: "Connected",
    missingProgram: "Set the Mercado program address for this network first.",
    offers: "Your offers", noOffers: "No open offers from this wallet.", cancelOffer: "Cancel offer, get the SOL back", offer: "Offer", family: "family offer", itemOffer: "item offer", held: "Held", each: "each", left: "left",
    swaps: "Your swap offers", noSwaps: "No swap offers made by or to this wallet.", swap: "Swap offer", youOffered: "You offered", offeredToYou: "Offered to you",
    items: "items", plus: "plus", expired: "expired", expires: "expires", ended: "ended, items waiting", endSwap: "End it, return the SOL", release: "Hand back the next {n}",
    swapBy: "Finish a swap offer", swapByHelp: "Anyone can end a swap offer once it has expired, and anyone can hand back the items of an ended one. Paste the swap offer's address (it is on its offer page).",
    swapAddr: "Swap offer address", find: "Find it", notSwap: "No Mercado swap offer at this address.", notYet: "Only its offerer or lister can end it before it expires.",
    confirming: "Sent, waiting for the network to confirm:", failedOnChain: "The network refused it:", notConfirmed: "Not confirmed in time; check before trying again:",
    one: "Hand back only this one", unreadable: "A swap offer here can't be read right now (status unavailable). Try again later.",
  },
  es: {
    title: "Herramienta de recuperación de MERCADO MIGORY",
    intro: "Úsala si mercado.migory.com no funciona o no confías en él. Solo habla con Solana y tu wallet, y solo puede cancelar listados o cerrar listados caducados.",
    network: "Red", rpc: "Dirección RPC", program: "Programa de Mercado", connect: "Conectar wallet", noWallet: "No se encontró Phantom, Solflare ni Backpack en este navegador.",
    yours: "Tus listados", none: "Esta wallet no tiene listados en Mercado.", cancel: "Cancelar listado", price: "Precio", id: "Listado",
    stale: "Cerrar un listado caducado", staleHelp: "Para un listado cuyo artículo se movió o perdió el delegado de Mercado. Cualquiera puede hacerlo; el artículo se descongela y la renta va a su vendedor.",
    asset: "Dirección del artículo", close: "Cerrarlo", sent: "Confirmado", failed: "Falló", loading: "Cargando…", connected: "Conectada",
    missingProgram: "Primero indica la dirección del programa de Mercado para esta red.",
    offers: "Tus ofertas", noOffers: "Esta wallet no tiene ofertas abiertas.", cancelOffer: "Cancelar oferta y recuperar el SOL", offer: "Oferta", family: "oferta por familia", itemOffer: "oferta por artículo", held: "Retenido", each: "cada uno", left: "restantes",
    swaps: "Tus ofertas de intercambio", noSwaps: "No hay ofertas de intercambio hechas por o para esta wallet.", swap: "Oferta de intercambio", youOffered: "Ofreciste", offeredToYou: "Te ofrecieron",
    items: "artículos", plus: "más", expired: "vencida", expires: "vence", ended: "terminada, artículos por devolver", endSwap: "Terminarla y devolver el SOL", release: "Devolver los siguientes {n}",
    swapBy: "Terminar una oferta de intercambio", swapByHelp: "Cualquiera puede terminar una oferta de intercambio vencida, y cualquiera puede devolver los artículos de una ya terminada. Pega la dirección de la oferta (está en su página).",
    swapAddr: "Dirección de la oferta de intercambio", find: "Buscarla", notSwap: "No hay una oferta de intercambio de Mercado en esta dirección.", notYet: "Antes de que venza, solo quien la hizo o quien listó el artículo puede terminarla.",
    confirming: "Enviada, esperando a que la red confirme:", failedOnChain: "La red la rechazó:", notConfirmed: "No se confirmó a tiempo; revisa antes de volver a intentarlo:",
    one: "Devolver solo este", unreadable: "Una oferta de intercambio aquí no se puede leer ahora (estado no disponible). Inténtalo más tarde.",
  },
};
type Lang = keyof typeof T;
let lang: Lang = navigator.language?.startsWith("es") ? "es" : "en";

// ------------------------------------------------------------------ program interface, from the IDL
const enc = getAddressEncoder();
const dec = getAddressDecoder();
const b58 = getBase58Decoder();

type IdlIx = (typeof idl.instructions)[number];
const ix = (name: string): IdlIx => {
  const i = idl.instructions.find((x) => x.name === name);
  if (!i) throw new Error(`instruction ${name} not in IDL`);
  return i;
};
const LISTING_DISC = new Uint8Array(idl.accounts.find((a) => a.name === "Listing")!.discriminator);

/** Listing account layout (programs/mercado/src/state.rs), after the 8-byte discriminator. */
const LISTING_SIZE = 8 + 1 + 8 + 32 + 32 + 32 + 8 + 1 + 8 + 8;
const SELLER_OFFSET = 8 + 1 + 8 + 32 + 32;
interface Listing { address: Address; id: bigint; asset: Address; collection: Address; seller: Address; price: bigint }
function decodeListing(addr: Address, d: Uint8Array): Listing {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    address: addr,
    id: v.getBigUint64(9, true),
    asset: dec.decode(d.subarray(17, 49)),
    collection: dec.decode(d.subarray(49, 81)),
    seller: dec.decode(d.subarray(81, 113)),
    price: v.getBigUint64(113, true),
  };
}

async function pda(program: Address, seeds: (string | Address)[]): Promise<Address> {
  const bytes = seeds.map((s) => (s.length >= 32 ? (enc.encode(s as Address) as Uint8Array) : new TextEncoder().encode(s)));
  return (await getProgramDerivedAddress({ programAddress: program, seeds: bytes }))[0];
}

type Ix = { programAddress: Address; accounts: { address: Address; role: AccountRole }[]; data: Uint8Array };
const roleOf = (w: boolean, s: boolean) => (w && s ? AccountRole.WRITABLE_SIGNER : w ? AccountRole.WRITABLE : s ? AccountRole.READONLY_SIGNER : AccountRole.READONLY);

/**
 * One Mercado instruction: accounts in the IDL's order and roles, from `known` (an account the IDL names that isn't
 * in `known` is refused); arguments checked against the IDL's names and types (anything else is refused); then the
 * extra accounts some instructions take after their named ones.
 */
function build(name: string, program: Address, known: Record<string, Address>, args: Record<string, { type: string; bytes: Uint8Array }>, extra: Address[] = []): Ix {
  const def = ix(name);
  const accounts = def.accounts.map((a) => {
    const addr = known[a.name];
    if (!addr) throw new Error(`unknown account ${a.name} in IDL`);
    return { address: addr, role: roleOf("writable" in a && !!a.writable, "signer" in a && !!a.signer) };
  });
  if (def.args.length !== Object.keys(args).length) throw new Error(`unexpected arguments for ${name} in IDL`);
  const parts = def.args.map((a) => {
    const v = args[a.name];
    if (!v || JSON.stringify(a.type) !== JSON.stringify(v.type)) throw new Error(`unexpected argument ${a.name} for ${name} in IDL`);
    return v.bytes;
  });
  const data = new Uint8Array(8 + parts.reduce((n, x) => n + x.length, 0));
  data.set(def.discriminator, 0);
  let at = 8;
  for (const x of parts) { data.set(x, at); at += x.length; }
  return { programAddress: program, accounts: [...accounts, ...extra.map((a) => ({ address: a, role: AccountRole.WRITABLE }))], data };
}
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return { type: "u64", bytes: b }; };
const u8 = (n: number) => ({ type: "u8", bytes: Uint8Array.of(n) });
const bytes = (x: Uint8Array) => { const b = new Uint8Array(4 + x.length); new DataView(b.buffer).setUint32(0, x.length, true); b.set(x, 4); return { type: "bytes", bytes: b }; };

/** cancel_listing or close_stale_listing. cancel_listing names the listing it cancels (review finding A-2: a cancel
 *  signed for an older listing of the same item can't end a newer one); close_stale_listing takes no arguments. */
async function closeInstruction(name: "cancel_listing" | "close_stale_listing", program: Address, signer: Address, l: Listing, rpcUrl: string) {
  // The item's collection as it is now (the program checks it); the listing's own if the item is in none or gone.
  const collection = (await collectionOf(rpcUrl, l.asset)) ?? l.collection;
  return build(name, program, {
    signer,
    seller: l.seller,
    config: await pda(program, ["config"]),
    authority: await pda(program, ["authority"]),
    asset: l.asset,
    collection,
    listing: l.address,
    lock: await pda(program, ["lock", l.asset]),
    core_program: CORE,
    system_program: SYSTEM,
  }, name === "cancel_listing" ? { listing_id: u64(l.id) } : {});
}

// ------------------------------------------------------------------ offers (stages 2 and 3)
const OFFER_DISC = new Uint8Array(idl.accounts.find((a) => a.name === "Offer")!.discriminator);
/** Offer layout (state.rs: Offer): version 8, id 9, nonce 17, bidder 25, kind 57, target 58, collection 90, price 122,
 *  quantity 130, filled 131, created 132, expires 140. */
const OFFER_BIDDER = 25;
interface Offer { address: Address; id: bigint; bidder: Address; kind: number; target: Address; price: bigint; quantity: number; filled: number; expiresAt: bigint }
function decodeOffer(addr: Address, d: Uint8Array): Offer {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    address: addr, id: v.getBigUint64(9, true), bidder: dec.decode(d.subarray(25, 57)), kind: d[57], target: dec.decode(d.subarray(58, 90)),
    price: v.getBigUint64(122, true), quantity: d[130], filled: d[131], expiresAt: v.getBigInt64(140, true),
  };
}
/** The bidder takes their offer down at any time; the SOL still held goes back to them. */
const cancelOfferInstruction = (program: Address, o: Offer) => build("cancel_offer", program, { signer: o.bidder, bidder: o.bidder, offer: o.address }, {});

// ------------------------------------------------------------------ swaps (stage 5)
const SWAP_DISC = new Uint8Array(idl.accounts.find((a) => a.name === "Swap")!.discriminator);
/** Swap layout (state.rs: Swap): id 9, nonce 17, offerer 25, lister 57, listing_id 89, listed_asset 97, sol_on_top 129,
 *  fee_held 137, created 145, expires 153, state 161, released 162 (u32 bit set), items 166 (u32 count, then keys). */
const SWAP_OFFERER = 25, SWAP_LISTER = 57, SWAP_ENDED = 1;
/** Items handed back per transaction: few, so one stuck item can't block the rest (as on the site). */
const RELEASE_BATCH = 3;
interface Swap { address: Address; id: bigint; offerer: Address; lister: Address; listedAsset: Address; solOnTop: bigint; expiresAt: bigint; state: number; released: number; items: Address[] }
function decodeSwap(addr: Address, d: Uint8Array): Swap {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint32(166, true);
  if (n > 8 || d.length < 170 + 32 * n) throw new Error("not a current swap offer layout");
  return {
    address: addr, id: v.getBigUint64(9, true), offerer: dec.decode(d.subarray(25, 57)), lister: dec.decode(d.subarray(57, 89)),
    listedAsset: dec.decode(d.subarray(97, 129)), solOnTop: v.getBigUint64(129, true), expiresAt: v.getBigInt64(153, true),
    state: d[161], released: v.getUint32(162, true), items: Array.from({ length: n }, (_, i) => dec.decode(d.subarray(170 + 32 * i, 202 + 32 * i))),
  };
}
const pendingItems = (s: Swap) => s.items.map((_, i) => i).filter((i) => !(s.released & (1 << i)));

/**
 * A Core asset's collection as it is now (base fields: key 1, owner, update authority kind 2 = Collection, then its
 * address), or null: the item is in no collection (its update authority may take it out of one), or it is gone
 * (closed or burned). The program names an item's current collection and needs none in those cases (stage 5
 * re-check), so a release never depends on the collection the item had when it was locked.
 */
async function collectionOf(rpcUrl: string, asset: Address): Promise<Address | null> {
  const info = await createSolanaRpc(rpcUrl).getAccountInfo(asset, { encoding: "base64" }).send();
  if (!info.value || info.value.owner !== CORE) return null;
  const d = getBase64Encoder().encode(info.value.data[0]) as Uint8Array;
  if (d[0] !== 1 || d[33] !== 2) return null;
  return dec.decode(d.subarray(34, 66));
}

/**
 * end_swap with no items (the SOL goes back to the offerer; nothing an item does can stop it), or
 * release_swap_items for the next few items of an ended offer: their collections (each once), then (asset, lock) pairs.
 */
async function swapExitInstruction(rpcUrl: string, program: Address, signer: Address, s: Swap, releaseOnly: boolean, which?: number[]): Promise<Ix> {
  // `which`: the holder's own choice of items (one item that won't unfreeze never holds up the others).
  const idx = releaseOnly ? (which ?? pendingItems(s)).filter((i) => pendingItems(s).includes(i)).slice(0, RELEASE_BATCH) : [];
  if (releaseOnly && !idx.length) throw new Error("no item left to hand back");
  const assets = idx.map((i) => s.items[i]);
  const cols = [...new Set((await Promise.all(assets.map((a) => collectionOf(rpcUrl, a)))).filter((c): c is Address => !!c))];
  const extra: Address[] = [...cols];
  for (const a of assets) extra.push(a, await pda(program, ["lock", a]));
  return build(releaseOnly ? "release_swap_items" : "end_swap", program, {
    signer, offerer: s.offerer, config: await pda(program, ["config"]), authority: await pda(program, ["authority"]),
    swap: s.address, core_program: CORE, system_program: SYSTEM,
  }, { swap_id: u64(s.id), n_collections: u8(cols.length), indexes: bytes(Uint8Array.from(idx)) }, extra);
}

/** Swap steps need more compute than the default and, past a few items, a bigger heap (as on the site). */
function swapBudget(): Ix[] {
  const limit = new Uint8Array(5); limit[0] = 2; new DataView(limit.buffer).setUint32(1, 1_000_000, true);
  const heap = new Uint8Array(5); heap[0] = 1; new DataView(heap.buffer).setUint32(1, 256 * 1024, true);
  return [limit, heap].map((data) => ({ programAddress: COMPUTE_BUDGET, accounts: [], data }));
}

// ------------------------------------------------------------------ wallet (Wallet Standard)
type StdWallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
let wallet: StdWallet | null = null;
let account: { address: string } | null = null;
const SUPPORTED = ["Phantom", "Solflare", "Backpack"];

function wallets(): StdWallet[] {
  // Sign-only wallets (stage 5 re-check): the tool checks what the wallet signed before anything is sent.
  return getWallets().get().filter((w) => SUPPORTED.includes(w.name) && "standard:connect" in w.features && "solana:signTransaction" in w.features);
}

async function connect(w: StdWallet) {
  const f = w.features["standard:connect"] as { connect: () => Promise<{ accounts: { address: string }[] }> };
  const r = await f.connect();
  wallet = w;
  account = r.accounts[0] ?? null;
}

/** Each network's genesis hash: the RPC address given must really be that network before anything is signed. */
const GENESIS: Record<string, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

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
function decodeTx(tx: Uint8Array): Decoded {
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
const MAX_PRIORITY_LAMPORTS = 5_000_000n;

/**
 * The signed transaction must be exactly what the tool built: paid and signed by this wallet alone, the same
 * blockhash, no lookup tables, the same Mercado instruction (program, every account and its role, the data), and
 * nothing else but compute-budget instructions, with any priority fee the wallet added within 0.005 SOL (counting
 * the runtime's default units when no limit is set: 200,000 per program instruction, 3,000 per builtin one).
 */
function checkSigned(tx: Uint8Array, payer: string, blockhash: string, built: Ix[]): void {
  const m = decodeTx(tx);
  const fail = (why: string) => { throw new Error(`the wallet returned a different transaction (${why}); nothing was sent`); };
  if (m.lookups !== 0) fail("lookup tables");
  if (m.signers !== 1 || m.signatures !== 1) fail("more than one signer");
  if (m.keys[0] !== payer) fail("another fee payer");
  if (m.blockhash !== blockhash) fail("another blockhash");
  const expected = built.filter((i) => i.programAddress !== COMPUTE_BUDGET);
  const ours = m.ixs.filter((i) => i.program !== COMPUTE_BUDGET);
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
  if (m.keys.length !== role.size) fail("other accounts in the message");
  m.keys.forEach((key, k) => {
    const r = role.get(key);
    if (!r) fail(`unexpected account ${key}`);
    const signer = k < m.signers;
    const writable = signer ? k < m.signers - m.roSigned : k < m.keys.length - m.roUnsigned;
    if (r!.s !== signer || r!.w !== writable) fail(`role of ${key}`);
  });
  const budget = m.ixs.filter((i) => i.program === COMPUTE_BUDGET);
  const seen = new Set<number>();
  let limit = 200_000n + 3_000n * BigInt(budget.length), price = 0n;
  for (const b of budget) {
    if (b.accounts.length || seen.has(b.data[0])) fail("compute budget");
    seen.add(b.data[0]);
    const v = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    if (b.data[0] === 1 && b.data.length === 5) { if (v.getUint32(1, true) > 256 * 1024) fail("heap"); }
    else if (b.data[0] === 2 && b.data.length === 5) { limit = BigInt(v.getUint32(1, true)); if (limit > 1_400_000n) fail("compute units"); }
    else if (b.data[0] === 3 && b.data.length === 9) price = v.getBigUint64(1, true);
    else fail("unknown compute budget instruction");
  }
  if ((limit * price + 999_999n) / 1_000_000n > MAX_PRIORITY_LAMPORTS) fail("priority fee above 0.005 SOL");
}

/**
 * Builds the transaction, has the wallet sign it (sign only), checks the signed bytes, sends them, and waits until the
 * network confirms them (or says they failed, or the blockhash expires). Returns the signature once confirmed.
 */
async function send(instructions: Ix[], rpcUrl: string, chain: string): Promise<string> {
  if (!wallet || !account) throw new Error("connect a wallet first");
  const rpc = createSolanaRpc(rpcUrl);
  const net = settings().net;
  if (GENESIS[net] && (await rpc.getGenesisHash().send()) !== GENESIS[net]) throw new Error(`the RPC address is not ${net}; nothing was sent`);
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(account!.address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const unsigned = getTransactionEncoder().encode(compileTransaction(msg)) as Uint8Array;
  const f = wallet.features["solana:signTransaction"] as {
    signTransaction: (i: { account: unknown; transaction: Uint8Array; chain: string }) => Promise<{ signedTransaction: Uint8Array }[]>;
  };
  const acct = wallet.accounts.find((a) => a.address === account!.address);
  const [{ signedTransaction }] = await f.signTransaction({ account: acct, transaction: unsigned, chain });
  const signed = new Uint8Array(signedTransaction);
  checkSigned(signed, account.address, blockhash.blockhash, instructions);
  const sig = b58.decode(signed.subarray(1, 65));
  let b64 = "";
  for (let i = 0; i < signed.length; i += 0x8000) b64 += String.fromCharCode(...signed.subarray(i, i + 0x8000));
  await rpc.sendTransaction(btoa(b64) as never, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  status(`${T[lang].confirming} ${sig}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = (await rpc.getSignatureStatuses([sig as never]).send()).value[0];
    if (st?.err) throw new Error(`${T[lang].failedOnChain} ${sig}: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if (i % 5 === 4 && (await rpc.getBlockHeight({ commitment: "confirmed" }).send()) > blockhash.lastValidBlockHeight) break;
  }
  throw new Error(`${T[lang].notConfirmed} ${sig}`);
}

// ------------------------------------------------------------------ page
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (l: bigint) => (Number(l) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " SOL";
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/*
 * Rows are built from DOM nodes and text only (never innerHTML), so nothing an RPC returns can become markup, even an
 * RPC that answers with crafted data (final re-check, A). Every address shown or used is checked to be one.
 */
type Part = string | Node;
function el(tag: string, ...kids: Part[]): HTMLElement {
  const e = document.createElement(tag);
  e.append(...kids);
  return e;
}
const br = () => document.createElement("br");
/** An address as a short code with the full address on hover; anything that isn't an address is refused. */
function addr(a: string): HTMLElement {
  if (!isAddress(a)) throw new Error(`not an address: ${a.slice(0, 60)}`);
  const c = el("code", short(a));
  c.title = a;
  return c;
}

function settings() {
  const net = ($("net") as HTMLSelectElement).value;
  return { net, rpc: ($("rpc") as HTMLInputElement).value.trim(), chain: NETWORKS[net].chain, program: ($("program") as HTMLInputElement).value.trim() };
}

function status(msg: string, bad = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = bad ? "bad" : "";
}

async function loadListings() {
  const s = settings();
  const list = $("listings");
  if (!account) return;
  if (!s.program) return status(T[lang].missingProgram, true);
  list.textContent = T[lang].loading;
  const rpc = createSolanaRpc(s.rpc);
  const res = await rpc
    .getProgramAccounts(address(s.program), {
      encoding: "base64",
      filters: [
        { dataSize: BigInt(LISTING_SIZE) },
        { memcmp: { offset: 0n, bytes: b58.decode(LISTING_DISC) as never, encoding: "base58" } },
        { memcmp: { offset: BigInt(SELLER_OFFSET), bytes: account.address as never, encoding: "base58" } },
      ],
    })
    .send();
  const items = res.filter((r) => isAddress(r.pubkey)).map((r) => decodeListing(r.pubkey, getBase64Encoder().encode(r.account.data[0]) as Uint8Array));
  list.replaceChildren();
  if (!items.length) {
    list.textContent = T[lang].none;
    return;
  }
  for (const l of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.append(el("div", el("b", `${T[lang].id} #${l.id}`), br(), addr(l.asset), ` · ${T[lang].price}: ${sol(l.price)}`));
    const b = document.createElement("button");
    b.textContent = T[lang].cancel;
    b.onclick = async () => {
      try {
        b.disabled = true;
        const sig = await send([await closeInstruction("cancel_listing", address(s.program), address(account!.address), l, s.rpc)], s.rpc, s.chain);
        status(`${T[lang].sent}: ${sig}`);
        setTimeout(loadListings, 1500);
      } catch (e) {
        status(`${T[lang].failed}: ${(e as Error).message}`, true);
        b.disabled = false;
      }
    };
    row.appendChild(b);
    list.appendChild(row);
  }
}

async function closeStale() {
  const s = settings();
  if (!account) return;
  if (!s.program) return status(T[lang].missingProgram, true);
  try {
    const asset = address(($("asset") as HTMLInputElement).value.trim());
    const program = address(s.program);
    const listingAddr = await pda(program, ["listing", asset]);
    const rpc = createSolanaRpc(s.rpc);
    const info = await rpc.getAccountInfo(listingAddr, { encoding: "base64" }).send();
    if (!info.value || info.value.owner !== program) throw new Error("no Mercado listing for this item");
    const l = decodeListing(listingAddr, getBase64Encoder().encode(info.value.data[0]) as Uint8Array);
    const sig = await send([await closeInstruction("close_stale_listing", program, address(account.address), l, s.rpc)], s.rpc, s.chain);
    status(`${T[lang].sent}: ${sig}`);
  } catch (e) {
    status(`${T[lang].failed}: ${(e as Error).message}`, true);
  }
}

/** Every program account of one kind whose `owner` field (at `offset`) is this wallet. */
async function mine(disc: Uint8Array, offset: number, who: string) {
  const s = settings();
  return createSolanaRpc(s.rpc)
    .getProgramAccounts(address(s.program), {
      encoding: "base64",
      filters: [
        { memcmp: { offset: 0n, bytes: b58.decode(disc) as never, encoding: "base58" } },
        { memcmp: { offset: BigInt(offset), bytes: who as never, encoding: "base58" } },
      ],
    })
    .send()
    .then((r) => r.filter((x) => isAddress(x.pubkey)).map((x) => ({ pubkey: x.pubkey, data: getBase64Encoder().encode(x.account.data[0]) as Uint8Array })));
}

/** A row with a label and one action button; the action sends a transaction, then `after` reloads. */
function actionRow(list: HTMLElement, parts: Part[], label: string, action: () => Promise<Ix[]>, after: () => void, disabled = false) {
  const row = document.createElement("div");
  row.className = "row";
  row.append(el("div", ...parts));
  const b = document.createElement("button");
  b.textContent = label;
  b.disabled = disabled;
  b.onclick = async () => {
    const s = settings();
    try {
      b.disabled = true;
      const sig = await send(await action(), s.rpc, s.chain);
      status(`${T[lang].sent}: ${sig}`);
      setTimeout(after, 1500);
    } catch (e) {
      status(`${T[lang].failed}: ${(e as Error).message}`, true);
      b.disabled = false;
    }
  };
  row.appendChild(b);
  list.appendChild(row);
  return row;
}

const when = (secs: bigint) => new Date(Number(secs) * 1000).toLocaleString();

async function loadOffers() {
  const s = settings();
  const list = $("offers");
  if (!account || !s.program) return;
  list.textContent = T[lang].loading;
  try {
    const t = T[lang];
    const offers = (await mine(OFFER_DISC, OFFER_BIDDER, account.address)).map((r) => decodeOffer(r.pubkey, r.data));
    list.replaceChildren();
    if (!offers.length) { list.textContent = t.noOffers; return; }
    for (const o of offers) {
      const left = o.quantity - o.filled;
      const what = o.kind === 3 ? t.family : t.itemOffer;
      actionRow(list, [el("b", `${t.offer} #${o.id}`), ` · ${what}`, br(), `${sol(o.price)} ${t.each} · ${left} ${t.left} · ${t.held}: ${sol(o.price * BigInt(left))}`],
        t.cancelOffer, async () => [cancelOfferInstruction(address(s.program), o)], loadOffers);
    }
  } catch (e) {
    list.textContent = `${T[lang].failed}: ${(e as Error).message}`;
  }
}

/** The one exit a wallet can take on a swap offer right now, if any. */
function swapAction(sw: Swap, me: string | null): { label: string; releaseOnly: boolean } | null {
  const t = T[lang];
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (sw.state === SWAP_ENDED) {
    const n = Math.min(pendingItems(sw).length, RELEASE_BATCH);
    return n ? { label: t.release.replace("{n}", String(n)), releaseOnly: true } : null;
  }
  if (me === sw.offerer || me === sw.lister || now >= sw.expiresAt) return { label: t.endSwap, releaseOnly: false };
  return null;
}

function swapRow(list: HTMLElement, sw: Swap, reload: () => void) {
  const t = T[lang];
  const s = settings();
  const me = account?.address ?? null;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const side = me === sw.offerer ? t.youOffered : me === sw.lister ? t.offeredToYou : "";
  const state = sw.state === SWAP_ENDED ? t.ended : now >= sw.expiresAt ? t.expired : `${t.expires} ${when(sw.expiresAt)}`;
  const parts: Part[] = [el("b", `${t.swap} #${sw.id}`), `${side ? ` · ${side}` : ""} · ${state}`, br(),
    `${sw.items.length} ${t.items}${sw.solOnTop ? ` ${t.plus} ${sol(sw.solOnTop)}` : ""} → `, addr(sw.listedAsset), br(), addr(sw.address)];
  const a = swapAction(sw, me);
  const row = actionRow(list, parts, a?.label ?? t.notYet, async () => {
    // Read it again: the offer may have changed since the list was loaded (another batch went out, or it ended).
    const info = await createSolanaRpc(s.rpc).getAccountInfo(sw.address, { encoding: "base64" }).send();
    if (!info.value || info.value.owner !== s.program) throw new Error(t.notSwap);
    const fresh = decodeSwap(sw.address, getBase64Encoder().encode(info.value.data[0]) as Uint8Array);
    if (fresh.id !== sw.id) throw new Error(t.notSwap);
    const now2 = swapAction(fresh, me);
    if (!now2) throw new Error(t.notYet);
    return [...swapBudget(), await swapExitInstruction(s.rpc, address(s.program), address(me!), fresh, now2.releaseOnly)];
  }, reload, !a || !me);
  if (!a) {
    const note = document.createElement("small");
    note.textContent = sw.state === SWAP_ENDED ? "" : t.notYet;
    row.querySelector("button")!.replaceWith(note);
  }
  // An ended offer: each frozen item can also be handed back on its own, so one item that won't unfreeze never
  // holds up the others (stage 5 re-check).
  if (sw.state === SWAP_ENDED && me) {
    for (const i of pendingItems(sw)) {
      actionRow(list, [el("small", `\u00a0\u00a0#${i + 1} `, addr(sw.items[i]))], t.one, async () => {
        const info = await createSolanaRpc(s.rpc).getAccountInfo(sw.address, { encoding: "base64" }).send();
        if (!info.value || info.value.owner !== s.program) throw new Error(t.notSwap);
        const fresh = decodeSwap(sw.address, getBase64Encoder().encode(info.value.data[0]) as Uint8Array);
        if (fresh.id !== sw.id) throw new Error(t.notSwap);
        return [...swapBudget(), await swapExitInstruction(s.rpc, address(s.program), address(me), fresh, true, [i])];
      }, reload).classList.add("sub");
    }
  }
}

async function loadSwaps() {
  const s = settings();
  const list = $("swaps");
  if (!account || !s.program) return;
  list.textContent = T[lang].loading;
  try {
    const [made, got] = await Promise.all([mine(SWAP_DISC, SWAP_OFFERER, account.address), mine(SWAP_DISC, SWAP_LISTER, account.address)]);
    const seen = new Set<string>();
    const raw = [...made, ...got].filter((r) => !seen.has(r.pubkey) && seen.add(r.pubkey));
    // An offer that can't be decoded is shown as unavailable, never dropped (stage 5 re-check).
    const swaps: Swap[] = [];
    let unreadable = 0;
    for (const r of raw) { try { swaps.push(decodeSwap(r.pubkey, r.data)); } catch { unreadable++; } }
    list.replaceChildren();
    if (!swaps.length && !unreadable) { list.textContent = T[lang].noSwaps; return; }
    for (const sw of swaps) { try { swapRow(list, sw, loadSwaps); } catch { unreadable++; } }
    if (unreadable) { const p = document.createElement("p"); p.className = "bad"; p.textContent = T[lang].unreadable; list.appendChild(p); }
  } catch (e) {
    list.textContent = `${T[lang].failed}: ${(e as Error).message}`;
  }
}

async function findSwap() {
  const s = settings();
  const out = $("swap-found");
  if (!s.program) return status(T[lang].missingProgram, true);
  try {
    const addr = address(($("swap-addr") as HTMLInputElement).value.trim());
    const info = await createSolanaRpc(s.rpc).getAccountInfo(addr, { encoding: "base64" }).send();
    const d = info.value ? (getBase64Encoder().encode(info.value.data[0]) as Uint8Array) : null;
    if (!d || info.value!.owner !== s.program || !SWAP_DISC.every((b, i) => d[i] === b)) throw new Error(T[lang].notSwap);
    let sw: Swap;
    try { sw = decodeSwap(addr, d); } catch { throw new Error(T[lang].unreadable); }
    out.replaceChildren();
    swapRow(out, sw, () => void findSwap());
  } catch (e) {
    out.textContent = "";
    status(`${T[lang].failed}: ${(e as Error).message}`, true);
  }
}

function loadAll() {
  void loadListings();
  void loadOffers();
  void loadSwaps();
}

function render() {
  const t = T[lang];
  document.documentElement.lang = lang;
  $("title").textContent = t.title;
  $("intro").textContent = t.intro;
  $("l-net").textContent = t.network;
  $("l-rpc").textContent = t.rpc;
  $("l-program").textContent = t.program;
  $("h-yours").textContent = t.yours;
  $("h-stale").textContent = t.stale;
  $("stale-help").textContent = t.staleHelp;
  $("l-asset").textContent = t.asset;
  $("close").textContent = t.close;
  $("h-offers").textContent = t.offers;
  $("h-swaps").textContent = t.swaps;
  $("h-swapby").textContent = t.swapBy;
  $("swapby-help").textContent = t.swapByHelp;
  $("l-swap-addr").textContent = t.swapAddr;
  $("find").textContent = t.find;
  const box = $("wallets");
  box.replaceChildren();
  if (account) {
    box.textContent = `${t.connected}: ${account.address}`;
    return;
  }
  const ws = wallets();
  if (!ws.length) box.textContent = t.noWallet;
  for (const w of ws) {
    const b = document.createElement("button");
    b.textContent = `${t.connect}: ${w.name}`;
    b.onclick = async () => {
      try {
        await connect(w);
        render();
        loadAll();
      } catch (e) {
        status(`${t.failed}: ${(e as Error).message}`, true);
      }
    };
    box.appendChild(b);
  }
}

function setNetwork() {
  const n = NETWORKS[($("net") as HTMLSelectElement).value];
  ($("rpc") as HTMLInputElement).value = n.rpc;
  ($("program") as HTMLInputElement).value = n.program;
  loadAll();
}

window.addEventListener("DOMContentLoaded", () => {
  ($("net") as HTMLSelectElement).onchange = setNetwork;
  ($("lang") as HTMLSelectElement).value = lang;
  ($("lang") as HTMLSelectElement).onchange = (e) => {
    lang = (e.target as HTMLSelectElement).value as Lang;
    render();
    loadAll();
  };
  $("close").onclick = () => void closeStale();
  $("find").onclick = () => void findSwap();
  setNetwork();
  render();
  getWallets().on("register", render);
});
