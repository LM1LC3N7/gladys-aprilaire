// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The protocol has
// no password, PIN nor key: nothing secret here.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address a thermostat cannot have: unspecified, broadcast, multicast, reserved. */
function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  return (
    a === 0 ||
    (a === 255 && b === 255 && c === 255 && d === 255) ||
    (a >= 224 && a <= 255) ||
    d === 255 ||
    d === 0
  );
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (7000 by default).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid.
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined;
  }
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text.length > 260 || /[^\x21-\x7e]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unusableIpv4(host) ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** The address as /data names it: "192.168.1.20:7000". */
export const addressKey = (address) => (address ? `${address.host}:${address.port}` : undefined);

/** Only `true` (or the text "true") turns an option on: anything else, missing included, is off. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = typeof c.address === 'string' ? c.address.trim() : '';
  const address = parseAddress(typed);
  const interval = Number(c.poll_interval);
  return {
    address,
    key: addressKey(address),
    /** What was typed and is not a valid address (shown in the status, bounded). */
    invalidAddress:
      typed !== '' && !address ? typed.replace(/[^\x20-\x7e]/g, '?').slice(0, 60) : undefined,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
