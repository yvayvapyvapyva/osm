const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'deploy-2files');
const pageBundles = {
    'navigator.html': {
        stylesheet: 'assets/css/navigator.css',
        scripts: ['assets/js/tts-client.js', 'assets/js/map-styles.js', 'assets/js/menu-module.js'],
        instruction: 'instr.html',
    },
};

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

function bodyContent(file) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    if (!match) throw new Error(`No body found in ${file}`);
    return match[1];
}

function embedPage(file, bundle) {
    let html = fs.readFileSync(path.join(root, file), 'utf8');
    const favicon = fs.readFileSync(path.join(root, 'ico.png')).toString('base64');
    const styles = fs.readFileSync(path.join(root, bundle.stylesheet), 'utf8');

    html = html.replace(
        /<link\b[^>]*href=["']assets\/css\/[^"']+["'][^>]*>/i,
        `<style>${styles}</style>`
    );
    html = html.replace(
        /<link\b[^>]*href=["']ico\.png["'][^>]*>/i,
        `<link rel="icon" href="data:image/png;base64,${favicon}" type="image/png">`
    );

    // Встраиваем скрипты на их исходные места: порядок инициализации в бандле
    // должен совпадать с порядком в исходной странице. Раньше defer-скрипты
    // переносились в конец body, из-за чего menu-module.js оказывался ниже
    // кода, который вызывает MenuModule.init().
    for (const scriptFile of bundle.scripts) {
        const source = fs.readFileSync(path.join(root, scriptFile), 'utf8');
        const minified = minifyJavaScript(source, scriptFile);
        const sourcePattern = new RegExp(
            `<script\\b([^>]*src=["']${scriptFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*)><\\/script\\s*>`,
            'i'
        );
        html = html.replace(sourcePattern, () => `<script>${minified}</script>`);
    }

    const instructionTemplate = `<template id="embeddedInstruction">${bodyContent(bundle.instruction)}</template>`;
    html = html.replace('</body>', `${instructionTemplate}</body>`);
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes, source) => {
        if (/\bsrc\s*=/i.test(attributes) || !source.trim()) return tag;
        return `<script${attributes}>${minifyJavaScript(source, `${file} inline script`)}</script>`;
    });

    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, html);
}

fs.mkdirSync(output, { recursive: true });
for (const [file, bundle] of Object.entries(pageBundles)) embedPage(file, bundle);
console.log(`Static deploy bundle created: ${output}`);
