import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const SR = 44100;
async function readWav(p){const b=await readFile(p);let o=12;while(o<b.length-8){const id=b.toString('ascii',o,o+4),sz=b.readUInt32LE(o+4);if(id==='data'){const n=sz/2,a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=b.readInt16LE(o+8+i*2)/32768;return a;}o+=8+sz;}throw new Error('no data');}

const s = await readWav(join(import.meta.dirname, 'passage-08step.wav'));
// Sentence boundaries from the render: 3.52 / 5.56 / 3.78
const lens = [3.52, 5.56, 3.78];
const words = [
  'In the beginning God created the heaven and the earth.'.split(/\s+/).length,
  'And the earth was without form, and void; and darkness was upon the face of the deep.'.split(/\s+/).length,
  'And God said, Let there be light: and there was light.'.split(/\s+/).length
];

console.log('per-sentence: where does speech actually end vs where word timings assume?\n');
let at = 0;
const THRESH = 0.005; // -46 dBFS
lens.forEach((len, i) => {
  const start = Math.round(at * SR), end = Math.round((at + len) * SR);
  // Walk back from the end to find the last sample above the noise floor.
  let speechEnd = end;
  for (let j = end - 1; j > start; j--) { if (Math.abs(s[j]) > THRESH) { speechEnd = j; break; } }
  // And forward from the start for leading silence.
  let speechStart = start;
  for (let j = start; j < end; j++) { if (Math.abs(s[j]) > THRESH) { speechStart = j; break; } }

  const trailing = (end - speechEnd) / SR;
  const leading = (speechStart - start) / SR;
  const speechDur = (speechEnd - speechStart) / SR;
  // Word timings are interpolated across the WHOLE buffer, including silence.
  const drift = (len - speechDur - leading) ;
  console.log(`  sentence ${i + 1}: buffer ${len.toFixed(2)}s | leading silence ${leading.toFixed(3)}s | speech ${speechDur.toFixed(2)}s | trailing silence ${trailing.toFixed(3)}s`);
  console.log(`    words spread over ${len.toFixed(2)}s but spoken in ${speechDur.toFixed(2)}s -> last word lags by ~${(len - speechDur - leading).toFixed(3)}s (${(100*(len-speechDur-leading)/len).toFixed(1)}% of the sentence)`);
  at += len;
});
