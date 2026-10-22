// padtext.js — модуль текстовых надписей на карте.
//
// Вынесен из pad.html. Вся логика, связанная с установкой текста,
// хранится здесь: состояние (textMode, textItems, textEditing) и функции.
//
// Модуль использует внешние глобалы основного скрипта (map, commit,
// drawMode, eraserMode, appBehaviors, setActiveCar, setMarkersDraggable,
// setHandlesVisible, selectedPic), которые объявлены в pad.html ранее.
// Поскольку классические скрипты в документе разделяют глобальную
// лексическую среду, эти имена доступны здесь напрямую.

let textMode = false;
let textItems = [];
let textEditing = null;

// Флаг «тап по текстовой метке» — выставляется на фазе перехвата pointerdown,
// чтобы глобальный слушатель карты не закрывал панель/активность текста
// при тапе по самому тексту (иначе каждый тап деактивирует метку).
window._textTapPointer = false;
document.addEventListener('pointerdown', (e) => {
    window._textTapPointer = !!(e.target && e.target.closest && e.target.closest('.text-item'));
}, true);

// Размер текста фиксирован в пикселях экрана — не зависит от масштаба карты.
const TEXT_FONT_SIZE_PX = 16;
// Ширина свёрнутой иконки «T» в метрах — одинакова на карте при любом масштабе.
const TEXT_BADGE_WIDTH_M = 3;

function startTextMode() {
    textMode = true;
    setActiveCar(null);
    setMarkersDraggable(false);
    setHandlesVisible(false);
    document.getElementById('textBtn').classList.add('active');
    document.querySelectorAll('.pic-item').forEach(c => c.classList.remove('active'));
    selectedPic = null;
    document.getElementById('colorPanel').classList.remove('visible');
    document.getElementById('widthSlider').classList.remove('visible');
    map.update({ behaviors: [] });
}

function stopTextMode() {
    textMode = false;
    commitTextEditing();
    setMarkersDraggable(true);
    setHandlesVisible(true);
    document.getElementById('textBtn').classList.remove('active');
    map.update({ behaviors: appBehaviors });
}

// Создание YMapMarker-маркера с полем ввода внутри
function makeTextMarker(lat, lon, ta, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'text-item';
    const badge = document.createElement('span');
    badge.className = 'text-badge';
    badge.textContent = 'T';
    el.appendChild(ta);
    el.appendChild(badge);
    const marker = new ymaps3.YMapMarker({
        coordinates: [lon, lat],
        onDragMove: (coords) => {
            marker._lat = coords[1];
            marker._lon = coords[0];
        },
        onDragEnd: () => { if (opts.onDragEnd) opts.onDragEnd(); else if (window.commit) window.commit(); }
    }, el);
    marker._lat = lat;
    marker._lon = lon;
    marker._select = el;
    marker._ta = ta;
    marker._dragEnabled = false; // режим перетаскивания выключен по умолчанию
    setupTextLongPress(marker);
    return marker;
}

// Тап по установленному (fixed) тексту: вне режима перетаскивания тап (драг < 10px)
// сворачивает/разворачивает в иконку «T»; если палец двигался больше — просто
// перетаскивается карта. В режиме перетаскивания (_dragEnabled) — только перемещение.
function setupTextLongPress(marker) {
    const el = marker._select;
    if (marker._timed) return; // временные надписи редактируются перетаскиванием, не длинным нажатием
    const MOVE_TOL = 10; // перемещение пальца (px), начиная с которого считаем тап драгом карты
    let downX = 0, downY = 0;
    el.addEventListener('pointerdown', (e) => {
        downX = e.clientX; downY = e.clientY;
        if (marker._fixed && !textEditing) {
            if (window.setActiveText) window.setActiveText(marker);
        }
    });
    el.addEventListener('pointerup', (e) => {
        if (marker._fixed && !textEditing) setTextDragEnabled(marker, marker._dragEnabled);
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY) > MOVE_TOL;
        if (marker._fixed && !textEditing && !marker._dragEnabled && !moved) {
            toggleTextCollapse(marker);
            syncTextPanel();
        }
    });
}

// Сворачивание/разворачивание установленного текста в квадратную иконку «T»
function toggleTextCollapse(marker) {
    const el = marker._select;
    if (!el) return;
    el.classList.toggle('collapsed');
    if (!el.classList.contains('collapsed') && marker._ta) {
        scheduleTextResize(marker);
    }
}

// Вход в режим редактирования установленного текста
function startEditingText(marker) {
    if (textEditing) commitTextEditing();
    const ta = marker._ta;
    if (!ta) return;
    textMode = true;
    document.getElementById('textBtn').classList.add('active');
    map.update({ behaviors: [] }, 0);
    marker._fixed = false;
    marker.update({ draggable: false });
    marker._select.classList.remove('fixed');
    marker._select.classList.remove('collapsed');
    ta.classList.remove('empty');
    ta.setAttribute('contenteditable', 'true');
    textEditing = { marker, ta };
    positionTextMarker(marker);
    scheduleTextResize(marker);
    requestAnimationFrame(() => {
        if (!textEditing || textEditing.marker !== marker) return;
        ta.focus();
        const r = window.getSelection();
        if (r) { r.selectAllChildren(ta); r.collapseToEnd(); }
        try { ta.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    });
}

// Восстановление сохранённого текста (readonly)
function buildTextItem(lat, lon, text, collapsed) {
    const ta = document.createElement('div');
    ta.className = 'text-input';
    ta.setAttribute('contenteditable', 'false');
    ta.textContent = text || '';
    const marker = makeTextMarker(lat, lon, ta);
    marker._fixed = true;
    marker.update({ draggable: false });
    marker._select.classList.add('fixed');
    positionTextMarker(marker);
    resizeTa(marker);
    if (collapsed) marker._select.classList.add('collapsed');
    return marker;
}

// Размещение нового текстового поля на карте по координатам касания
function placeTextField(lat, lon) {
    if (textEditing) commitTextEditing();
    const ta = document.createElement('div');
    ta.className = 'text-input empty';
    ta.setAttribute('contenteditable', 'true');
    ta.setAttribute('role', 'textbox');
    ta.setAttribute('aria-label', 'Текст');
    ta.setAttribute('data-placeholder', 'Введите текст…');
    ta.spellcheck = false;
    const marker = makeTextMarker(lat, lon, ta);
    // Пока поле редактируется — маркер не должен перетаскиваться и перехватывать фокус
    marker.update({ draggable: false });
    const syncEmpty = () => ta.classList.toggle('empty', !(ta.textContent || '').trim());
    ta.addEventListener('input', () => { syncEmpty(); scheduleTextResize(marker); });

    // Enter — перенос строки (поле продолжает расти); Escape — отмена без сохранения.
    ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertLineBreak');
            syncEmpty();
            scheduleTextResize(marker);
        } else if (e.key === 'Escape') {
            commitTextEditing();
        }
    });

    ta.addEventListener('paste', () => setTimeout(() => { syncEmpty(); scheduleTextResize(marker); }, 0));

    // Касание/клик по полю — продолжить редактирование; не даём маркеру начать драг
    marker._select.addEventListener('pointerdown', (e) => {
        const onText = e.target === ta || ta.contains(e.target);
        if (onText && !marker._fixed) {
            // редактируем поле — не начинаем драг, даём браузеру открыть клавиатуру и фокус
            e.stopPropagation();
            return;
        }
        if (drawMode || eraserMode || textMode) e.preventDefault();
    });

    map.addChild(marker);
    textItems.push(marker);
    textEditing = { marker, ta };
    positionTextMarker(marker);
    // Синхронный фокус — в этом же жесте pointerdown, чтобы мобильная клавиатура
    // гарантированно открылась (программный focus в rAF/timer клавиатуру не поднимает).
    try { ta.focus(); } catch (e) {}
    const sr = window.getSelection();
    if (sr) { sr.selectAllChildren(ta); sr.collapseToEnd(); }
    // Коррекция каретки и скролл к полю после первой отрисовки
    requestAnimationFrame(() => {
        if (!textEditing || textEditing.marker !== marker) return;
        try { ta.focus(); } catch (e) {}
        const r = window.getSelection();
        if (r) {
            r.selectAllChildren(ta);
            r.collapseToEnd();
        }
        try { ta.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    });
    scheduleTextResize(marker);
}

// Позиционирование/размер текстового поля — фиксированный экранный размер,
// не зависит от масштаба карты. Маркер остаётся привязанным к своей гео-точке.
function positionTextMarker(marker) {
    const el = marker._select;
    if (!el) return;
    el.style.fontSize = TEXT_FONT_SIZE_PX + 'px';
    // Свёрнутая иконка «T» — фиксированные 5 метров в ширину на карте.
    resizeTextBadge(marker);
}

// Размер свёрнутой иконки «T» по метрам: квадрат 5 м x 5 м в любом масштабе.
function resizeTextBadge(marker) {
    const el = marker._select;
    if (!el) return;
    const badge = el.querySelector('.text-badge');
    if (!badge) return;
    if (typeof metersPerPixel !== 'function' || !marker._lat) return;
    const mpp = metersPerPixel(marker._lat);
    if (!mpp || !isFinite(mpp)) return;
    const px = Math.max(10, TEXT_BADGE_WIDTH_M / mpp);
    badge.style.width = px + 'px';
    badge.style.height = px + 'px';
    badge.style.borderRadius = (px * 0.2) + 'px';
    badge.style.fontSize = (px * 0.55) + 'px';
}

function positionAllText() {
    textItems.forEach(positionTextMarker);
    if (textEditing) scheduleTextResize(textEditing.marker);
}

// Пересчёт высоты поля под содержимое (ширину текст-поле задаёт само, по содержимому)
function resizeTa(marker) {
    const ta = marker._ta;
    if (!ta) return;
    ta.style.height = 'auto';
    if (ta.scrollHeight > 0) ta.style.height = ta.scrollHeight + 'px';
}

// Перенос строк: текст растёт до максимальной ширины экрана, затем переносится
function scheduleTextResize(marker) {
    const ta = marker._ta;
    if (!ta) return;
    clearTimeout(marker._rzTimer);
    marker._rzTimer = setTimeout(() => resizeTa(marker), 30);
}

// Фиксация текста: редактирование завершено, поле остаётся на карте
function commitTextEditing() {
    if (!textEditing) return;
    const { marker, ta } = textEditing;
    textEditing = null;
    clearTimeout(marker._rzTimer);
    if (!(ta.textContent || '').trim()) {
        removeTextItem(marker);
        commit();
        return;
    }
    marker._fixed = true;
    marker.update({ draggable: false });
    ta.setAttribute('contenteditable', 'false');
    ta.classList.remove('empty');
    marker._select.classList.add('fixed');
    positionTextMarker(marker);
    // После фиксации текста включаем режим перетаскивания (как у знаков/светофоров).
    setTextDragEnabled(marker, true);
    commit();
}

function removeTextItem(marker) {
    if (marker === activeText) closeTextPanel();
    map.removeChild(marker);
    const idx = textItems.indexOf(marker);
    if (idx !== -1) textItems.splice(idx, 1);
    if (textEditing && textEditing.marker === marker) textEditing = null;
}

// ---- Панель выбора текстовой метки (слева вверху, как у знаков/машинок/светофоров) ----
let activeText = null;

function setActiveText(marker) {
    if (activeText && activeText !== marker) {
        // Уходя с метки — выключаем режим перетаскивания (чтобы он не «залипал»).
        activeText._dragEnabled = false;
        activeText.update({ draggable: false });
        if (activeText._select) {
            activeText._select.classList.remove('text-active');
            activeText._select.classList.remove('text-drag');
        }
    }
    activeText = marker || null;
    if (marker && marker._select) marker._select.classList.add('text-active');
    if (marker) setTextDragEnabled(marker, marker._dragEnabled);
    const panel = document.getElementById('textPanel');
    if (!panel) return;
    if (marker) {
        panel.classList.add('visible');
        syncTextPanel();
    } else {
        panel.classList.remove('visible');
    }
}

// Включение/выключение режима перетаскивания текстовой метки:
// кроме draggable переключает визуальное выделение (.text-drag).
function setTextDragEnabled(marker, enabled) {
    if (!marker) return;
    marker._dragEnabled = !!enabled;
    marker.update({ draggable: marker._dragEnabled });
    if (marker._select) marker._select.classList.toggle('text-drag', marker._dragEnabled);
}

function closeTextPanel() {
    setActiveText(null);
}

function syncTextPanel() {
    const panel = document.getElementById('textPanel');
    if (!panel || !activeText) return;
    const cpBtn = document.getElementById('textCollapseBtn');
    if (cpBtn) {
        const collapsed = !!(activeText._select && activeText._select.classList.contains('collapsed'));
        cpBtn.classList.toggle('active', collapsed);
    }
    const dragBtn = document.getElementById('textDragBtn');
    if (dragBtn) dragBtn.classList.toggle('active', !!activeText._dragEnabled);
}

(function initTextPanel() {
    const cb = document.getElementById('textCollapseBtn');
    const eb = document.getElementById('textEditBtn');
    const db = document.getElementById('textDelBtn');
    const drb = document.getElementById('textDragBtn');
    if (cb) cb.addEventListener('click', () => {
        if (!activeText) return;
        toggleTextCollapse(activeText);
        syncTextPanel();
    });
    if (drb) drb.addEventListener('click', () => {
        if (!activeText) return;
        setTextDragEnabled(activeText, !activeText._dragEnabled);
        syncTextPanel();
    });
    if (eb) eb.addEventListener('click', () => {
        if (!activeText) return;
        startEditingText(activeText);
    });
    if (db) db.addEventListener('click', () => {
        if (!activeText) return;
        const m = activeText;
        closeTextPanel();
        removeTextItem(m);
        commit();
    });
})();

window.closeTextPanel = closeTextPanel;
window.setActiveText = setActiveText;
