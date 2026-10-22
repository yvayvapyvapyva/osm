const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const output = path.join(root, 'deploy-2files');
const scripts = [
    'report.js',
    'mapEngine.js',
    'pdd.js',
    'padtext.js',
    'recplay.js',
    'trafficlights.js',
    'saveState.js',
];

function minifyJavaScript(source, file) {
    const result = spawnSync(
        'terser',
        ['--compress', '--mangle', '--format', 'comments=false'],
        { input: source, encoding: 'utf8' }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`terser failed for ${file}: ${result.stderr}`);
    }
    return result.stdout;
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const directory of ['pic', 'znaki']) {
    fs.cpSync(path.join(root, directory), path.join(output, directory), {
        recursive: true,
        filter: file => path.basename(file) !== '.DS_Store',
    });
}

for (const page of ['pad.html', 'viewer.html']) {
    let html = fs.readFileSync(path.join(root, 'pad.html'), 'utf8');
    if (page === 'viewer.html') {
        html = html.replace('<title>PAD</title>', '<title>PAD — просмотр сцен</title>');
    }

    for (const file of scripts) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const minified = minifyJavaScript(source, file);
        const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(
            `<script\\b([^>]*src=["']${escaped}(?:\\?[^"']*)?["'][^>]*)><\\/script\\s*>`,
            'i'
        );
        html = html.replace(pattern, () => `<script>${minified}</script>`);
    }

    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes, source) => {
        if (/\bsrc\s*=/i.test(attributes) || !source.trim()) return tag;
        return `<script${attributes}>${minifyJavaScript(source, `${page} inline script`)}</script>`;
    });
    fs.writeFileSync(path.join(output, page), html);
}

console.log(`Minified PAD deploy bundle created: ${output}`);
