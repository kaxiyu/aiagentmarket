export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const backendOrigin = 'https://aimarket.presentia.workers.dev';
    const targetUrl = new URL(url.pathname + url.search, backendOrigin);

    const headers = new Headers(request.headers);
    headers.set('Host', 'aimarket.presentia.workers.dev');
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });

    const response = await fetch(proxyRequest);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // Rewrite Location header so redirects stay on the clean Pages domain
    const location = responseHeaders.get('Location');
    if (location) {
      responseHeaders.set('Location', location.replace(backendOrigin, url.origin));
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
