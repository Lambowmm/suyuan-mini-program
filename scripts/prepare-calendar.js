// Copy only the official calendar's runtime dependency graph. No calendar logic is forked.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules/tdesign-miniprogram/miniprogram_dist');
const output = path.join(root, 'components/tdesign');
const seen = new Set();
function resolve(file, ref) {
  let target = ref.startsWith('.') ? path.resolve(path.dirname(file), ref) : path.join(source, 'miniprogram_npm', ref);
  for (const suffix of ['', '.js', '/index.js']) {
    if (fs.existsSync(target + suffix) && fs.statSync(target + suffix).isFile()) return target + suffix;
  }
  throw new Error('Cannot resolve ' + ref + ' from ' + file);
}
function copy(file) {
  if (seen.has(file)) return;
  if (!file.startsWith(source + path.sep)) throw new Error('Dependency outside package: ' + file);
  seen.add(file);
  let text = fs.readFileSync(file, 'utf8');
  const extension = path.extname(file);
  if (extension === '.json') {
    const config = JSON.parse(text);
    Object.values(config.usingComponents || {}).forEach(ref => {
      const base = path.resolve(path.dirname(file), ref);
      ['.js', '.json', '.wxml', '.wxss'].forEach(ext => { if (fs.existsSync(base + ext)) copy(base + ext); });
    });
  }
  const refs = extension === '.js' ? /(?:from\s*|import\s*|require\(\s*)['"]([^'"]+)['"]/g
    : extension === '.wxss' ? /@import\s*['"]([^'"]+)['"]/g
    : /(?:src)=["']([^"']+)["']/g;
  if (extension !== '.json') {
    for (const match of text.matchAll(refs)) {
      if (match[1].includes('{{') || /^(https?:|data:)/.test(match[1])) continue;
      const dependency = resolve(file, match[1]);
      copy(dependency);
      if (extension === '.js' && !match[1].startsWith('.')) {
        let relative = path.relative(path.dirname(file), dependency).replace(/\\/g, '/');
        if (!relative.startsWith('.')) relative = './' + relative;
        text = text.replace(match[0], match[0].replace(match[1], relative));
      }
    }
  }
  const destination = path.join(output, path.relative(source, file));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
}
['.js', '.json', '.wxml', '.wxss'].forEach(ext => copy(path.join(source, 'calendar/calendar' + ext)));
fs.copyFileSync(path.join(source, '..', 'LICENSE'), path.join(output, 'LICENSE'));
console.log('Prepared official TDesign calendar: ' + seen.size + ' runtime files.');
