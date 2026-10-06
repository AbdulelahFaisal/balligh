const ALLOWED_HOSTS = new Set([
  "qurancomplex.gov.sa",
  "quranenc.com",
  "dorar.net",
  "hadeethenc.com",
  "binbaz.org.sa",
  "alifta.gov.sa",
  "youtube.com",
  "youtu.be",
]);

export function safeSourceUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length > 2000 || /[\s\u0000-\u001f]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return ALLOWED_HOSTS.has(host) ? parsed.href : null;
}
