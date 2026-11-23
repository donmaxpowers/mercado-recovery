/**
 * MERCADO MIGORY recovery tool.
 *
 * A single page that works without mercado.migory.com: it talks only to a Solana RPC node and the holder's wallet.
 * It can do exactly two things, both exits the Mercado program always allows:
 *   - cancel_listing: the seller takes their own listing down; the item is thawed and released.
 *   - close_stale_listing: anyone closes a listing whose item moved or lost Mercado's delegate; the item is
 *     thawed first and the listing's rent goes back to its seller.
 * Every transaction is built here from the program's published interface (idl/mercado.json): the instruction's
 * discriminator and account order come from that file, and nothing else is added.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
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
const NETWORKS: Record<string, { rpc: string; chain: string; program: string }> = {
  mainnet: { rpc: "https://api.mainnet-beta.solana.com", chain: "solana:mainnet", program: "" }, // filled in at mainnet launch
  devnet: { rpc: "https://api.devnet.solana.com", chain: "solana:devnet", program: idl.address },
  localnet: { rpc: "http://127.0.0.1:8899", chain: "solana:localnet", program: idl.address },
};

// ------------------------------------------------------------------ text (English / Spanish)
const T = {
  en: {
    title: "MERCADO MIGORY recovery tool",
    intro: "Use this if mercado.migory.com is down or you don't trust it. It talks only to Solana and your wallet, and it can only cancel listings or close stale ones.",
    network: "Network", rpc: "RPC address", program: "Mercado program", connect: "Connect wallet", noWallet: "No Phantom, Solflare or Backpack wallet found in this browser.",
    yours: "Your listings", none: "No Mercado listings for this wallet.", cancel: "Cancel listing", price: "Price", id: "Listing",
    stale: "Close a stale listing", staleHelp: "For a listing whose item moved or lost Mercado's delegate. Anyone can do this; the item is thawed and the rent goes to its seller.",
    asset: "Item address", close: "Close it", sent: "Sent", failed: "Failed", loading: "Loading…", connected: "Connected",
    missingProgram: "Set the Mercado program address for this network first.",
  },
  es: {
    title: "Herramienta de recuperación de MERCADO MIGORY",
    intro: "Úsala si mercado.migory.com no funciona o no confías en él. Solo habla con Solana y tu wallet, y solo puede cancelar listados o cerrar listados caducados.",
    network: "Red", rpc: "Dirección RPC", program: "Programa de Mercado", connect: "Conectar wallet", noWallet: "No se encontró Phantom, Solflare ni Backpack en este navegador.",
    yours: "Tus listados", none: "Esta wallet no tiene listados en Mercado.", cancel: "Cancelar listado", price: "Precio", id: "Listado",
    stale: "Cerrar un listado caducado", staleHelp: "Para un listado cuyo artículo se movió o perdió el delegado de Mercado. Cualquiera puede hacerlo; el artículo se descongela y la renta va a su vendedor.",
    asset: "Dirección del artículo", close: "Cerrarlo", sent: "Enviado", failed: "Falló", loading: "Cargando…", connected: "Conectada",
    missingProgram: "Primero indica la dirección del programa de Mercado para esta red.",
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

/** cancel_listing or close_stale_listing, with accounts in the IDL's order and roles. */
async function closeInstruction(name: "cancel_listing" | "close_stale_listing", program: Address, signer: Address, l: Listing) {
  const def = ix(name);
  const known: Record<string, Address> = {
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
  };
  const accounts = def.accounts.map((a) => {
    const addr = known[a.name];
    if (!addr) throw new Error(`unknown account ${a.name} in IDL`);
    const w = "writable" in a && a.writable;
    const s = "signer" in a && a.signer;
    const role = w && s ? AccountRole.WRITABLE_SIGNER : w ? AccountRole.WRITABLE : s ? AccountRole.READONLY_SIGNER : AccountRole.READONLY;
    return { address: addr, role };
  });
  return { programAddress: program, accounts, data: new Uint8Array(def.discriminator) };
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

async function send(instruction: Awaited<ReturnType<typeof closeInstruction>>, rpcUrl: string, chain: string): Promise<string> {
  if (!wallet || !account) throw new Error("connect a wallet first");
  const rpc = createSolanaRpc(rpcUrl);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(account!.address), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(instruction, m),
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
        const sig = await send(await closeInstruction("cancel_listing", address(s.program), address(account!.address), l), s.rpc, s.chain);
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
    const sig = await send(await closeInstruction("close_stale_listing", program, address(account.address), l), s.rpc, s.chain);
    status(`${T[lang].sent}: ${sig}`);
  } catch (e) {
    status(`${T[lang].failed}: ${(e as Error).message}`, true);
  }
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
        await loadListings();
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
  void loadListings();
}

window.addEventListener("DOMContentLoaded", () => {
  ($("net") as HTMLSelectElement).onchange = setNetwork;
  ($("lang") as HTMLSelectElement).value = lang;
  ($("lang") as HTMLSelectElement).onchange = (e) => {
    lang = (e.target as HTMLSelectElement).value as Lang;
    render();
  };
  $("close").onclick = () => void closeStale();
  setNetwork();
  render();
  getWallets().on("register", render);
});
