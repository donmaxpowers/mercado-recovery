# MERCADO MIGORY recovery tool

A single HTML page for the day mercado.migory.com is down, broken or not trusted. It talks only to a Solana RPC
node and your own wallet (Phantom, Solflare or Backpack). It can only take things back out of Mercado, using exits
the Mercado program always allows, even while trading is paused:

- **Cancel your listing.** Your item is unfrozen and Mercado's permissions on it are removed.
- **Close a stale listing.** Anyone can do this for a listing whose item moved or lost Mercado's delegate. The
  item is unfrozen first, and the listing's deposit goes back to its seller.
- **Cancel your offer** (item offers and family offers). The SOL still held in it goes back to you.
- **End a swap offer.** Its offerer can end it at any time, the owner of the listed item can decline it, and
  anyone can end it once it has expired. The SOL on top, the fee held and the deposit go back to the offerer. This
  step hands back no items, so no single item can block the refund.
- **Hand back a swap offer's items.** Once a swap offer has ended, anyone can unfreeze its items and return
  Mercado's permissions on them, three items per transaction, until all are back.

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
Version 1.2.0 builds to `7cec54774e6a9167a40cb5e16733b11d14dbc9058a84dea99f3c1c0954705a30`. It adds offers and swap offers, and is for the
Mercado program after the stage 5 review fixes (24 November 2026): ending a swap offer or handing back its items names the
offer (`swap_id`), so a step signed for one offer can never act on a replacement at the same address.

## Tested

On a local Solana validator running the real Metaplex Core program (23 November 2026), the page was opened from
disk with a stand-in wallet signing as a test seller. It cancelled a listing with one signature. The item came
back unfrozen with both permissions returned to its owner. The only network requests went to the RPC node.

This repository is public on purpose (approved by MIGORY on 23 November 2026). Holders, and anyone checking on
their behalf, can read and rebuild the tool without access to the private website code.
