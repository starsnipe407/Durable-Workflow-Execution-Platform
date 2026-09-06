import { NextRequest } from 'next/server';

type RouteContext = {
  params: { path: string[] } | Promise<{ path: string[] }>;
};

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length']);

async function handleProxy(request: NextRequest | Request, context: RouteContext): Promise<Response> {
  const resolvedParams = await Promise.resolve(context.params);
  const pathSegments = resolvedParams?.path ?? [];
  const subpath = pathSegments.map(encodeURIComponent).join('/');

  const reqUrl = new URL(request.url);
  const baseUrl = process.env.DURABLE_API_URL || 'http://localhost:3000';
  const targetUrl = new URL(`${baseUrl.replace(/\/+$/, '')}/${subpath}${reqUrl.search}`);

  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  forwardHeaders.set('x-api-key', process.env.DURABLE_API_KEY || '');

  let body: BodyInit | undefined = undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) {
      body = buf;
    }
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body,
    });
  } catch {
    return Response.json(
      { error: 'Bad Gateway', message: 'Unable to connect to upstream API' },
      { status: 502 }
    );
  }

  const contentType = upstreamRes.headers.get('content-type') || '';
  const isSSE = contentType.includes('text/event-stream');

  if (isSSE) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const isNullBodyStatus = upstreamRes.status === 204 || upstreamRes.status === 304;

  return new Response(isNullBodyStatus ? null : upstreamRes.body, {
    status: upstreamRes.status,
    headers: {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
    },
  });
}

export const dynamic = 'force-dynamic';

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const DELETE = handleProxy;
export const PATCH = handleProxy;

