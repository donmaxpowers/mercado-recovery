// Checks of what a wallet may return (run: npm test). Transactions are compiled by @solana/kit exactly as the page
// compiles them; "the wallet" then returns them changed in the ways below.
import assert from "node:assert/strict";
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getAddressDecoder,
  getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address,
} from "@solana/kit";
import { checkSigned, COMPUTE_BUDGET, type Ix } from "../src/check";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const payer = key(7), program = key(9), offer = key(11), config = key(13);
const blockhash = key(21);
const cancel: Ix = { programAddress: program, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 42]), accounts: [
  { address: payer, role: AccountRole.WRITABLE_SIGNER }, { address: offer, role: AccountRole.WRITABLE }, { address: config, role: AccountRole.READONLY },
] };
const budget = (op: number, value: bigint, bytes: number): Ix => {
  const data = new Uint8Array(1 + bytes); data[0] = op;
  const v = new DataView(data.buffer); if (bytes === 4) v.setUint32(1, Number(value), true); else v.setBigUint64(1, value, true);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data };
};
const price = (microLamports: bigint) => budget(3, microLamports, 8);
const limit = (units: bigint) => budget(2, units, 4);
const wire = (ixs: Ix[]) => {
  const m = pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(payer, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as never, lastValidBlockHeight: 1n }, x),
    (x) => appendTransactionMessageInstructions(ixs as never, x));
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(m)));
};
const ok = (name: string, returned: Uint8Array, built: Ix[]) => { checkSigned(returned, payer, blockhash, built); console.log("ok  ", name); };
const refused = (name: string, returned: Uint8Array, built: Ix[], why: RegExp) => {
  assert.throws(() => checkSigned(returned, payer, blockhash, built), why); console.log("ok  ", name, "(refused)");
};

// Listing cancels, stale closes and offer cancels are built with no compute-budget instruction.
ok("unchanged cancel", wire([cancel]), [cancel]);
ok("wallet adds a priority fee within the cap (final re-check, A)", wire([price(1_000n), cancel]), [cancel]);
ok("wallet adds a unit limit and a priority fee", wire([limit(50_000n), price(20_000n), cancel]), [cancel]);
refused("priority fee above 0.005 SOL", wire([price(30_000_000n), cancel]), [cancel], /priority fee/);
refused("two price instructions", wire([price(1n), price(2n), cancel]), [cancel], /compute budget/);
// Swap exits are built with their own budget (limit + heap); the wallet may still add a price.
const swapBuilt = [limit(1_000_000n), budget(1, 256n * 1024n, 4), cancel];
ok("swap exit with the wallet's priority fee", wire([...swapBuilt, price(1_000n)]), swapBuilt);
refused("swap exit priced above the cap (1,000,000 units at 6 lamports each)", wire([...swapBuilt, price(6_000_000n)]), swapBuilt, /priority fee/);
// Roles and accounts stay exact.
const asWritable = { ...cancel, accounts: cancel.accounts.map((a) => (a.address === config ? { ...a, role: AccountRole.WRITABLE } : a)) };
refused("an account made writable", wire([asWritable]), [cancel], /role of/);
refused("same, with a priority fee", wire([price(1_000n), asWritable]), [cancel], /role of/);
const extra = { ...cancel, accounts: [...cancel.accounts, { address: key(99), role: AccountRole.READONLY }] };
refused("an extra account", wire([extra]), [cancel], /other accounts/);
refused("other data", wire([{ ...cancel, data: Uint8Array.from([9]) }]), [cancel], /instruction data/);
console.log("all passed");
