#!/usr/bin/env node

/**
 * Utility to generate secure PBKDF2 password hashes for Cloudflare Workers secrets
 * Usage:
 *   node scripts/hash-password.js "YourSecurePassword"
 */

import crypto from 'node:crypto';

async function generateHash(password) {
  if (!password) {
    console.error('Error: Password argument required.');
    console.error('Usage: node scripts/hash-password.js <password>');
    process.exit(1);
  }

  const iterations = 600000;
  const salt = crypto.randomBytes(16);

  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    iterations,
    32,
    'sha256'
  );

  const saltHex = salt.toString('hex');
  const hashHex = derivedKey.toString('hex');
  const fullHash = `pbkdf2$${iterations}$${saltHex}$${hashHex}`;

  console.log('\n=== SECURE ADMIN PASSWORD HASH ===\n');
  console.log(fullHash);
  console.log('\nSet this secret in Cloudflare using:');
  console.log(`npx wrangler secret put ADMIN_PASSWORD_HASH\n`);
}

const password = process.argv[2];
generateHash(password);
