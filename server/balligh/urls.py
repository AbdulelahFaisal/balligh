from urllib.parse import urlsplit

ALLOWED_SOURCE_HOSTS = frozenset(
    {
        "qurancomplex.gov.sa",
        "quranenc.com",
        "dorar.net",
        "hadeethenc.com",
        "binbaz.org.sa",
        "alifta.gov.sa",
        "youtube.com",
        "youtu.be",
    }
)


def is_allowed_source_url(url: str) -> bool:
    if not isinstance(url, str) or len(url) > 2000 or any(c.isspace() or ord(c) < 32 for c in url):
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        return False
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host in ALLOWED_SOURCE_HOSTS
