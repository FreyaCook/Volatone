#!/usr/bin/env bash
# Creates a devnet-only wallet for Volatone. The secret key stays in .keys/ (git-ignored).
set -e
mkdir -p .keys
if [ -f .keys/volatone-wallet.json ]; then
  echo "Wallet already exists. Public address:"
else
  solana-keygen new --outfile .keys/volatone-wallet.json --no-bip39-passphrase --silent
  echo "Wallet created. Public address:"
fi
solana-keygen pubkey .keys/volatone-wallet.json
echo
echo "Only share the PUBLIC address above (e.g. with the faucet). Never share the .keys folder."
