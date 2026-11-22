// Минификация стадии деплоя navigatortg2 для Cloudflare Pages.
// Исходники в репозитории не меняются: скрипт работает с временной папкой,
// которую собирает deploy-v2.sh.
//
// Использование: node scripts/minify-deploy.js <stage-dir>
// Отключить минификацию: MINIFY=0 ./deploy-v2.sh

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { minify as minifyHtml } from 'html-minifier-terser';
import { transform as transformAsset } from 'esbuild';

const HTML_FILES = ['index.html', 'navigator.html', 'editor.html', 'instr.html', 'instr_editor.html'];

// Уже минифицированные сторонние библиотеки: повторная обработка не нужна
// и может сломать их.
const SKIP_ASSETS = new Set(['maplibre-gl.js', 'pmtiles.js', 'sortable.min.js']);

const HTML_OPTIONS = {
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
  removeAttributeQuotes: false,
  caseSensitive: true,
  keepClosingSlash: true,
};

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} КБ`;
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function minifyHtmlFile(file) {
  const source = await fs.readFile(file, 'utf8');
  const output = await minifyHtml(source, HTML_OPTIONS);
  await fs.writeFile(file, output, 'utf8');
  return { before: Buffer.byteLength(source), after: Buffer.byteLength(output) };
}

async function minifyAssetFile(file) {
  const ext = path.extname(file).toLowerCase();
  const source = await fs.readFile(file, 'utf8');
  const result = await transformAsset(source, {
    loader: ext === '.css' ? 'css' : 'js',
    minify: true,
    legalComments: 'none',
    target: ext === '.css' ? undefined : 'es2019',
  });
  await fs.writeFile(file, result.code, 'utf8');
  return { before: Buffer.byteLength(source), after: Buffer.byteLength(result.code) };
}

async function main() {
  const stage = process.argv[2];
  if (!stage) {
    console.error('Использование: node scripts/minify-deploy.js <stage-dir>');
    process.exit(1);
  }
  const root = path.resolve(stage);

  let htmlBefore = 0;
  let htmlAfter = 0;
  for (const name of HTML_FILES) {
    const file = path.join(root, name);
    try {
      const size = await minifyHtmlFile(file);
      htmlBefore += size.before;
      htmlAfter += size.after;
      console.log(`HTML  ${name}: ${formatKb(size.before)} → ${formatKb(size.after)}`);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      throw e;
    }
  }

  const assetsDir = path.join(root, 'assets');
  let assetBefore = 0;
  let assetAfter = 0;
  try {
    const files = await walk(assetsDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.js' && ext !== '.css') continue;
      if (SKIP_ASSETS.has(path.basename(file))) continue;
      const size = await minifyAssetFile(file);
      assetBefore += size.before;
      assetAfter += size.after;
    }
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) throw e;
  }

  console.log(`Итого HTML:  ${formatKb(htmlBefore)} → ${formatKb(htmlAfter)}`);
  console.log(`Итого assets: ${formatKb(assetBefore)} → ${formatKb(assetAfter)}`);
}

main().catch((e) => {
  console.error('Минификация не удалась:', (e && e.stack) || e);
  process.exit(1);
});
