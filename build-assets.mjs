// 构建脚本：把 public/ 下的静态文件内联成 public-assets.mjs，供 bun compile 打包进单文件 exe
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, 'public');
const files = ['index.html', 'style.css', 'app.js'];
const lines = ['// 由 build-assets.mjs 自动生成，请勿手动编辑'];
const keys = [];

for (const f of files) {
  const content = fs.readFileSync(path.join(pub, f), 'utf8');
  const varName = f.replace(/\W/g, '_');
  lines.push(`export const ${varName} = ${JSON.stringify(content)};`);
  keys.push({ file: f, varName });
}
lines.push('export default {');
for (const k of keys) lines.push(`  ${JSON.stringify(k.file)}: ${k.varName},`);
lines.push('};');

fs.writeFileSync(path.join(__dirname, 'public-assets.mjs'), lines.join('\n'), 'utf8');
console.log('generated public-assets.mjs (' + files.join(', ') + ')');
