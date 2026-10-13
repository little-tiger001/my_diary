const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
fs.mkdirSync(VENDOR, { recursive: true });

const copies = [
  ['vue/dist/vue.global.prod.js', 'vue.global.prod.js'],
  ['dexie/dist/dexie.min.js', 'dexie.min.js'],
  ['markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  ['echarts/dist/echarts.min.js', 'echarts.min.js']
];

let failed = 0;
for (const [from, to] of copies) {
  const src = path.join(ROOT, 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.error('MISSING: ' + from);
    failed++;
    continue;
  }
  fs.copyFileSync(src, path.join(VENDOR, to));
  console.log('ok  ' + to + '  (' + fs.statSync(src).size + ' bytes)');
}
if (failed) {
  console.error('\n' + failed + ' file(s) missing — run npm install first');
  process.exit(1);
}
console.log('\nvendor ready -> ' + VENDOR);
