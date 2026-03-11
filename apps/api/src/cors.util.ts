export function createCorsOriginChecker(frontendUrl: string) {
  const allowed = frontendUrl.includes(',')
    ? frontendUrl.split(',').map((s) => s.trim())
    : [frontendUrl];
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  };
}
