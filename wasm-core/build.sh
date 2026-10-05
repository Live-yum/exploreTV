#!/bin/sh
set -eu
cd "$(dirname "$0")"
cargo build --locked --release --lib --target wasm32-unknown-unknown
mkdir -p dist
cp target/wasm32-unknown-unknown/release/exploretv_wld_core.wasm dist/exploretv_wld_core.wasm

node verify-build.mjs
