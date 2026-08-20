#!/usr/bin/env node
// tools/make-verifier.js — run LOCALLY. Prints the pinVerifier to paste into
// data/users.json for one user. The PIN never leaves your machine and is never
// sent to a server, committed, or logged.
//
//   PIN_PEPPER='<same value as the Vercel env var>' node tools/make-verifier.js rashed 4821
//
// PIN_SALT must match the constant in index.html (default below).

const crypto = require('crypto');

const [, , nickname, pin] = process.argv;
const PEPPER = process.env.PIN_PEPPER || '';
const PIN_SALT = process.env.PIN_SALT || 'theisilabs2026salt';

if (!nickname || !pin) {
  console.error('usage: PIN_PEPPER=... node tools/make-verifier.js <nickname> <pin>');
  process.exit(1);
}
if (PEPPER.length < 32) {
  console.error('PIN_PEPPER must be at least 32 chars. Generate one with:');
  console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

// Exactly what the browser sends:
const clientPinHash = crypto.createHash('sha256').update(pin + PIN_SALT).digest('hex');
// Exactly what api/_lib/pin.js stores:
const verifier = 'v2:' + crypto.createHmac('sha256', PEPPER)
  .update(String(nickname).toLowerCase().trim() + ':' + clientPinHash)
  .digest('hex');

console.log('\nPaste into that user\'s object in data/users.json:\n');
console.log(`  "pinVerifier": "${verifier}",`);
console.log(`  "needsPinSetup": false,\n`);
