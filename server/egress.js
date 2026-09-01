'use strict';
/* Which of my own IP addresses Google sees.
 *
 * This exists because of a real, silent failure. The client restricted their
 * Geocoding key by IP address — correctly, that is exactly what a server key
 * should be restricted by — and allow-listed the IPv4 address I gave them.
 * The very next request was refused:
 *
 *   REQUEST_DENIED — "This IP, site or mobile application is not authorized to
 *   use this API key. Request received from IP address 2a01:4f8:c17:292c::1"
 *
 * That is this same machine. It has an IPv4 address AND an IPv6 address, and
 * Node prefers IPv6 when both resolve. So the request left by an address that
 * was never on the allow-list. The key was fine; the restriction was fine; the
 * outbound address was the problem.
 *
 * The dangerous shape of this bug is that it is INTERMITTENT. Happy Eyeballs
 * (RFC 8305) races the two families and takes whichever connects first, so the
 * same command can succeed and then fail depending on which wins the race. A
 * batch of 2,400 paid requests that half-fails is worse than one that fails
 * outright, because the failures get written to the database as "could not be
 * geocoded" for addresses that are perfectly good.
 *
 * So: pin outbound connections to IPv4 rather than ask the client to add an
 * address I could simply stop using. Both settings are needed —
 *
 *   setDefaultResultOrder('ipv4first')  puts the A record first, and
 *   setDefaultAutoSelectFamily(false)   stops Node racing the AAAA anyway.
 *
 * Ordering on its own is not a guarantee, because Happy Eyeballs is allowed to
 * take the winner regardless of order.
 */
const dns = require('node:dns');
const net = require('node:net');

let pinned = false;

/** Force this process to reach the internet over IPv4. Idempotent. */
function pinToIPv4() {
  if (pinned) return true;
  dns.setDefaultResultOrder('ipv4first');
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(false);       // Node >= 18.13
  }
  pinned = true;
  return true;
}

function isPinned() { return pinned; }

/* Google names the offending address in its own error text. Pull it out, so the
 * operator is told which address to allow-list instead of being told to "check
 * the API key" — which is the one thing that is not wrong. */
const DENIED_IP = /Request received from IP address ([0-9a-fA-F:.]+)/;

function explainDenial(googleMessage) {
  const m = DENIED_IP.exec(String(googleMessage || ''));
  if (!m) return null;
  const ip = m[1];
  const v6 = ip.includes(':');
  return {
    ip,
    family: v6 ? 6 : 4,
    hint: v6
      ? `Google saw this server's IPv6 address (${ip}), not its IPv4 one. `
        + 'Run with the IPv4 pin enabled (server/egress.js), or add that IPv6 '
        + 'address to the key restriction as well.'
      : `Google saw ${ip}. Add exactly that address to the key's IP restriction.`,
  };
}

module.exports = { pinToIPv4, isPinned, explainDenial };
