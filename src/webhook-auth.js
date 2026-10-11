export const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const purpose = new TextEncoder().encode('sift:telegram-webhook:v1');

// Derive a separate header credential without copying a third secret between
// Codespaces and Cloudflare. Both runtimes must have the same bot token.
async function keyFor(token) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function webhookSecret(token) {
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(token), purpose));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function isAuthenticated(token, header) {
  if (typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header)) return false;
  const bytes = Uint8Array.from(header.match(/../g), (pair) => parseInt(pair, 16));
  // Delegate comparison to Web Crypto rather than comparing secret strings.
  return crypto.subtle.verify('HMAC', await keyFor(token), bytes, purpose);
}
