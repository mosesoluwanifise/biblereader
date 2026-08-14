import ort from 'onnxruntime-web';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
ort.env.wasm.numThreads = 1; ort.env.logLevel = 'error';
const B = 'C:/Users/moses/Documents/Apps/Bible Reading App/public/models/supertonic-3';
const SR=44100,HOP=512,DIM=24,CP=6;
const idx = JSON.parse(await readFile(join(B,'onnx','unicode_indexer.json'),'utf8'));
const sj = JSON.parse(await readFile(join(B,'voice_styles','F1.json'),'utf8'));
const mk=(nd)=>{const f=[];(function w(x){Array.isArray(x)?x.forEach(w):f.push(x);})(nd.data);const d=[];let c=nd.data;while(Array.isArray(c)){d.push(c.length);c=c[0];}return new ort.Tensor('float32',Float32Array.from(f),d);};
const sTtl=mk(sj.style_ttl), sDp=mk(sj.style_dp);
for (const prec of ['.fp32','']) {
  const L=(g)=>ort.InferenceSession.create(join(B,'onnx',`${g}${prec}.onnx`),{executionProviders:['wasm']});
  const [dp,te,ve,voc]=await Promise.all([L('duration_predictor'),L('text_encoder'),L('vector_estimator'),L('vocoder')]);
  const T='In the beginning God created the heaven and the earth.';
  const ids=[...T].map(c=>{const p=c.codePointAt(0);return p<idx.length?idx[p]:0;});
  const N=ids.length;
  const ti=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,N]);
  const tm=new ort.Tensor('float32',new Float32Array(N).fill(1),[1,1,N]);
  const {duration}=await dp.run({text_ids:ti,style_dp:sDp,text_mask:tm});
  const secs=Number(duration.data[0]);
  const Lc=Math.max(1,Math.ceil(Math.round(secs*SR/HOP)/CP)), CH=DIM*CP;
  const {text_emb}=await te.run({text_ids:ti,style_ttl:sTtl,text_mask:tm});
  const lm=new ort.Tensor('float32',new Float32Array(Lc).fill(1),[1,1,Lc]);
  console.log(`\n${prec==='.fp32'?'fp32':'int8'}  (audio ${secs.toFixed(2)}s)`);
  for (const steps of [2,4,8]) {
    let lat=new ort.Tensor('float32',Float32Array.from({length:CH*Lc},()=>{const u=Math.random()||1e-9;return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*Math.random());}),[1,CH,Lc]);
    const t0=Date.now();
    for(let s=0;s<steps;s++){const o=await ve.run({noisy_latent:lat,text_emb,style_ttl:sTtl,latent_mask:lm,text_mask:tm,current_step:new ort.Tensor('float32',Float32Array.from([s]),[1]),total_step:new ort.Tensor('float32',Float32Array.from([steps]),[1])});lat=o.denoised_latent;}
    await voc.run({latent:lat});
    const el=(Date.now()-t0)/1000;
    console.log(`  steps=${String(steps).padStart(2)}  ${el.toFixed(1)}s  ${(secs/el).toFixed(2)}x realtime`);
  }
}
