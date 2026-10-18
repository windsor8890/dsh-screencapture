/**
 * dsh-screencapture — loopback trust fence.
 *
 * The DSH desktop page reaches plugin routes through an Electron protocol proxy
 * that strips `origin`/`cookie`/`sec-fetch-site` and replays the request over a
 * loopback socket from the Host process, adding the auth cookie. The trust
 * boundary for these native control routes is therefore: the request arrived on
 * a loopback socket AND carries a loopback Host header, with no browser
 * cross-site marker. This mirrors the fence used by the shipped third-party
 * plugins (for example @linxin666/dsh-update) for this Harness version.
 *
 * Semantics: RFC 5735 IPv4 127/8, ::1, IPv4-mapped ::ffff:127/8, localhost
 * hostnames, plus browser same-origin markers when a direct browser origin
 * reaches the listener. The socket address is authoritative; X-Forwarded-For is
 * never trusted.
 *
 * @module dsh-screencapture/host/fence
 */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export function isLoopbackHostname(hostname) {
  const normalized = String(hostname).toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true
  return isIPv4Loopback(normalized)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers.
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean} whether the request is trusted for a native control route.
 */
export function isLoopbackRequest(request) {
  const socket = request && request.socket
  if (!isLoopbackAddress(socket ? socket.remoteAddress : undefined)) return false
  const headers = request.headers || {}
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
