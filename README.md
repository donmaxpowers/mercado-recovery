# MERCADO MIGORY recovery tool

A single HTML page for the day mercado.migory.com is down, broken or not trusted. It talks only to a Solana RPC
node and your own wallet (Phantom, Solflare or Backpack, any version that can sign without sending). It can only take things back out of Mercado, using exits
the Mercado program always allows, even while trading is paused:

- **Cancel your listing.** Your item is unfrozen and Mercado's permissions on it are removed.
- **Close a stale listing.** Anyone can do this for a listing whose item moved or lost Mercado's delegate. The
  item is unfrozen first, and the listing's deposit goes back to its seller.
- **Cancel your offer** (item offers and family offers). The SOL still held in it goes back to you.
- **End a swap offer.** Its offerer can end it at any time, the owner of the listed item can decline it, and
  anyone can end it once it has expired. The SOL on top, the fee held and the deposit go back to the offerer. This
  step hands back no items, so no single item can block the refund.
- **Hand back a swap offer's items.** Once a swap offer has ended, anyone can unfreeze its items and return
  Mercado's permissions on them, three per transaction or one item at a time, so one item that won't unfreeze never
  holds up the others. Each item is named with its collection as it is now, so an item moved to another collection,
  or out of every collection, still comes back.

Your wallet only signs. Before anything is sent, the page reads back what the wallet signed and checks it is exactly
the transaction it built (your wallet pays, the same Mercado instruction with the same accounts and data, nothing
else but compute limits, any priority fee at most 0.005 SOL), and that the RPC address really is the network you
chose. Then it sends the transaction itself and says "Confirmed" only once the network confirms it.

The page builds each transaction from the program's published interface (`idl/mercado.json`, copied from the Mercado program). It
contains no other actions, loads no outside scripts, and its content security policy only allows connections
to RPC nodes.

## Using it

1. Download `mercado-recovery-<version>.html` from a published release, and check its SHA-256 against the
   release notes.
2. Open the file in a browser that has your wallet extension.
3. Pick the network. Mainnet's program address is filled in at launch.
4. Connect your wallet. Your listings, your offers and the swap offers made by or to you appear, each with the
   step you can take now.
5. To finish someone else's expired or ended swap offer, paste its address under **Finish a swap offer**.

## Building and checking

```
npm ci
npm run build     # writes dist/mercado-recovery-<version>.html and its .sha256
```

The build is reproducible: the same source, lockfile and esbuild version give the same file and the same SHA-256.
Version 1.0.0 builds to `c48cc2f5759d0e7f947dc5972f831710709164be9246c2ecfe0d9e5e5e9075cf` (also in `dist/mercado-recovery-1.0.0.html.sha256`). The tag `v1.0.0` pins it.
Version 1.1.0 builds to `b8f6efcdd51564544881e63274012cf420c767d600eb4549986fe410535c6705`. It is for the Mercado program after the 23 November 2026 review fixes: a cancel names the listing it cancels, so a cancel signed for an older listing of the same item can never end a newer one. Use 1.0.0 only with a program from before that update.
Version 1.2.0 builds to `77a39c535a0820cff1e68c890548842ff5a72b9ab8744f90d24400e9eb8e85eb`. It adds offers and swap offers, and is for the
Mercado program after the stage 5 review fixes (24 November 2026): ending a swap offer or handing back its items names the
offer (`swap_id`), so a step signed for one offer can never act on a replacement at the same address.
Version 1.3.0 builds to `b5a5a44cd7022ba94366bbebb9799ea7a17b87d64f1a75f3409e5a24ec9cb447`. It is for the Mercado program after the
stage 5 re-check fixes (24 November 2026): sign-only wallets with the check above, items handed back one at a time
if needed, and each item named with its current collection (or none). Tested on devnet the same day: a wallet that
returned a different transaction was refused with nothing sent; an offer cancelled, a swap offer ended and its two
items handed back one by one, another wallet finishing an expired swap offer by its address, and a listing
cancelled, every amount exact (`program/evidence/devnet-recovery-1.3.0.json` in the Mercado program repository).

## Tested

On a local Solana validator running the real Metaplex Core program (23 November 2026), the page was opened from
disk with a stand-in wallet signing as a test seller. It cancelled a listing with one signature. The item came
back unfrozen with both permissions returned to its owner. The only network requests went to the RPC node.

Version 1.2.0 was tested on devnet on 24 November 2026, against the upgraded Mercado program, opened from disk with
stand-in wallets holding throwaway test keys. It cancelled an item offer (the held SOL and the deposit came back
exactly); ended a 4-item swap offer, returning the SOL on top and the $1 first, then handed its items back 3 and 1;
and, from an unrelated wallet, found an expired swap offer by its address, ended it and handed its item back. Every
amount was exact, every item came back unfrozen with both permissions returned to its owner, and the only network
requests went to the devnet RPC node. The report is `program/evidence/devnet-recovery-1.2.0.json` in the Mercado
program repository.

This repository is public on purpose (approved by MIGORY on 23 November 2026). Holders, and anyone checking on
their behalf, can read and rebuild the tool without access to the private website code.
