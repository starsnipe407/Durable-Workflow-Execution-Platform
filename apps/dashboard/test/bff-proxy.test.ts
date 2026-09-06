import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { GET, POST, PUT, DELETE, PATCH } from '@/app/api/[...path]/route';

describe('BFF Catch-All Proxy Route (/api/[...path])', () => {
  let server: http.Server;
  let serverUrl: string;
  let lastServerRequest: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    body?: string;
  } = {};

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        lastServerRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        };

        if (req.url?.startsWith('/runs/run-123/events')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write('id: evt-1\nevent: step_started\ndata: {"stepKey":"step-1"}\n\n');
          setTimeout(() => {
            res.write('id: evt-2\nevent: step_completed\ndata: {"stepKey":"step-1"}\n\n');
            res.end();
          }, 50);
          return;
        }

        if (req.url === '/not-found') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Resource not found' }));
          return;
        }

        if (req.url === '/bad-request') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
          return;
        }

        if (req.url?.startsWith('/runs') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ runs: [{ id: 'run-1' }], total: 1 }));
          return;
        }

        if (req.url?.startsWith('/runs/run-123/retry') && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'PENDING', retried: true }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, received: true }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    process.env.DURABLE_API_URL = serverUrl;
    process.env.DURABLE_API_KEY = 'test-secret-key-123';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    lastServerRequest = {};
  });

  it('1. forwards GET request and query string to upstream, injecting x-api-key', async () => {
    const req = new Request('http://localhost:3001/api/runs?status=RUNNING&limit=10', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    const res = await GET(req as any, { params: Promise.resolve({ path: ['runs'] }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ runs: [{ id: 'run-1' }], total: 1 });

    expect(lastServerRequest.method).toBe('GET');
    expect(lastServerRequest.url).toBe('/runs?status=RUNNING&limit=10');
    expect(lastServerRequest.headers?.['x-api-key']).toBe('test-secret-key-123');
    expect(lastServerRequest.headers?.['accept']).toBe('application/json');
  });

  it('2. forwards POST request with body and headers, injecting x-api-key', async () => {
    const payload = { force: true };
    const req = new Request('http://localhost:3001/api/runs/run-123/retry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-abc-123',
      },
      body: JSON.stringify(payload),
    });

    const res = await POST(req as any, { params: Promise.resolve({ path: ['runs', 'run-123', 'retry'] }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'PENDING', retried: true });

    expect(lastServerRequest.method).toBe('POST');
    expect(lastServerRequest.url).toBe('/runs/run-123/retry');
    expect(lastServerRequest.headers?.['x-api-key']).toBe('test-secret-key-123');
    expect(lastServerRequest.headers?.['idempotency-key']).toBe('idem-abc-123');
    expect(JSON.parse(lastServerRequest.body || '{}')).toEqual(payload);
  });

  it('3. forwards SSE streaming transparently with correct headers and Last-Event-ID', async () => {
    const req = new Request('http://localhost:3001/api/runs/run-123/events', {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Last-Event-ID': 'evt-prev-0',
      },
    });

    const res = await GET(req as any, { params: Promise.resolve({ path: ['runs', 'run-123', 'events'] }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('connection')).toBe('keep-alive');

    expect(lastServerRequest.headers?.['x-api-key']).toBe('test-secret-key-123');
    expect(lastServerRequest.headers?.['last-event-id']).toBe('evt-prev-0');

    // Read stream chunks
    expect(res.body).toBeDefined();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }

    expect(accumulated).toContain('event: step_started');
    expect(accumulated).toContain('{"stepKey":"step-1"}');
    expect(accumulated).toContain('event: step_completed');
  });

  it('4. forwards 404 and 400 error responses with upstream status and body', async () => {
    const notFoundReq = new Request('http://localhost:3001/api/not-found', { method: 'GET' });
    const res404 = await GET(notFoundReq as any, { params: Promise.resolve({ path: ['not-found'] }) });
    expect(res404.status).toBe(404);
    const err404 = await res404.json();
    expect(err404).toEqual({ error: 'Resource not found' });

    const badReq = new Request('http://localhost:3001/api/bad-request', { method: 'POST' });
    const res400 = await POST(badReq as any, { params: Promise.resolve({ path: ['bad-request'] }) });
    expect(res400.status).toBe(400);
    const err400 = await res400.json();
    expect(err400).toEqual({ error: 'Invalid payload' });
  });

  it('5. supports PUT, DELETE, and PATCH methods', async () => {
    const putReq = new Request('http://localhost:3001/api/items/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated' }),
    });
    const putRes = await PUT(putReq as any, { params: Promise.resolve({ path: ['items', '1'] }) });
    expect(putRes.status).toBe(200);
    expect(lastServerRequest.method).toBe('PUT');

    const delReq = new Request('http://localhost:3001/api/items/1', { method: 'DELETE' });
    const delRes = await DELETE(delReq as any, { params: Promise.resolve({ path: ['items', '1'] }) });
    expect(delRes.status).toBe(200);
    expect(lastServerRequest.method).toBe('DELETE');

    const patchReq = new Request('http://localhost:3001/api/items/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patched: true }),
    });
    const patchRes = await PATCH(patchReq as any, { params: Promise.resolve({ path: ['items', '1'] }) });
    expect(patchRes.status).toBe(200);
    expect(lastServerRequest.method).toBe('PATCH');
  });
});
