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
 * discriminator and account order come from that file, and nothing else is added.
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
    asset: "Item address", close: "Close it", sent: "Sent", failed: "Failed", loading: "Loading…", connected: "Connected",
    missingProgram: "Set the Mercado program address for this network first.",
    offers: "Your offers", noOffers: "No open offers from this wallet.", cancelOffer: "Cancel offer, get the SOL back", offer: "Offer", family: "family offer", itemOffer: "item offer", held: "Held", each: "each", left: "left",
    swaps: "Your swap offers", noSwaps: "No swap offers made by or to this wallet.", swap: "Swap offer", youOffered: "You offered", offeredToYou: "Offered to you",
    items: "items", plus: "plus", expired: "expired", expires: "expires", ended: "ended, items waiting", endSwap: "End it, return the SOL", release: "Hand back the next {n}",
    swapBy: "Finish a swap offer", swapByHelp: "Anyone can end a swap offer once it has expired, and anyone can hand back the items of an ended one. Paste the swap offer's address (it is on its offer page).",
    swapAddr: "Swap offer address", find: "Find it", notSwap: "No Mercado swap offer at this address.", notYet: "Only its offerer or lister can end it before it expires.",
  },
  es: {
    title: "Herramienta de recuperación de MERCADO MIGORY",
    intro: "Úsala si mercado.migory.com no funciona o no confías en él. Solo habla con Solana y tu wallet, y solo puede cancelar listados o cerrar listados caducados.",
    network: "Red", rpc: "Dirección RPC", program: "Programa de Mercado", connect: "Conectar wallet", noWallet: "No se encontró Phantom, Solflare ni Backpack en este navegador.",
    yours: "Tus listados", none: "Esta wallet no tiene listados en Mercado.", cancel: "Cancelar listado", price: "Precio", id: "Listado",
    stale: "Cerrar un listado caducado", staleHelp: "Para un listado cuyo artículo se movió o perdió el delegado de Mercado. Cualquiera puede hacerlo; el artículo se descongela y la renta va a su vendedor.",
    asset: "Dirección del artículo", close: "Cerrarlo", sent: "Enviado", failed: "Falló", loading: "Cargando…", connected: "Conectada",
    missingProgram: "Primero indica la dirección del programa de Mercado para esta red.",
    offers: "Tus ofertas", noOffers: "Esta wallet no tiene ofertas abiertas.", cancelOffer: "Cancelar oferta y recuperar el SOL", offer: "Oferta", family: "oferta por familia", itemOffer: "oferta por artículo", held: "Retenido", each: "cada uno", left: "restantes",
    swaps: "Tus ofertas de intercambio", noSwaps: "No hay ofertas de intercambio hechas por o para esta wallet.", swap: "Oferta de intercambio", youOffered: "Ofreciste", offeredToYou: "Te ofrecieron",
    items: "artículos", plus: "más", expired: "vencida", expires: "vence", ended: "terminada, artículos por devolver", endSwap: "Terminarla y devolver el SOL", release: "Devolver los siguientes {n}",
    swapBy: "Terminar una oferta de intercambio", swapByHelp: "Cualquiera puede terminar una oferta de intercambio vencida, y cualquiera puede devolver los artículos de una ya terminada. Pega la dirección de la oferta (está en su página).",
    swapAddr: "Dirección de la oferta de intercambio", find: "Buscarla", notSwap: "No hay una oferta de intercambio de Mercado en esta dirección.", notYet: "Antes de que venza, solo quien la hizo o quien listó el artículo puede terminarla.",
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
async function closeInstruction(name: "cancel_listing" | "close_stale_listing", program: Address, signer: Address, l: Listing) {
  return build(name, program, {
    signer,
    seller: l.seller,
    config: await pda(program, ["config"]),
    authority: await pda(program, ["authority"]),
    asset: l.asset,
    collection: l.collection,
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

/** A Core asset's collection (base fields: key 1, owner, update authority kind 2 = Collection, then its address), or
 *  null if the item can't be read (burned): the program then just closes its lock period and needs no collection. */
async function collectionOf(rpcUrl: string, asset: Address): Promise<Address | null> {
  const info = await createSolanaRpc(rpcUrl).getAccountInfo(asset, { encoding: "base64" }).send();
  const d = info.value ? (getBase64Encoder().encode(info.value.data[0]) as Uint8Array) : null;
  if (!d || d[0] !== 1) return null;
  if (d[33] !== 2) throw new Error(`can't read the collection of ${asset}`);
  return dec.decode(d.subarray(34, 66));
}

/**
 * end_swap with no items (the SOL goes back to the offerer; nothing an item does can stop it), or
 * release_swap_items for the next few items of an ended offer: their collections (each once), then (asset, lock) pairs.
 */
async function swapExitInstruction(rpcUrl: string, program: Address, signer: Address, s: Swap, releaseOnly: boolean): Promise<Ix> {
  const idx = releaseOnly ? pendingItems(s).slice(0, RELEASE_BATCH) : [];
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
  return getWallets().get().filter((w) => SUPPORTED.includes(w.name) && "standard:connect" in w.features && "solana:signAndSendTransaction" in w.features);
}

async function connect(w: StdWallet) {
  const f = w.features["standard:connect"] as { connect: () => Promise<{ accounts: { address: string }[] }> };
  const r = await f.connect();
  wallet = w;
  account = r.accounts[0] ?? null;
}

async function send(instructions: Ix[], rpcUrl: string, chain: string): Promise<string> {
  if (!wallet || !account) throw new Error("connect a wallet first");
  const rpc = createSolanaRpc(rpcUrl);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(account!.address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const bytes = getTransactionEncoder().encode(compileTransaction(msg)) as Uint8Array;
  const f = wallet.features["solana:signAndSendTransaction"] as {
    signAndSendTransaction: (i: { account: unknown; transaction: Uint8Array; chain: string }) => Promise<{ signature: Uint8Array }[]>;
  };
  const acct = wallet.accounts.find((a) => a.address === account!.address);
  const [{ signature }] = await f.signAndSendTransaction({ account: acct, transaction: bytes, chain });
  return b58.decode(signature);
}

// ------------------------------------------------------------------ page
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sol = (l: bigint) => (Number(l) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " SOL";
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

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
  const items = res.map((r) => decodeListing(r.pubkey, getBase64Encoder().encode(r.account.data[0]) as Uint8Array));
  list.innerHTML = "";
  if (!items.length) {
    list.textContent = T[lang].none;
    return;
  }
  for (const l of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div><b>${T[lang].id} #${l.id}</b><br><code title="${l.asset}">${short(l.asset)}</code> · ${T[lang].price}: ${sol(l.price)}</div>`;
    const b = document.createElement("button");
    b.textContent = T[lang].cancel;
    b.onclick = async () => {
      try {
        b.disabled = true;
        const sig = await send([await closeInstruction("cancel_listing", address(s.program), address(account!.address), l)], s.rpc, s.chain);
        status(`${T[lang].sent}: ${sig}`);
        setTimeout(loadListings, 2500);
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
    if (!info.value) throw new Error("no Mercado listing for this item");
    const l = decodeListing(listingAddr, getBase64Encoder().encode(info.value.data[0]) as Uint8Array);
    const sig = await send([await closeInstruction("close_stale_listing", program, address(account.address), l)], s.rpc, s.chain);
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
    .then((r) => r.map((x) => ({ pubkey: x.pubkey, data: getBase64Encoder().encode(x.account.data[0]) as Uint8Array })));
}

/** A row with a label and one action button; the action sends a transaction, then `after` reloads. */
function actionRow(list: HTMLElement, html: string, label: string, action: () => Promise<Ix[]>, after: () => void, disabled = false) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<div>${html}</div>`;
  const b = document.createElement("button");
  b.textContent = label;
  b.disabled = disabled;
  b.onclick = async () => {
    const s = settings();
    try {
      b.disabled = true;
      const sig = await send(await action(), s.rpc, s.chain);
      status(`${T[lang].sent}: ${sig}`);
      setTimeout(after, 2500);
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
    list.innerHTML = "";
    if (!offers.length) { list.textContent = t.noOffers; return; }
    for (const o of offers) {
      const left = o.quantity - o.filled;
      const what = o.kind === 3 ? t.family : t.itemOffer;
      actionRow(list, `<b>${t.offer} #${o.id}</b> · ${what}<br>${sol(o.price)} ${t.each} · ${left} ${t.left} · ${t.held}: ${sol(o.price * BigInt(left))}`,
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
  const html = `<b>${t.swap} #${sw.id}</b>${side ? ` · ${side}` : ""} · ${state}<br>${sw.items.length} ${t.items}` +
    (sw.solOnTop ? ` ${t.plus} ${sol(sw.solOnTop)}` : "") + ` → <code title="${sw.listedAsset}">${short(sw.listedAsset)}</code>` +
    `<br><code title="${sw.address}">${short(sw.address)}</code>`;
  const a = swapAction(sw, me);
  const row = actionRow(list, html, a?.label ?? t.notYet, async () => {
    // Read it again: the offer may have changed since the list was loaded (another batch went out, or it ended).
    const info = await createSolanaRpc(s.rpc).getAccountInfo(sw.address, { encoding: "base64" }).send();
    if (!info.value) throw new Error(t.notSwap);
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
}

async function loadSwaps() {
  const s = settings();
  const list = $("swaps");
  if (!account || !s.program) return;
  list.textContent = T[lang].loading;
  try {
    const [made, got] = await Promise.all([mine(SWAP_DISC, SWAP_OFFERER, account.address), mine(SWAP_DISC, SWAP_LISTER, account.address)]);
    const seen = new Set<string>();
    const swaps = [...made, ...got].filter((r) => !seen.has(r.pubkey) && seen.add(r.pubkey)).map((r) => decodeSwap(r.pubkey, r.data));
    list.innerHTML = "";
    if (!swaps.length) { list.textContent = T[lang].noSwaps; return; }
    for (const sw of swaps) swapRow(list, sw, loadSwaps);
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
    out.innerHTML = "";
    swapRow(out, decodeSwap(addr, d), () => void findSwap());
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
  box.innerHTML = "";
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
