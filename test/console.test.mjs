// console.test.mjs — the pure URL/redirect helpers of cc-console.mjs.
// Importing cc-console.mjs is side-effect-free (main() runs only when invoked directly),
// so this asserts the token-in-hash contract without opening a browser or a socket.
// Run: node test/console.test.mjs   (exits non-zero on any failed assertion)
import assert from 'node:assert/strict';
import { buildConsoleUrl, redirectHtml } from '../src/cc-console.mjs';

// buildConsoleUrl: base + token live in the HASH, trailing slash trimmed, path is /console.
{
  const u = buildConsoleUrl('http://host:8787/', 'secret-tok');
  const [beforeHash, hash] = u.split('#');
  assert.equal(beforeHash, 'http://host:8787/console', 'path is <base>/console with the trailing slash trimmed');
  assert.ok(hash, 'there is a hash fragment');
  const params = new URLSearchParams(hash);
  assert.equal(params.get('base'), 'http://host:8787', 'base round-trips out of the hash');
  assert.equal(params.get('token'), 'secret-tok', 'token round-trips out of the hash');
  // The token must NEVER appear before the '#' (path/query) — the whole point is it stays client-side.
  assert.ok(!beforeHash.includes('secret-tok'), 'token is not in the path/query, only after the #');
}

// No token → no token param at all (so the page just prompts, rather than seeing token=).
{
  const u = buildConsoleUrl('http://host:8787', '');
  assert.equal(u, 'http://host:8787/console#base=http%3A%2F%2Fhost%3A8787', 'base-only hash when token is empty');
  assert.ok(!u.includes('token='), 'no token param when token is empty');
}

// redirectHtml: a CLIENT-SIDE redirect (so the hash survives), pointing at the same URL.
{
  const html = redirectHtml('http://host:8787', 'tok');
  assert.match(html, /location\.replace\(/, 'redirects client-side so the hash is preserved');
  assert.match(html, /#base=http%3A%2F%2Fhost%3A8787&token=tok/, 'the redirect target carries base+token in the hash');
  assert.match(html, /<!doctype html>/i, 'is a real html document');
}

console.log('console.test.mjs: all assertions passed');
