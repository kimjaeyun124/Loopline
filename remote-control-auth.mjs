export function remoteRequestOriginAllowed({method, origin, dnsName, client, fetchSite}) {
  if (fetchSite === 'cross-site') return false;
  const verb = String(method || 'GET').toUpperCase();
  const nativeIos = client === 'native-ios';
  const hasWebOrigin = typeof origin === 'string' && origin.length > 0 && origin !== 'null';

  if (hasWebOrigin) {
    try {
      return new URL(origin).origin === `https://${dnsName}`;
    } catch {
      return false;
    }
  }

  if (origin === 'null') return nativeIos;
  return ['GET', 'HEAD'].includes(verb) || nativeIos;
}
