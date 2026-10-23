// Shared cache-first TTS client for the navigator and route editor.
(function () {
    if (window.NavigatorTTS) return;

    const API_URL = 'https://functions.yandexcloud.net/d4e3cj3q3ff36qlrhbg8';
    const BUCKET_URL = 'https://storage.yandexcloud.net/eia-tts';
    const VOLUME = '+30%';
    const VOICES = {
        command: { voice: 'ru-RU-DmitryNeural', pitch: '-10Hz' },
        comment: { voice: 'ru-RU-SvetlanaNeural', pitch: '+0Hz' }
    };
    const urls = new Map();
    const pending = new Map();

    function cacheKey(text, voiceType) {
        return voiceType + '\0' + text.trim();
    }

    async function objectUrl(text, voiceType) {
        const settings = VOICES[voiceType] || VOICES.command;
        const input = text.trim() + '\0' + settings.voice + '\0' + settings.pitch + '\0' + VOLUME;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return BUCKET_URL + '/v1/' + hash + '.mp3';
    }

    async function existsInBucket(url) {
        const response = await fetch(url, { method: 'HEAD', mode: 'cors' });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error('Audio bucket returned HTTP ' + response.status);
        return true;
    }

    async function synthesize(batches) {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batches: batches })
        });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.audios)) {
            throw new Error(result.error || 'TTS function returned HTTP ' + response.status);
        }
        result.audios.forEach(audio => {
            if (audio && audio.text && audio.url) {
                urls.set(cacheKey(audio.text, audio.voice_type), audio.url);
            }
        });
    }

    async function resolve(text, voiceType) {
        const cleanText = String(text || '').trim();
        if (!cleanText) return null;
        const type = VOICES[voiceType] ? voiceType : 'command';
        const key = cacheKey(cleanText, type);
        if (urls.has(key)) return urls.get(key);
        if (pending.has(key)) return pending.get(key);

        const task = (async () => {
            const url = await objectUrl(cleanText, type);
            if (await existsInBucket(url)) {
                urls.set(key, url);
                return url;
            }
            await synthesize([{ voice_type: type, texts: [cleanText] }]);
            const generated = urls.get(key);
            if (!generated) throw new Error('TTS function did not return the generated audio URL');
            return generated;
        })();
        pending.set(key, task);
        try {
            return await task;
        } finally {
            pending.delete(key);
        }
    }

    async function preload(batches) {
        const missing = { command: new Set(), comment: new Set() };
        const checks = [];
        batches.forEach(batch => {
            const type = VOICES[batch.voice_type] ? batch.voice_type : 'command';
            (batch.texts || []).forEach(value => {
                const text = String(value || '').trim();
                if (!text || urls.has(cacheKey(text, type))) return;
                checks.push({ text: text, type: type });
            });
        });

        await Promise.all(checks.map(async item => {
            const key = cacheKey(item.text, item.type);
            if (urls.has(key)) return;
            if (pending.has(key)) {
                await pending.get(key);
                return;
            }
            const url = await objectUrl(item.text, item.type);
            if (await existsInBucket(url)) urls.set(key, url);
            else missing[item.type].add(item.text);
        }));

        const missingBatches = Object.keys(missing)
            .filter(type => missing[type].size)
            .map(type => ({ voice_type: type, texts: Array.from(missing[type]) }));
        if (missingBatches.length) await synthesize(missingBatches);
    }

    window.NavigatorTTS = {
        getAudioUrl: resolve,
        preload: preload,
        has: (text, type) => urls.has(cacheKey(String(text || '').trim(), type || 'command'))
    };
})();
