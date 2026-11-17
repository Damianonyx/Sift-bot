#!/usr/bin/env node
// npm run preflight — checks that Sift is ready for private testing.
// The Node.js check comes first: older versions cannot load node:sqlite,
// so importing the bot's modules would fail with a confusing error.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.log(`✗ Node.js v${process.versions.node} — Sift needs Node 24 (it uses node:sqlite). See docs/hosting.md, step 3.`);
  process.exit(1);
}
const { runPreflight } = await import('../src/preflight.js');
const { failures } = await runPreflight({ env: process.env });
process.exit(failures > 0 ? 1 : 0);
