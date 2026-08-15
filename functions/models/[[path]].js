/**
 * Serves the Supertonic model bundle from R2, same-origin.
 *
 * Cloudflare Pages caps a static asset at 25 MiB; vector_estimator.onnx alone
 * is 244.7 MB, so the bundle cannot ship as an ordinary Pages asset. Routing
 * it through a Function bound to R2 keeps it on the same origin as the rest
 * of the app instead — which matters specifically because of COEP.
 *
 * With Cross-Origin-Embedder-Policy: require-corp set (see public/_headers),
 * a cross-origin subresource is blocked unless it carries a matching
 * Cross-Origin-Resource-Policy or CORS header. Serving from a separate R2
 * custom domain would need every model file to opt in to that; serving it
 * same-origin through this Function sidesteps the requirement entirely, and
 * MODEL_BASE in src/services/tts/synthesis.worker.ts stays a relative path —
 * no app code change needed for this to work.
 *
 * R2 object keys are stored under a supertonic-3/ prefix so the bucket can
 * hold more than one model bundle later without a path collision.
 */

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE = 'public, max-age=300';

/**
 * Parses a standard `Range: bytes=START-END` header into R2's range shape.
 * R2Bucket.get() also accepts the raw Headers object directly, but doing it
 * explicitly here keeps 206 handling and the Content-Range response header
 * under this file's control rather than R2's default behavior.
 */
function parseRange(rangeHeader) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? '');
  if (!match) return undefined;
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  return end !== undefined ? { offset, length: end - offset + 1 } : { offset };
}

export async function onRequestGet(context) {
  const { env, params, request } = context;

  if (!env.MODELS) {
    return new Response(
      'R2 bucket not bound. Add an R2 binding named MODELS to this Pages project ' +
        '(Settings -> Functions -> R2 bucket bindings, or via wrangler.toml).',
      { status: 500 }
    );
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  if (segments.length === 0) return new Response('Not found', { status: 404 });

  // The URL already carries the supertonic-3/ prefix (modelBase in
  // synthesis.worker.ts is '/models/supertonic-3'), matching the prefix
  // R2 objects are stored under (see upload-models-to-r2.mjs) — segments
  // is that path as-is, not a suffix needing the prefix added again.
  const key = segments.join('/');
  const requestedRange = parseRange(request.headers.get('range'));

  const object = await env.MODELS.get(key, requestedRange ? { range: requestedRange } : undefined);
  if (object === null) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);

  // These are public model weights with no per-user data — safe to expose to
  // any origin regardless of where the app is served from.
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Accept-Ranges', 'bytes');
  headers.set(
    'Cache-Control',
    key.endsWith('manifest.json') ? MANIFEST_CACHE : IMMUTABLE_CACHE
  );

  // Whether to answer 206 is decided by what the *client* asked for, not by
  // object.range: R2 (confirmed against the local emulator, and matching how
  // the field is documented — "the actual bytes returned") populates that
  // field with the full span on an ordinary unranged get too. Keying off its
  // mere presence made every response 206, full reads included, which is
  // wrong HTTP and confused a plain `curl -I` into reporting the wrong status.
  if (requestedRange && object.range) {
    const end = object.range.offset + object.range.length - 1;
    headers.set('Content-Range', `bytes ${object.range.offset}-${end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

export async function onRequestHead(context) {
  const response = await onRequestGet(context);
  return new Response(null, { status: response.status, headers: response.headers });
}
