const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'deploy-2files');
const faviconFile = 'assets/favicon-128.png';

// Бюджет бандла: сборка должна падать, если «один файл» незаметно растолстел.
const BUDGET = {
    bundle: 230 * 1024,
    gzip: 80 * 1024,
    favicon: 32 * 1024,
};

const pageBundles = {
    'navigator.html': {
        stylesheet: 'assets/css/navigator.css',
        scripts: ['assets/js/tts-client.js', 'assets/js/map-styles.js', 'assets/js/menu-module.js', 'assets/js/auth-module.js'],
        instruction: 'instr.html',
    },
    'editor.html': {
        stylesheet: 'assets/css/editor.css',
        scripts: ['assets/js/config.js', 'assets/js/tts-client.js', 'assets/js/map-styles.js'],
        instruction: 'instr_editor.html',
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

// Консервативная минификация CSS: убираем комментарии и лишние пробелы,
// не трогая строки, значения custom properties и пробелы вокруг + в calc().
function minifyCss(source, file) {
    const strings = [];
    let css = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, (match) => {
            strings.push(match);
            return `\u0000${strings.length - 1}\u0000`;
        })
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};,])\s*/g, '$1')
        .replace(/:\s+/g, ':')
        .replace(/;}/g, '}')
        .trim()
        .replace(/\u0000(\d+)\u0000/g, (_, index) => strings[Number(index)]);

    let depth = 0;
    for (const char of css) {
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        if (depth < 0) throw new Error(`Unbalanced CSS braces in ${file}`);
    }
    if (depth !== 0) throw new Error(`Unbalanced CSS braces in ${file}`);
    return css;
}

function bodyContent(file) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    if (!match) throw new Error(`No body found in ${file}`);
    return match[1];
}

function readDotEnv(file) {
    const result = {};
    if (!fs.existsSync(file)) return result;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        result[match[1]] = value;
    }
    return result;
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildLegalPage() {
    const env = readDotEnv(path.join(root, '.env'));
    const name = (env.LEGAL_NAME || '').trim() || 'Не указано';
    const inn = (env.LEGAL_INN || '').trim() || 'Не указан';
    const email = (env.LEGAL_EMAIL || '').trim();
    const telegramRaw = (env.LEGAL_TELEGRAM || '').trim();
    const telegram = telegramRaw
        .replace(/^https?:\/\/t\.me\//i, '')
        .replace(/^@/, '');

    const emailHtml = email
        ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
        : 'Не указан';
    const telegramHtml = telegram
        ? `<a href="https://t.me/${escapeHtml(telegram)}" target="_blank" rel="noopener">@${escapeHtml(telegram)}</a>`
        : 'Не указан';

    const refundDefault =
        'Доступ предоставляется сразу после подтверждения оплаты. ' +
        'До активации премиума пользователь может отказаться от услуги и получить полный возврат. ' +
        'После активации возврат возможен за неиспользованный период или при технической ошибке.';
    const refund = refundDefault;

    const price = (env.PREMIUM_PRICE_RUB || '299').trim() || '299';
    const days = (env.PREMIUM_DAYS || '30').trim() || '30';
    const updated = new Date().toLocaleDateString('ru-RU');

    const replacements = {
        '{{LEGAL_NAME}}': escapeHtml(name),
        '{{LEGAL_STATUS}}': escapeHtml('Самозанятый (налог на профессиональный доход)'),
        '{{LEGAL_INN}}': escapeHtml(inn),
        '{{LEGAL_CONTACT_EMAIL}}': emailHtml,
        '{{LEGAL_CONTACT_TELEGRAM}}': telegramHtml,
        '{{LEGAL_REFUND_TERMS}}': escapeHtml(refund).replace(/\n/g, '<br>'),
        '{{PREMIUM_PRICE_RUB}}': escapeHtml(price),
        '{{PREMIUM_DAYS}}': escapeHtml(days),
        '{{LEGAL_UPDATED}}': escapeHtml(updated),
    };

    const templatePath = path.join(root, 'legal.template.html');
    let html = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(replacements)) {
        html = html.split(key).join(value);
    }
    fs.writeFileSync(path.join(output, 'legal.html'), html);
    console.log(`  legal.html: ${formatKb(Buffer.byteLength(html))}`);
}

function formatKb(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function assertBudget(label, bytes, limit) {
    if (bytes > limit) {
        throw new Error(`${label} exceeds budget: ${formatKb(bytes)} > ${formatKb(limit)}`);
    }
}

function embedPage(file, bundle) {
    let html = fs.readFileSync(path.join(root, file), 'utf8');
    const faviconPath = path.join(root, faviconFile);
    const faviconBuffer = fs.readFileSync(faviconPath);
    assertBudget(`${faviconFile}`, faviconBuffer.length, BUDGET.favicon);
    const favicon = faviconBuffer.toString('base64');
    const stylesRaw = fs.readFileSync(path.join(root, bundle.stylesheet), 'utf8');
    const styles = minifyCss(stylesRaw, bundle.stylesheet);

    // Подставляем стили страницы строго по пути: на странице может быть
    // несколько <link> на CSS (например, maplibre-gl.css), и «первый попавшийся»
    // больше не годится.
    const stylesheetPattern = new RegExp(
        `<link\\b[^>]*href=["']${bundle.stylesheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*>`,
        'i'
    );
    if (!stylesheetPattern.test(html)) {
        throw new Error(`В ${file} не найден <link> на ${bundle.stylesheet}`);
    }
    html = html.replace(stylesheetPattern, () => `<style>${styles}</style>`);
    html = html.replace(
        /<link\b[^>]*rel=["']icon["'][^>]*>/i,
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
    html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (tag, attributes, source) => {
        if (!source.trim()) return tag;
        return `<style${attributes}>${minifyCss(source, `${file} inline style`)}</style>`;
    });

    const bundleBytes = Buffer.byteLength(html);
    const gzipBytes = zlib.gzipSync(html, { level: 9 }).length;
    assertBudget(`${file} bundle`, bundleBytes, BUDGET.bundle);
    assertBudget(`${file} gzip bundle`, gzipBytes, BUDGET.gzip);

    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, html);

    console.log(
        `  ${file}: ${formatKb(bundleBytes)} raw / ${formatKb(gzipBytes)} gzip ` +
        `(favicon ${formatKb(faviconBuffer.length)})`
    );
    console.log(
        `  ${bundle.stylesheet}: ${formatKb(Buffer.byteLength(stylesRaw))} -> ` +
        `${formatKb(Buffer.byteLength(styles))}`
    );
}

fs.mkdirSync(output, { recursive: true });
for (const [file, bundle] of Object.entries(pageBundles)) embedPage(file, bundle);
buildLegalPage();

// Админка — самостоятельная страница без сборки бандла.
fs.copyFileSync(path.join(root, 'admin.html'), path.join(output, 'admin.html'));
console.log(`  admin.html: ${formatKb(fs.statSync(path.join(output, 'admin.html')).size)}`);

console.log(`Static deploy bundle created: ${output}`);
