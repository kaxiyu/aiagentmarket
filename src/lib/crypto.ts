// WebCrypto utilities for ID generation, API key hashing, and password verification

export function generateId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `ak_live_${hex}`;
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function hashPassword(password: string, saltHex?: string, iterations: number = 100000): Promise<string> {
  let saltBytes: Uint8Array;
  
  if (saltHex) {
    const match = saltHex.match(/.{1,2}/g);
    saltBytes = match ? new Uint8Array(match.map(byte => parseInt(byte, 16))) : new Uint8Array(16);
  } else {
    saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
  }

  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );

  const derivedArray = Array.from(new Uint8Array(derivedBits));
  const derivedHex = derivedArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const actualSaltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  return `pbkdf2$${iterations}$${actualSaltHex}$${derivedHex}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const cleanHash = storedHash ? storedHash.trim() : '';
    const cleanPassword = password ? password.trim() : '';
    const parts = cleanHash.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
      return { valid: false, error: `invalid parts: ${parts.length}` };
    }
    const [, iterStr, saltHex] = parts;
    const iterations = parseInt(iterStr, 10) || 10000;
    const computedHash = await hashPassword(cleanPassword, saltHex, iterations);
    return { valid: timingSafeEqual(computedHash, cleanHash) };
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  }
}
