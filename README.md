# MERCADO MIGORY recovery tool

A single HTML page for the day mercado.migory.com is down, broken or not trusted. It talks only to a Solana RPC
node and your own wallet (Phantom, Solflare or Backpack). It can do exactly two things, both of which the Mercado
program always allows, even while trading is paused:

- **Cancel your listing.** Your item is unfrozen and Mercado's permissions on it are removed.
- **Close a stale listing.** Anyone can do this for a listing whose item moved or lost Mercado's delegate. The
  item is unfrozen first, and the listing's deposit goes back to its seller.

The page builds each transaction from the program's published interface (`idl/mercado.json`, copied from the Mercado program). It
contains no other actions, loads no outside scripts, and its content security policy only allows connections
to RPC nodes.

## Using it

1. Download `mercado-recovery-<version>.html` from a published release, and check its SHA-256 against the
   release notes.
2. Open the file in a browser that has your wallet extension.
3. Pick the network. Mainnet's program address is filled in at launch.
4. Connect your wallet. Your Mercado listings appear, each with a **Cancel listing** button.

## Building and checking

```
npm ci
npm run build     # writes dist/mercado-recovery-<version>.html and its .sha256
```

The build is reproducible: the same source, lockfile and esbuild version give the same file and the same SHA-256.
Version 1.0.0 builds to `c48cc2f5759d0e7f947dc5972f831710709164be9246c2ecfe0d9e5e5e9075cf` (also in `dist/mercado-recovery-1.0.0.html.sha256`). The tag `v1.0.0` pins it.
Version 1.1.0 builds to `b8f6efcdd51564544881e63274012cf420c767d600eb4549986fe410535c6705`. It is for the Mercado program after the 23 November 2026 review fixes: a cancel names the listing it cancels, so a cancel signed for an older listing of the same item can never end a newer one. Use 1.0.0 only with a program from before that update.

## Tested

On a local Solana validator running the real Metaplex Core program (23 November 2026), the page was opened from
disk with a stand-in wallet signing as a test seller. It cancelled a listing with one signature. The item came
back unfrozen with both permissions returned to its owner. The only network requests went to the RPC node.

This repository is public on purpose (approved by MIGORY on 23 November 2026). Holders, and anyone checking on
their behalf, can read and rebuild the tool without access to the private website code.
