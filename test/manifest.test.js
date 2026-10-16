// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import {
  ACTIONS,
  ALARM_KINDS,
  ARM_MODES,
  LIMITS,
  PANEL_TYPES,
  PANIC_KINDS,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const values = (field) => field.options.map((o) => o.value);
const partitionValues = Array.from({ length: LIMITS.maxPartitions }, (_, i) => String(i + 1));

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene triggers and actions need Gladys 5.1');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-envisalink:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['security']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+EyezOn|sans\s+lien\s+avec\s+EyezOn/i);
  }
});

test('no double-encoded UTF-8 (mojibake) in the manifest and the docs', () => {
  // U+00C3 U+00A9 for "é", U+00C2 U+00AB for "«": UTF-8 read as Windows-1252
  // and written again. Built from code points so this file never holds one.
  const c = (code) => String.fromCharCode(code);
  const mojibake = new RegExp(
    `[${c(0xc2)}${c(0xc3)}][${c(0x80)}-${c(0xbf)}${c(0x20ac)}${c(0x201a)}-${c(0x2122)}]`,
  );
  assert.match(`caf${c(0xc3)}${c(0xa9)}`, mojibake, 'the guard catches a double encoding');
  for (const path of [
    'gladys-assistant-integration.json',
    'docs/fr.md',
    'docs/en.md',
    'README.md',
  ]) {
    const text = read(path);
    assert.doesNotMatch(text, mojibake, path);
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${path} starts with a BOM`);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.equal(fields.allow_disarm.default, false, 'disarming from Gladys is opt-in');
  assert.equal(fields.allow_panic.default, false, 'panic from Gladys is opt-in');
  assert.equal(fields.password.type, 'secret', 'the password is never sent back to the browser');
  assert.equal(fields.user_code.type, 'secret', 'nor the user code');
  assert.deepEqual(values(fields.language), LANGUAGES);
  assert.deepEqual(values(fields.panel_type), PANEL_TYPES);
  assert.equal(fields.partitions.max, LIMITS.maxPartitions);
  assert.equal(fields.host.required && fields.password.required, true);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required ?? section.default ?? section.placeholder, undefined);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} too long`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  const action = (key) => manifest.scene_actions.find((a) => a.key === key);
  const field = (item, key) => item.fields.find((f) => f.key === key);
  assert.deepEqual(values(field(action('arm'), 'mode')), ARM_MODES);
  assert.deepEqual(values(field(action('arm'), 'partition')), partitionValues);
  assert.deepEqual(values(field(action('panic'), 'kind')), PANIC_KINDS);
});

test('the trigger fields and variables are what the events carry', () => {
  const expected = {
    alarm_triggered: ['partition', 'kind', 'partition', 'kind', 'zone'],
    armed: ['partition', 'mode', 'partition', 'mode', 'user', 'by_gladys'],
    disarmed: ['partition', 'partition', 'user', 'by_gladys'],
  };
  for (const trigger of manifest.scene_triggers) {
    const declared = [...(trigger.fields ?? []), ...(trigger.variables ?? [])].map((f) => f.key);
    assert.deepEqual(declared, expected[trigger.key], trigger.key);
    for (const key of new Set(declared)) {
      assert.match(app, new RegExp(`\\b${key}[:,]`), `${trigger.key}: ${key} is never sent`);
    }
    assert.deepEqual(values(trigger.fields[0]), partitionValues, 'partitions sent as strings');
  }
  const kinds = manifest.scene_triggers.find((t) => t.key === 'alarm_triggered').fields[1];
  assert.deepEqual(values(kinds), ALARM_KINDS);
  const modes = manifest.scene_triggers.find((t) => t.key === 'armed').fields[1];
  assert.deepEqual(values(modes), ARM_MODES);
});
