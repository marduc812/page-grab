const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../scripts/build.cjs');
const root = path.resolve(__dirname, '..');

test('browser builds share source and package every manifest asset', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagegrab-build-'));
  try {
    const original = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    for (const target of ['chrome', 'firefox']) {
      const output = build(target, path.join(temp, target));
      const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')));
      if (target === 'chrome') assert.deepEqual(manifest, original);
      else {
        assert.deepEqual(manifest.background, { scripts: ['background.js'] });
        assert.ok(manifest.permissions.includes('clipboardWrite'));
        assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
      }
      for (const file of ['background.js', 'content.js', ...Object.values(manifest.icons)]) {
        assert.deepEqual(fs.readFileSync(path.join(output, file)), fs.readFileSync(path.join(root, file)));
      }
      assert.equal(fs.existsSync(path.join(output, 'tests')), false);
    }
    assert.throws(() => build('safari', temp), /Choose chrome or firefox/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
