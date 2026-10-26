import { accessCookie, decide, REALM } from '../edge/siteGate';

interface Env { SITE_PASSWORD?: string }
interface Ctx { request: Request; env: Env; next: () => Promise<Response> }

/** HTTP Basic Auth in front of the whole static site. Fails closed when SITE_PASSWORD is not set. */
export const onRequest = async ({ request, env, next }: Ctx): Promise<Response> => {
  const d = await decide(request.headers.get('authorization'), env.SITE_PASSWORD);
  if (d.kind === 'deny') {
    const h = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
    if (d.status === 401) h.set('www-authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    return new Response(d.body, { status: d.status, headers: h });
  }
  const upstream = await next();
  const res = new Response(upstream.body, upstream);
  res.headers.set('x-robots-tag', 'noindex, nofollow');
  if ((res.headers.get('content-type') ?? '').includes('text/html') && env.SITE_PASSWORD) {
    res.headers.append('set-cookie', accessCookie(env.SITE_PASSWORD));
  }
  return res;
};
