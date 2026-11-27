import { type NextRequest, NextResponse } from 'next/server';
import { getApiInternalBaseUrl } from '@/lib/catalog-api';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  if (!path || path.length === 0) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  const encodedSegments = path.map((segment) => encodeURIComponent(segment)).join('/');
  const upstreamUrl = new URL(`${getApiInternalBaseUrl()}/catalog/${encodedSegments}`);
  upstreamUrl.search = req.nextUrl.search;

  const acceptLanguage = req.headers.get('accept-language');
  const upstreamRes = await fetch(upstreamUrl.toString(), {
    method: 'GET',
    cache: 'no-store',
    ...(acceptLanguage ? { headers: { 'accept-language': acceptLanguage } } : {}),
  });

  const contentType = upstreamRes.headers.get('content-type') ?? 'application/json; charset=utf-8';
  const bodyText = await upstreamRes.text();

  return new NextResponse(bodyText, {
    status: upstreamRes.status,
    headers: {
      'Content-Type': contentType,
    },
  });
}
