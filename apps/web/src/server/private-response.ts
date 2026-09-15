/** Private application data must be authorized again on every request. */
export function privateResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  const vary = new Set((response.headers.get('Vary') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  vary.add('Cookie');
  vary.add('Authorization');
  response.headers.set('Vary', [...vary].join(', '));
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
