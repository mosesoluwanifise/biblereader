/**
 * Fine-grained look at the join between sentence 1 and sentence 2.
 *
 * Reported glitch lands on "earth" — the last word of sentence 1, i.e. exactly
 * at the seam. Two things to distinguish:
 *   - the trim cutting into the word itself (speech running past the predicted
 *     duration), which truncates audio mid-sound;
 *   - a step discontinuity across the join, which clicks.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const SR = 44100;

function readWav(path) {
  return readFile(path).then((buf) => {
    const channels = buf.readUInt16LE(22);
    const rate = buf.readUInt32LE(24);
    const bits = buf.readUInt16LE(34);
    // Walk chunks to find `data`; some writers insert LIST before it.
    let off = 12;
    while (off < buf.length - 8) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        const n = size / (bits / 8);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
        return { samples: out, rate, channels };
      }
      off += 8 + size;
    }
    throw new Error('no data chunk');
  });
}

function envelope(samples, from, to, windowMs = 5) {
  const win = Math.round((windowMs / 1000) * SR);
  const rows = [];
  for (let i = from; i + win < to; i += win) {
    let peak = 0;
    let sq = 0;
    for (let j = i; j < i + win; j += 1) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
      sq += samples[j] * samples[j];
    }
    rows.push({ t: i / SR, peak, rms: Math.sqrt(sq / win) });
  }
  return rows;
}

const file = process.argv[2] ?? join(HERE, 'fixed-joined.wav');
const { samples, rate } = await readWav(file);
console.log(`${file.split(/[\\/]/).pop()}  ${(samples.length / rate).toFixed(2)}s @ ${rate} Hz\n`);

// Sentence 1 was kept at 3.52s in the diagnostic run.
const SEAM = Number(process.argv[3] ?? 3.52);
const seamIdx = Math.round(SEAM * SR);

console.log(`seam at ${SEAM}s (sample ${seamIdx})`);
console.log(`  sample before : ${samples[seamIdx - 1].toFixed(6)}`);
console.log(`  sample after  : ${samples[seamIdx].toFixed(6)}`);
console.log(`  step across   : ${Math.abs(samples[seamIdx] - samples[seamIdx - 1]).toFixed(6)}`);

// Largest single-sample step anywhere near the join.
let worst = { at: 0, step: 0 };
for (let i = seamIdx - SR * 0.3; i < seamIdx + SR * 0.3; i += 1) {
  const step = Math.abs(samples[i] - samples[i - 1]);
  if (step > worst.step) worst = { at: i / SR, step };
}
console.log(`  worst step within +/-0.3s: ${worst.step.toFixed(6)} at ${worst.at.toFixed(4)}s`);

console.log('\n300ms before the seam (5ms windows) — does speech run into the cut?');
for (const r of envelope(samples, seamIdx - Math.round(0.3 * SR), seamIdx)) {
  const bar = '#'.repeat(Math.min(40, Math.round(r.peak * 120)));
  console.log(`  ${r.t.toFixed(3)}s peak ${r.peak.toFixed(4)} ${bar}`);
}

console.log('\n120ms after the seam:');
for (const r of envelope(samples, seamIdx, seamIdx + Math.round(0.12 * SR))) {
  const bar = '#'.repeat(Math.min(40, Math.round(r.peak * 120)));
  console.log(`  ${r.t.toFixed(3)}s peak ${r.peak.toFixed(4)} ${bar}`);
}
