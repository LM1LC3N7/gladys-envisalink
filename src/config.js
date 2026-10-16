// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, PANEL_TYPES, ZONE_TYPES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  panel_type: 'auto',
  partitions: 1,
  allow_arm: true,
  allow_disarm: false,
  allow_panic: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.40`, `evl.lan:4025`, `tcp://192.168.1.40` -> { host, port? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/** A user code: 4 to 8 digits (DSC 4 or 6, Honeywell 4), '' when absent or malformed. */
export const normalizeCode = (raw) => {
  const text = String(raw ?? '').trim();
  return /^\d{4,8}$/.test(text) ? text : '';
};

/**
 * The zone list: `1, 2=Kitchen, 3=Hall:motion, 10-12` -> [{ zone, name, type }].
 * Entries are separated by commas, semicolons or new lines; `N=Name` names a
 * zone, a trailing `:type` (opening, motion, smoke, leak) sets how it shows,
 * `N-M` adds a range. Wrong entries are reported, not fatal.
 */
export function parseZones(raw) {
  const zones = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:[=:]\s*(.*))?$/.exec(text);
    if (!match) {
      errors.push(text);
      continue;
    }
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    let name = (match[3] ?? '').trim();
    let type = 'opening';
    // `Hall:motion` (name and type), or `:motion` right after the number (type only).
    const typed = /^(?:(.*):)?\s*([a-z]+)\s*$/i.exec(name);
    const typeOnly = typed && typed[1] === undefined && !text.includes('=');
    if (
      typed &&
      ZONE_TYPES.includes(typed[2].toLowerCase()) &&
      (typed[1] !== undefined || typeOnly)
    ) {
      type = typed[2].toLowerCase();
      name = (typed[1] ?? '').trim();
    }
    if (from < 1 || to > LIMITS.maxZone || to < from) {
      errors.push(text);
      continue;
    }
    for (let zone = from; zone <= to; zone += 1) {
      zones.set(zone, { zone, name: from === to ? name : '', type });
    }
  }
  return { zones: [...zones.values()].sort((a, b) => a.zone - b.zone), errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const panelType = String(raw?.panel_type ?? DEFAULTS.panel_type)
    .trim()
    .toLowerCase();
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const zones = parseZones(raw?.zones);
  const typedCode = String(raw?.user_code ?? '').trim();
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    password: String(raw?.password ?? ''),
    code: normalizeCode(typedCode),
    codeInvalid: typedCode !== '' && normalizeCode(typedCode) === '',
    panelType: PANEL_TYPES.includes(panelType) ? panelType : DEFAULTS.panel_type,
    partitions: integer(raw?.partitions, DEFAULTS.partitions, 1, LIMITS.maxPartitions),
    zones: zones.zones,
    zoneErrors: zones.errors,
    allowArm: bool(raw?.allow_arm, DEFAULTS.allow_arm),
    allowDisarm: bool(raw?.allow_disarm, DEFAULTS.allow_disarm),
    allowPanic: bool(raw?.allow_panic, DEFAULTS.allow_panic),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the TPI session depends on: a change reconnects. */
export const sessionKey = (config) =>
  JSON.stringify([config.host, config.port, config.password, config.panelType]);
