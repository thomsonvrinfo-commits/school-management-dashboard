/**
 * Headers on every API response. The API only ever returns JSON, so a browser is told to treat anything it receives as
 * nothing but data: no scripts, no framing, no sniffing, no Referer, and never kept in a cache (it holds children's data).
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};
