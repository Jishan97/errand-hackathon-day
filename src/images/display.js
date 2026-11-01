import { checkImageOperator, ImageFailure } from './generate.js';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
export async function handleImageDisplay(request, { getToken = () => undefined, getStore = () => { throw Error(); } } = {}) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
  try {
    checkImageOperator(request, getToken);
    const url = new URL(request.url);
    if (url.pathname === '/api/images/latest') {
      if (url.search) throw new ImageFailure('invalid_request', 400);
      const row = await getStore().latest();
      // Explicit projection: never expose stored call binding, nonce, hash or image bytes here.
      return Response.json({ image: row ? { id: row.id, status: row.status, prompt: row.prompt, createdAt: row.created_at } : null }, { headers });
    }
    if (url.pathname !== '/api/images/result' || url.searchParams.size !== 1 || !/^[a-f0-9-]{36}$/i.test(url.searchParams.get('id') ?? '')) throw new ImageFailure('invalid_request', 400);
    const encoded = await getStore().image(url.searchParams.get('id'));
    if (!encoded) throw new ImageFailure('image_not_ready', 404);
    if (typeof encoded !== 'string' || encoded.length > 4194304 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw Error();
    return new Response(bytes, { headers: { ...headers, 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline; filename="errand-image.jpg"' } });
  } catch (error) {
    return Response.json({ error: error instanceof ImageFailure ? error.code : 'image_screen_unavailable' },
      { status: error instanceof ImageFailure ? error.status : 503, headers });
  }
}
