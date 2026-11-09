const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function build(target, output = path.join(root, 'dist', target)) {
  if (!['chrome', 'firefox'].includes(target)) throw new Error('Choose chrome or firefox');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (target === 'firefox') {
    manifest.background = { scripts: ['background.js'] };
    manifest.permissions.push('clipboardWrite');
    manifest.browser_specific_settings = {
      gecko: {
        id: 'pagegrab@pagegrab.extension',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] }
      }
    };
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const file of ['background.js', 'content.js']) fs.copyFileSync(path.join(root, file), path.join(output, file));
  fs.mkdirSync(path.join(output, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const file = `pagegrab${size}.png`;
    fs.copyFileSync(path.join(root, 'icons', file), path.join(output, 'icons', file));
  }
  return output;
}

module.exports = { build };
if (require.main === module) {
  console.log(build(process.argv[2]));
}
