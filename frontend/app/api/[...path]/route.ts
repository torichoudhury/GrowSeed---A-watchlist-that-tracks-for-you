import { NextRequest, NextResponse } from 'next/server';

const BACKEND = process.env.BACKEND_URL || 'https://growseed-a-watchlist-that-tracks-for-you.onrender.com';

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}
export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

async function proxy(req: NextRequest, params: { path: string[] }) {
  const path = params.path?.join('/') ?? '';
  const search = req.nextUrl.search ?? '';
  const url = `${BACKEND}/api/${path}${search}`;

  // Forward request headers, omitting host, origin, referer
  // This ensures Render's CORS middleware doesn't trigger on browser domains
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k !== 'host' && k !== 'origin' && k !== 'referer') {
      headers.set(key, value);
    }
  });

  let body: BodyInit | undefined;
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await req.text();
  }

  const res = await fetch(url, {
    method: req.method,
    headers,
    body,
  });

  const resHeaders = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) {
      resHeaders.set(key, value);
    }
  });
  resHeaders.set('x-proxied-by', 'nextjs-proxy');

  const resBody = (res.status === 204 || res.status === 304) ? null : res.body;

  return new NextResponse(resBody, {
    status: res.status,
    headers: resHeaders,
  });
}
