import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const SR = 44100;
async function readWav(p) {
  const buf = await readFile(p);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = size / 2, out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size;
  }
  throw new Error('no data');
}
const file = process.argv[2];
const s = await readWav(join(import.meta.dirname, file));
console.log(`${file}  ${(s.length / SR).toFixed(2)}s`);

// Largest sample-to-sample jumps across the whole file.
const steps = [];
for (let i = 1; i < s.length; i++) steps.push({ i, d: Math.abs(s[i] - s[i - 1]) });
steps.sort((a, b) => b.d - a.d);
console.log('\ntop sample-step discontinuities:');
const seen = [];
for (const st of steps) {
  if (seen.some((x) => Math.abs(x - st.i) < SR * 0.05)) continue;
  seen.push(st.i);
  console.log(`  ${(st.i / SR).toFixed(3)}s  step ${st.d.toFixed(4)}  (|before| ${Math.abs(s[st.i-1]).toFixed(4)} -> |after| ${Math.abs(s[st.i]).toFixed(4)})`);
  if (seen.length >= 8) break;
}

// Peak envelope over the first sentence so we can see word shapes.
console.log('\nenvelope 2.2s-3.3s (10ms windows) — the region around "earth":');
const win = Math.round(0.01 * SR);
for (let i = Math.round(2.2 * SR); i + win < Math.round(3.3 * SR); i += win) {
  let peak = 0;
  for (let j = i; j < i + win; j++) peak = Math.max(peak, Math.abs(s[j]));
  console.log(`  ${(i / SR).toFixed(2)}s ${peak.toFixed(4)} ${'#'.repeat(Math.min(46, Math.round(peak * 130)))}`);
}
