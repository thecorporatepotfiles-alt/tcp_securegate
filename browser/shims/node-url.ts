/** node:url stand-in for the browser bundle (file: URL <-> POSIX path conversion only). */

export function fileURLToPath(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  if (u.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  if (u.hostname !== '' && u.hostname !== 'localhost') throw new TypeError('File URL host must be "localhost" or empty');
  if (/%2f/i.test(u.pathname)) throw new TypeError('File URL path must not include encoded / characters');
  return decodeURIComponent(u.pathname);
}

export function pathToFileURL(path: string): URL {
  const absolute = path.startsWith('/') ? path : `/${path}`;
  const url = new URL('file://');
  // Encode characters that URL parsing would otherwise interpret.
  url.pathname = absolute.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09').replace(/#/g, '%23').replace(/\?/g, '%3F');
  return url;
}

export default { fileURLToPath, pathToFileURL };
