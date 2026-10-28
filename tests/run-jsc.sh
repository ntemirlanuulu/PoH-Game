#!/bin/sh
# Runs tests/balance.js without Node, using macOS's built-in JavaScriptCore shell.
cd "$(dirname "$0")/.." || exit 1
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
"$JSC" -e 'var module = { exports: {} };' game.js -e 'globalThis.TAYAK_SIM = module.exports;' tests/balance.js
