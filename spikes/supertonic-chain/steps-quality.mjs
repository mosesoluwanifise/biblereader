import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
ort.env.wasm.numThreads = 4; ort.env.logLevel = 'error';
const H = import.meta.dirname, B = join(H,'..','..','public','models','supertonic-3');
const SR=44100,HOP=512,DIM=24,CP=6,SPEED=1.05;
const TEXT='In the beginning God created the heaven and the earth.';
const idx = JSON.parse(await readFile(join(B,'onnx','unicode_indexer.json'),'utf8'));
const sj = JSON.parse(await readFile(join(B,'voice_styles','F1.json'),'utf8'));
const mk=(n)=>{const f=[];(function w(x){Array.isArray(x)?x.forEach(w):f.push(x);})(n.data);const d=[];let c=n.data;while(Array.isArray(c)){d.push(c.length);c=c[0];}return new ort.Tensor('float32',Float32Array.from(f),d);};
const sTtl=mk(sj.style_ttl), sDp=mk(sj.style_dp);
const L=(g)=>ort.InferenceSession.create(join(B,'onnx',`${g}.onnx`),{executionProviders:['wasm']});
const [dp,te,ve,voc]=await Promise.all([L('duration_predictor'),L('text_encoder'),L('vector_estimator'),L('vocoder')]);
const ids=[...`<en>${TEXT}</en>`].map(c=>{const p=c.codePointAt(0);return p<idx.length?idx[p]:0;});
const N=ids.length;
const ti=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,N]);
const tm=new ort.Tensor('float32',new Float32Array(N).fill(1),[1,1,N]);
const {duration}=await dp.run({text_ids:ti,style_dp:sDp,text_mask:tm});
const target=Math.max(1,Math.round((Number(duration.data[0])/SPEED)*SR));
const Lc=Math.max(1,Math.ceil(target/(HOP*CP))), CH=DIM*CP;
const {text_emb}=await te.run({text_ids:ti,style_ttl:sTtl,text_mask:tm});
const lm=new ort.Tensor('float32',new Float32Array(Lc).fill(1),[1,1,Lc]);
// One shared noise draw so step count is the only variable.
const seed=Float32Array.from({length:CH*Lc},()=>{const u=Math.random()||1e-9;return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*Math.random());});
for (const steps of [4,8,16]) {
  let lat=new ort.Tensor('float32',Float32Array.from(seed),[1,CH,Lc]);
  const t0=Date.now();
  for(let s=0;s<steps;s++){
    const o=await ve.run({noisy_latent:lat,text_emb,style_ttl:sTtl,latent_mask:lm,text_mask:tm,
      current_step:new ort.Tensor('float32',Float32Array.from([s]),[1]),
      total_step:new ort.Tensor('float32',Float32Array.from([steps]),[1])});
    lat=o.denoised_latent;
  }
  const {wav_tts}=await voc.run({latent:lat});
  const a=wav_tts.data.subarray(0,Math.min(wav_tts.data.length,target));
  const el=(Date.now()-t0)/1000;
  let peak=0,sq=0; for(let i=0;i<a.length;i++){const v=Math.abs(a[i]);if(v>peak)peak=v;sq+=a[i]*a[i];}
  const pcm=Buffer.alloc(a.length*2);
  for(let i=0;i<a.length;i++)pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(a[i]*32767))),i*2);
  const h=Buffer.alloc(44);
  h.write('RIFF',0);h.writeUInt32LE(36+pcm.length,4);h.write('WAVE',8);h.write('fmt ',12);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(SR,24);
  h.writeUInt32LE(SR*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
  await writeFile(join(H,`steps-${String(steps).padStart(2,'0')}.wav`),Buffer.concat([h,pcm]));
  console.log(`  ${String(steps).padStart(2)} steps  ${el.toFixed(1)}s wall  ${(a.length/SR/el).toFixed(2)}x realtime  peak ${peak.toFixed(3)}  rms ${Math.sqrt(sq/a.length).toFixed(4)}`);
}
