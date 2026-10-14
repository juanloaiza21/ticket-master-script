#!/usr/bin/env sh
# Rebuild the browser version in docs/pkg from the Rust sources.
#
# One-time setup:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version "$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep version | cut -d'"' -f2)" --locked
# (the CLI version must match the wasm-bindgen crate version in Cargo.lock)
set -eu
cd "$(dirname "$0")/.."

cargo build --lib --target wasm32-unknown-unknown --release --no-default-features --features web
wasm-bindgen --target web --no-typescript --out-dir docs/pkg target/wasm32-unknown-unknown/release/ticketwatch.wasm
touch docs/.nojekyll
echo "Built docs/pkg. Preview with: python3 -m http.server -d docs 8000"
