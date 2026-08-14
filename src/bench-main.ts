/** Dev-only harness for bench.worker.ts. Not a build entry. */
const out = document.getElementById('out') as HTMLPreElement;
const env = document.getElementById('env') as HTMLDivElement;

const worker = new Worker(new URL('./bench.worker.ts', import.meta.url), { type: 'module' });
const results: unknown[] = [];

worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'env') {
    env.textContent = `webgpu:${m.gpu}  crossOriginIsolated:${m.isolated}  wasmThreads:${m.threads}`;
  } else if (m.type === 'result') {
    results.push(m);
    const cls = !m.ok ? 'bad' : /(\d+\.\d+)x/.exec(m.detail) && Number(RegExp.$1) >= 1 ? 'ok' : 'warn';
    out.innerHTML += `<span class="${cls}">${String(m.ep).padEnd(8)} ${m.steps} steps  ${m.detail}</span>\n`;
  } else if (m.type === 'done') {
    (window as unknown as { __benchDone: boolean }).__benchDone = true;
    (window as unknown as { __benchResults: unknown[] }).__benchResults = results;
    out.innerHTML += '\ndone\n';
  }
};
worker.onerror = (e) => { out.textContent += `\nworker error: ${e.message}\n`; };
worker.postMessage('go');
