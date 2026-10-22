// Модуль глобальной записи и циклического воспроизведения движения машинок.
// Подключается ПОСЛЕ основного inline-скрипта pad.html (перед </body>).
// Не меняет основной код.
// Как работает:
//  - кнопка REC (справа внизу): включает режим записи; пока она активна, движение
//    ЛЮБОЙ перетаскиваемой машинки записывается в её собственные сэмплы. Повторное
//    нажатие останавливает запись. Записи машинок НЕ стираются при новом включении
//    REC — можно последовательно записать несколько машинок, а затем запустить все
//    записи одновременно. Тронутая, но не сдвинутая машинка сохраняет старую запись;
//  - кнопка PLAY (справа от REC): запускает все существующие записи синхронно.
//    Внутри одной сессии машинка, начавшая движение позже, «держит» стартовую
//    позицию до момента своего старта; короткие записи держат финальную позицию до
//    конца самой длинной, после чего сценарий повторяется;
//  - запись ВО ВРЕМЯ воспроизведения: если нажать REC, пока PLAY идёт, воспроизведение
//    НЕ останавливается — можно взять новую (не играющую) машинку и записать её
//    движение, подстроившись под цикл. Запись привязывается к фазе цикла, в которой
//    она началась: при запуске всех записей такая машинка «ждёт» своей фазы, а затем
//    движется синхронно с остальными. По окончании записи новая машинка сразу
//    включается в текущее воспроизведение.

(function () {
    if (window.__recPlayLoaded) return;
    window.__recPlayLoaded = true;

    // ---- CSS ----
    const style = document.createElement('style');
    style.textContent = `
        #recAllBtn, #playAllBtn, #stopAllBtn {
            position:fixed; z-index:9005; width:52px; height:52px; border-radius:50%;
            border:0.5px solid rgba(255,255,255,0.12); color:#fff;
            display:flex; align-items:center; justify-content:center; cursor:pointer;
            box-shadow:0 8px 32px rgba(0,0,0,0.3); font-size:13px; font-weight:700; letter-spacing:0.5px; line-height:1; touch-action:manipulation;
        }
        #recAllBtn { right:12px; top:calc(204px + env(safe-area-inset-top) + var(--tg-top, 0px)); background:rgba(255,69,58,0.75); }
        #recAllBtn.active { animation:recPulse 1s ease-in-out infinite; }
        #playAllBtn { right:12px; top:calc(268px + env(safe-area-inset-top) + var(--tg-top, 0px)); background:rgba(15,15,15,0.75); display:none; }
        #playAllBtn.active { animation:recPulse 1s ease-in-out infinite; }
        #stopAllBtn { right:12px; top:calc(332px + env(safe-area-inset-top) + var(--tg-top, 0px)); background:rgba(15,15,15,0.75); }
        #recAllBtn:active, #playAllBtn:active, #stopAllBtn:active { transform:scale(0.92); }
        @keyframes recPulse { 50% { opacity:0.5; } }
        #scrubModal {
            position:fixed; left:0; right:0; bottom:0; max-height:50vh; z-index:9100;
            background:rgba(15,15,15,0.97); color:#fff;
            display:flex; flex-direction:column;
            border-radius:16px 16px 0 0; border-top:0.5px solid rgba(255,255,255,0.12);
            box-shadow:0 -8px 32px rgba(0,0,0,0.4);
            padding-bottom:env(safe-area-inset-bottom);
            transform:translateY(105%); visibility:hidden;
            transition:transform .3s ease, visibility .3s;
        }
        #scrubModal.visible { transform:translateY(0); visibility:visible; }
        .scrub-header {
            display:flex; align-items:center; gap:8px;
            padding:8px 10px; border-bottom:0.5px solid rgba(255,255,255,0.12); flex-shrink:0;
            position:relative;
        }
        .scrub-row .scrub-timewrap { flex:0 0 100%; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 0 6px; }
        .scrub-loop { display:flex; align-items:center; gap:4px; font-size:12px; color:rgba(255,255,255,0.7); flex-shrink:0; }
        .scrub-loop input {
            width:64px; height:27px; padding:0 6px; border-radius:8px; border:0.5px solid rgba(255,255,255,0.18);
            background:rgba(255,255,255,0.08); color:#fff; font-size:14px; text-align:center;
            font-variant-numeric:tabular-nums; outline:none; touch-action:manipulation;
            -webkit-appearance:none; appearance:none; -moz-appearance:textfield;
        }
        .scrub-loop input::-webkit-inner-spin-button,
        .scrub-loop input::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
        .scrub-loop input:focus { border-color:#30D158; }
        .scrub-title {
            position:absolute; left:0; right:0; text-align:center; pointer-events:none;
            font-size:13px; font-weight:600; color:rgba(255,255,255,0.9);
        }
        .scrub-close {
            width:30px; height:30px; border-radius:50%; border:0.5px solid rgba(255,255,255,0.12);
            background:rgba(255,255,255,0.06); color:#fff; font-size:15px; cursor:pointer;
            display:flex; align-items:center; justify-content:center; touch-action:manipulation; flex-shrink:0;
            margin-left:auto; /* всегда прижимаем к правому краю шапки */
        }
        .scrub-close:active { background:rgba(255,255,255,0.15); }
        #scrubBody { flex:1; min-height:0; overflow-y:auto; padding:10px 12px 32px; -webkit-overflow-scrolling:touch; }
        .scrub-row {
            display:flex; align-items:center; gap:6px; padding:10px 8px;
            border-bottom:0.5px solid rgba(255,255,255,0.08);
        }
        .scrub-thumb {
            width:26px; height:26px; object-fit:contain; flex-shrink:0; pointer-events:none;
            border-radius:6px; background:rgba(255,255,255,0.08); padding:2px;
        }
        #scrubConfirm {
            position:fixed; inset:0; z-index:9300; display:flex; align-items:center; justify-content:center;
            background:rgba(0,0,0,0.45); opacity:0; visibility:hidden; transition:opacity .2s ease, visibility .2s;
        }
        #scrubConfirm.visible { opacity:1; visibility:visible; }
        .scrub-confirm-box {
            width:min(300px, 80vw); background:rgba(15,15,15,0.98); border:0.5px solid rgba(255,255,255,0.12);
            border-radius:16px; padding:16px; text-align:center;
            box-shadow:0 16px 48px rgba(0,0,0,0.5);
        }
        .scrub-confirm-btns { display:flex; flex-direction:column; gap:8px; }
        .scrub-confirm-btns .scrub-confirm-btn {
            height:44px; border-radius:12px; border:0.5px solid rgba(255,255,255,0.12);
            background:rgba(255,255,255,0.08); color:#fff; font-size:16px; font-weight:600;
            cursor:pointer; display:flex; align-items:center; justify-content:center; touch-action:manipulation;
        }
        .scrub-confirm-btns .scrub-confirm-btn:active { background:rgba(255,255,255,0.15); }
        .scrub-confirm-btns .scrub-confirm-yes { background:rgba(255,69,58,0.9); border-color:transparent; }
        .scrub-time { flex-shrink:0; font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; }
        /* Полоса времени в стиле полос поворотников: зелёный отрезок во всю высоту трека */
        .scrub-timetrack { cursor:ew-resize; }
        /* Полоса времени занимает всю ширину строки, как секция поворотников */
        .scrub-timeline { flex:0 0 100%; }
        .scrub-active {
            position:absolute; top:2px; bottom:2px; border-radius:4px;
            background:#30D158; opacity:0.9; pointer-events:none;
        }
        .scrub-wait {
            position:absolute; top:2px; bottom:2px; border-radius:4px;
            background:rgba(255,255,255,0.10); pointer-events:none;
        }
        .scrub-empty { padding:24px 12px; font-size:15px; color:rgba(255,255,255,0.55); text-align:center; }
        /* Красная кнопка удаления записи внизу шторки */
        #scrubFooter { padding:8px 12px; flex-shrink:0; }
        #scrubDeleteBtn {
            width:100%; height:44px; border-radius:12px; border:none; flex-shrink:0;
            background:rgba(255,69,58,0.9); color:#fff; font-size:16px; font-weight:600;
            display:flex; align-items:center; justify-content:center; cursor:pointer; touch-action:manipulation;
        }
        #scrubDeleteBtn:active { background:rgba(255,69,58,1); }
        #scrubDeleteBtn.hidden { display:none; }
        .scrub-row { flex-wrap:wrap; }
        /* Линии поворотников всегда раскрыты */
        .scrub-sigsec { flex:0 0 100%; display:block; padding-top:6px; }
        .scrub-sigline { display:flex; align-items:center; gap:6px; padding:3px 0; }
        .scrub-siglabel { flex-shrink:0; width:16px; text-align:center; font-size:14px; color:#FFCC00; }
        .scrub-siglabel.right { color:#FFCC00; }
        .scrub-sigtrack {
            position:relative; flex:1; min-width:0; height:26px; border-radius:6px;
            background:rgba(255,255,255,0.08); cursor:crosshair; touch-action:none; overflow:hidden;
        }
        .sig-seg { position:absolute; top:2px; bottom:2px; border-radius:4px; opacity:0.9; touch-action:none; }
        .sig-seg.sig-seg-left { background:#FFCC00; }
        .sig-seg.sig-seg-right { background:#FFCC00; }
        .sig-seg.sig-draw { opacity:0.45; }
        .sig-h {
            position:absolute; top:0; bottom:0; width:10px; background:rgba(255,255,255,0.9);
            cursor:ew-resize; touch-action:none; z-index:1;
            pointer-events:auto;
        }
        .sig-h::before {
            content:''; position:absolute; top:-7px; bottom:-7px; left:-9px; right:-9px;
        }
        .sig-h.sig-h-s { left:0; border-radius:4px 0 0 4px; }
        .sig-h.sig-h-e { right:0; border-radius:0 4px 4px 0; }
        .sig-del {
            position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:14px; height:14px;
            border-radius:50%; background:rgba(255,69,58,0.95); color:#fff; font-size:9px; line-height:1;
            display:flex; align-items:center; justify-content:center; cursor:pointer; touch-action:none; z-index:2;
        }
        /* ---- Секция временных текстов в шторке записи ---- */
        .scrub-ttsec { flex:0 0 100%; display:block; padding-top:10px; border-top:0.5px solid rgba(255,255,255,0.1); margin-top:4px; }
        .scrub-tt-title { font-size:12px; font-weight:600; color:rgba(255,255,255,0.6); padding:0 2px 6px; }
        .scrub-tt-add { display:flex; align-items:center; gap:6px; padding:2px 0 8px; }
        .scrub-tt-input {
            flex:1; min-width:0; min-height:36px; padding:8px 12px; border-radius:9px;
            border:0.5px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.08);
            color:#fff; font-size:15px; outline:none; touch-action:manipulation; user-select:text; -webkit-user-select:text;
            resize:none; overflow:hidden; line-height:1.35; box-sizing:border-box;
        }
        .scrub-tt-input:focus { border-color:#30D158; }
        .scrub-tt-addbtn {
            height:36px; padding:0 14px; border-radius:9px; border:none; flex-shrink:0;
            background:rgba(48,209,88,0.9); color:#000; font-size:14px; font-weight:600; cursor:pointer; touch-action:manipulation;
        }
        .scrub-tt-addbtn:active { background:rgba(48,209,88,1); transform:scale(0.97); }
        .scrub-tt-item {
            display:flex; flex-direction:column; gap:4px; padding:8px; margin-bottom:6px;
            border-radius:10px; background:rgba(255,255,255,0.05); border:0.5px solid rgba(255,255,255,0.08);
        }
        .scrub-tt-head { display:flex; align-items:center; gap:8px; }
        .scrub-tt-text {
            flex:1; min-width:0; font-size:13px; color:rgba(255,255,255,0.9); word-break:break-word;
            white-space:pre-wrap; line-height:1.3;
        }
        .scrub-tt-text.empty { color:rgba(255,255,255,0.35); font-style:italic; }
        .scrub-tt-del {
            width:30px; height:30px; border-radius:8px; border:none; flex-shrink:0;
            background:rgba(255,69,58,0.85); color:#fff; font-size:12px; cursor:pointer; touch-action:manipulation;
        }
        .scrub-tt-del:active { background:rgba(255,69,58,1); }
        .scrub-tt-line { display:flex; align-items:center; gap:6px; }
        .scrub-tt-label { flex-shrink:0; width:16px; text-align:center; font-size:13px; color:#30D158; }
        .scrub-tttrack {
            position:relative; flex:1; min-width:0; height:26px; border-radius:6px;
            background:rgba(255,255,255,0.08); cursor:crosshair; touch-action:none; overflow:hidden;
        }
        .tt-visible {
            position:absolute; top:2px; bottom:2px; border-radius:4px;
            background:#30D158; opacity:0.9; pointer-events:none;
        }
        .tt-none { position:absolute; top:0; bottom:0; background:rgba(255,255,255,0.04); pointer-events:none; }
        /* Маркер временной надписи на карте (не редактируется, не таскается) */
        .timed-text { opacity:0; pointer-events:none; }
        .timed-text.visible { opacity:1; }
        .timed-text.visible.tt-draggable { pointer-events:auto; cursor:move; }
        .timed-text .text-input { background:rgba(30,30,30,0.15); color:#fff; border:1px solid rgba(255,255,255,0.9); text-shadow:0 1px 2px rgba(0,0,0,0.6); }
        /* Подсказка при выборе места на карте */
        #ttHint {
            position:fixed; top:calc(12px + env(safe-area-inset-top) + var(--tg-top, 0px)); left:50%; transform:translateX(-50%);
            z-index:9400; padding:8px 10px 8px 20px; border-radius:22px; font-size:14px; font-weight:600; color:#fff;
            background:rgba(15,15,15,0.9); border:0.5px solid rgba(48,209,88,0.6); box-shadow:0 8px 24px rgba(0,0,0,0.4);
            pointer-events:none; white-space:nowrap; display:none;
        }
        #ttHint.visible { display:flex; align-items:center; gap:10px; }
        #ttHint.qhidden { display:none !important; }
        .tt-hint-cancel {
            width:28px; height:28px; border-radius:50%; border:0.5px solid rgba(255,255,255,0.25); flex-shrink:0;
            background:rgba(255,255,255,0.12); color:#fff; font-size:13px; cursor:pointer; pointer-events:auto; touch-action:manipulation;
            display:flex; align-items:center; justify-content:center;
        }
        .tt-hint-cancel:active { background:rgba(255,255,255,0.25); }
    `;
    document.head.appendChild(style);

    // SVG-иконки кнопки PLAY/STOP
    const ICON_PLAY = '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M7.5 4.2v15.6L20.5 12z"/></svg>';
    const ICON_STOP = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><rect x="5.5" y="4.5" width="5.5" height="15" rx="1.5"/><rect x="13" y="4.5" width="5.5" height="15" rx="1.5"/></svg>';
    const ICON_STOP_SQUARE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';

    const recAllBtn = document.createElement('div');
    recAllBtn.id = 'recAllBtn';
    recAllBtn.innerHTML = 'REC';
    document.body.appendChild(recAllBtn);

    const playAllBtn = document.createElement('div');
    playAllBtn.id = 'playAllBtn';
    playAllBtn.innerHTML = ICON_PLAY;
    document.body.appendChild(playAllBtn);

    const stopAllBtn = document.createElement('div');
    stopAllBtn.id = 'stopAllBtn';
    stopAllBtn.innerHTML = ICON_STOP_SQUARE;
    stopAllBtn.style.display = 'none';
    document.body.appendChild(stopAllBtn);

    // ---- Состояние ----
    let _recOn = false;          // глобальная запись активна
    let _recRaf = null;          // rAF сэмплирования
    let _recStart = 0;           // старт сессии записи (обычный режим)
    let _playAll = false;        // глобальное воспроизведение активно
    let _masterRaf = null;
    let _masterStart = 0;
    let _paused = false;         // общее воспроизведение стоит на паузе (позиция сохранена)
    let _pauseStart = 0;         // момент перехода в паузу (для сдвига часов при resume)
    let _maxDur = 1;
    let _playingSingle = null;   // машинка, проигрываемая одиночно с панели
    let _scrubOpen = false;
    let _confirmMarker = null;
    let _scrubMarker = null; // машинка, для которой открыта панель записи

    // ---- Временные текстовые надписи ----
    let _ttSeq = 1;                      // генератор id
    let _placeTextMode = false;          // идёт выбор места на карте
    let _pendingText = null;             // { marker, text, t0 } — что ставим
    let _ttMarkerSeq = 1;                // id DOM-метки для marker._ttEls
    let _ttHint = null;                  // элемент подсказки
    const MINTRY_MS = 150;               // минимальная длина интервала видимости текста, мс

    const scrubModal = document.createElement('div');
    scrubModal.id = 'scrubModal';
    const scrubHeader = document.createElement('div');
    scrubHeader.className = 'scrub-header';
    const scrubClose = document.createElement('div');
    scrubClose.className = 'scrub-close';
    scrubClose.textContent = '✕';
    // Заголовок «Запись» + иконка машинки слева от времени в теле шторки
    const scrubTitle = document.createElement('div');
    scrubTitle.className = 'scrub-title';
    scrubTitle.textContent = 'Запись';
    const scrubThumb = document.createElement('img');
    scrubThumb.className = 'scrub-thumb';
    const scrubTime = document.createElement('div');
    scrubTime.className = 'scrub-time';
    scrubHeader.appendChild(scrubTitle);
    scrubHeader.appendChild(scrubClose);
    scrubThumb.style.display = 'none';
    const scrubBody = document.createElement('div');
    scrubBody.id = 'scrubBody';
    const scrubFooter = document.createElement('div');
    scrubFooter.id = 'scrubFooter';
    const scrubDeleteBtn = document.createElement('div');
    scrubDeleteBtn.id = 'scrubDeleteBtn';
    scrubDeleteBtn.textContent = 'Удалить запись';
    scrubDeleteBtn.classList.add('hidden');
    scrubDeleteBtn.addEventListener('click', () => { if (_scrubMarker) showConfirm(_scrubMarker); });
    scrubFooter.appendChild(scrubDeleteBtn);
    scrubModal.appendChild(scrubHeader);
    scrubModal.appendChild(scrubBody);
    scrubModal.appendChild(scrubFooter);
    document.body.appendChild(scrubModal);
    const confirmModal = document.createElement('div');
    confirmModal.id = 'scrubConfirm';
    const confirmBox = document.createElement('div');
    confirmBox.className = 'scrub-confirm-box';
    const confirmBtns = document.createElement('div');
    confirmBtns.className = 'scrub-confirm-btns';
    const confirmYes = document.createElement('div');
    confirmYes.className = 'scrub-confirm-btn scrub-confirm-yes';
    confirmYes.textContent = 'Удалить';
    const confirmNo = document.createElement('div');
    confirmNo.className = 'scrub-confirm-btn';
    confirmNo.textContent = 'Отмена';
    confirmBtns.appendChild(confirmYes);
    confirmBtns.appendChild(confirmNo);
    confirmBox.appendChild(confirmBtns);
    confirmModal.appendChild(confirmBox);
    document.body.appendChild(confirmModal);

    // Подсказка при выборе места на карте для текста
    _ttHint = document.createElement('div');
    _ttHint.id = 'ttHint';
    const hintTxt = document.createElement('span');
    hintTxt.textContent = 'Коснитесь карты, чтобы поставить текст';
    const hintCancel = document.createElement('button');
    hintCancel.className = 'tt-hint-cancel';
    hintCancel.textContent = '✕';
    hintCancel.title = 'Отмена';
    hintCancel.addEventListener('pointerdown', e => e.stopPropagation());
    hintCancel.addEventListener('click', e => { e.stopPropagation(); cancelPlaceText(); });
    _ttHint.appendChild(hintTxt);
    _ttHint.appendChild(hintCancel);
    document.body.appendChild(_ttHint);

    // ---- Утилиты ----
    function lerpAngle(a, b, t) {
        let d = ((b - a + 180) % 360 + 360) % 360 - 180;
        return a + d * t;
    }

    function hasMovement(m) {
        if (m._isTl) return false; // светофоры не двигаются — только лампы
        const s = m._samples;
        if (!s || s.length < 2) return false;
        const p = s[0];
        return s.some(x =>
            Math.abs(x.lat - p.lat) > 1e-9 ||
            Math.abs(x.lon - p.lon) > 1e-9 ||
            Math.abs(x.heading - p.heading) > 1e-6
        );
    }

    function playables() {
        return placedMarkers.filter(hasMovement);
    }

    // Есть ли у светофора запись переключений ламп
    function hasTlRec(m) {
        return !!(m._isTl && m._tlRec && m._tlRec.length);
    }

    // Светофоры с записью ламп, ещё не включённые в воспроизведение
    function tlRecMarkers() {
        return placedMarkers.filter(m => !m._playing && hasTlRec(m));
    }

    function startTrim(m) { return m._startTrim || 0; }

    function endTrim(m) {
        if (m._endTrim != null) return m._endTrim;
        return (m._samples && m._samples.length) ? m._samples[m._samples.length - 1].t : 0;
    }

    function endPhase(m) {
        if (m._isTl && m._tlRec && m._tlRec.length) {
            return (m._phaseOffset || 0) + m._tlRec[m._tlRec.length - 1].t;
        }
        if (!m._samples || m._samples.length < 2) return 0;
        return (m._phaseOffset || 0) + (endTrim(m) - startTrim(m));
    }

    function signalAt(marker, t) {
        const s = marker._signals;
        if (!s) return [];
        const out = [];
        for (const seg of s) {
            if (t >= seg.t0 && t <= seg.t1 && out.indexOf(seg.side) === -1) out.push(seg.side);
        }
        return out;
    }

    function applySignal(marker, sides) {
        let L = false, R = false;
        if (Array.isArray(sides)) { L = sides.indexOf('left') !== -1; R = sides.indexOf('right') !== -1; }
        else if (sides === 'left') L = true;
        else if (sides === 'right') R = true;
        const newSide = (L && R) ? 'both' : L ? 'left' : R ? 'right' : null;
        if (newSide !== marker._blinkSide) marker._blinkSince = performance.now();
        marker._blinkSide = newSide;
        if (!marker._rotWrap) return;
        const both = L && R;
        if (!L && !R) marker._rotWrap.classList.remove('blink-on');
        marker._rotWrap.classList.toggle('signal-both', both);
        marker._rotWrap.classList.toggle('signal-left', L && !both);
        marker._rotWrap.classList.toggle('signal-right', R && !both);
        if (marker._leftBtn) marker._leftBtn.classList.toggle('active', L);
        if (marker._rightBtn) marker._rightBtn.classList.toggle('active', R);
    }

    function maxDurOf(cars) {
        return Math.max.apply(null, cars.map(endPhase).concat(1)) || 1;
    }

    // Длительность цикла машинки (мс): заданное поле или общий период воспроизведения.
    function loopDur(m) {
        return (m._loopMs != null && m._loopMs > 0) ? m._loopMs : _maxDur;
    }

    // Самая длинная запись на сцене — значение цикла по умолчанию.
    function loopDefaultMs() {
        return maxDurOf(playables().concat(tlRecMarkers()));
    }

    // Актуальный цикл машинки для UI/отображения (если не задан — самая длинная запись).
    function loopMsOf(m) {
        return (m._loopMs != null && m._loopMs > 0) ? m._loopMs : loopDefaultMs();
    }

    // Применить состояние машинки на момент времени elapsed (мс) цикла.
    // Отрезок записи [startTrim, endTrim] заполняет собой весь цикл машинки:
    // на elapsed=0 машинка находится в точке startTrim и движется к endTrim к концу
    // своего отрезка, затем цикл повторяется — без паузы перед перезапуском.
    // Для машинок, записанных во время воспроизведения (phaseOffset > 0), движение
    // начинается с фазы phaseOffset и до неё машинка держит позицию startTrim.
    function sampleAt(marker, elapsed) {
        const s = marker._samples;
        if (!s || s.length < 2) return;
        const st = startTrim(marker);
        const et = endTrim(marker);
        let e = st + (elapsed - (marker._phaseOffset || 0));
        if (e < st) e = st;
        else if (e > et) e = et;
        const t0 = s[0].t;
        const t1 = s[s.length - 1].t;
        if (e < t0) e = t0;
        else if (e > t1) e = t1;
        let i = 1;
        while (i < s.length - 1 && s[i].t < e) i++;
        const a = s[i - 1], b = s[i];
        const seg = (b.t - a.t) || 1;
        const t = Math.max(0, Math.min(1, (e - a.t) / seg));
        marker._lat = a.lat + (b.lat - a.lat) * t;
        marker._lon = a.lon + (b.lon - a.lon) * t;
        marker._heading = lerpAngle(a.heading, b.heading, t);
        applySignal(marker, signalAt(marker, e));
    }

    // Применение рассчитанной в sampleAt позиции к маркеру на карте.
    // Вынесено отдельно, чтобы viewport culling мог пропускать дорогой
    // marker.update({coordinates}) для машинок за пределами экрана.
    function applyPosition(marker) {
        marker.update({ coordinates: [marker._lon, marker._lat] });
        if (typeof window.updatePicTransform === 'function') window.updatePicTransform(marker);
        else updatePicMarker(marker);
    }

    // Применить состояние ламп светофора на момент времени elapsed (мс) цикла:
    // стартуем из состояния на момент записи (_tlInit) и проигрываем переключения.
    function applyTlAt(marker, elapsed) {
        const recs = marker._tlRec;
        if (!recs || !recs.length) return;
        const e = elapsed - (marker._phaseOffset || 0);
        const MAIN = ['red', 'yellow', 'green'];
        const st = { red: false, yellow: false, green: false, left: false, right: false };
        const init = marker._tlInit;
        if (init) for (const k in init) st[k] = !!init[k];
        for (const r of recs) {
            if (r.t > e) break;
            st[r.key] = !!r.on;
            if (r.on && MAIN.indexOf(r.key) !== -1) {
                MAIN.forEach(k => { if (k !== r.key) st[k] = false; });
            }
        }
        for (const k in st) {
            if (st[k] !== marker._lampState[k] && window.tlSetLamp) window.tlSetLamp(marker, k, st[k]);
        }
    }


    // ---- Запись ----
    // Частота сэмплов: ~10 кадров/с (100 мс), чтобы уменьшить размер записи.
    // Воспроизведение интерполирует между сэмплами линейно, поэтому плавность не страдает.
    const SAMPLE_INTERVAL_MS = 100;
    // Текущее время записи на шкале машинки. При записи во время воспроизведения это
    // фаза мастер-цикла, сдвинутая на _phaseOffset (с развёрткой через границу цикла);
    // при обычной записи — секунды от начала сессии. Единая шкала для сэмплов движения
    // и поворотников, чтобы они всегда попадали точно в свои места.
    function relTime(marker) {
        if (_playAll) {
            const phase = (performance.now() - _masterStart) % loopDur(marker);
            // Паузы (стилус убран) накапливаются в _pausePhase и вычитаются из фазовой
            // шкалы цикла, чтобы продолжение записи во время воспроизведения не прыгало
            // во времени и паузы выпадали, как при обычной записи.
            let t = phase - (marker._phaseOffset || 0) - (marker._pausePhase || 0);
            if (marker._lastRel != null && t < marker._lastRel) t += loopDur(marker);
            marker._lastRel = t;
            return t;
        }
        // Паузы (стилус убран с машинки) вычитаются из общей шкалы, чтобы время записи
        // машинки шло только пока её двигают/удерживают. Учитываются и завершённые
        // паузы (_pauseAcc), и текущая открытая пауза (_pauseFrom), чтобы шкала
        // замирала прямо во время паузы, а не только после её закрытия.
        const open = (marker._pauseFrom != null && marker._stylusOn === false)
            ? (performance.now() - marker._pauseFrom) : 0;
        return performance.now() - _recStart - (marker._pauseAcc || 0) - open;
    }

    function recFrame() {
        if (!_recOn) { _recRaf = null; return; }
        placedMarkers.forEach(m => {
            if (!m._recActive || m._isTl) return; // светофоры не сэмплируются по движению
            // Пока стилус убран с машинки (пауза) — сэмплы не пишем: время машинки
            // заморожено (см. relTime), движение запишется только во время касания.
            if (m._stylusOn === false) return;
            const t = relTime(m);
            if (m._lastSampleT == null || t - m._lastSampleT >= SAMPLE_INTERVAL_MS) {
                m._samples.push({ t: Math.round(t), lat: m._lat, lon: m._lon, heading: m._heading });
                m._lastSampleT = t;
            }
        });
        _recRaf = requestAnimationFrame(recFrame);
    }

    // ---- Запись поворотников ----
    // Пока идёт запись (REC), переключение поворотников (setBlink/setHazard)
    // записывается в marker._signals как отрезки {t0, t1, side} — так же,
    // как их рисуют вручную в редакторе перемотки.
    function recSignalTime(marker) {
        return relTime(marker);
    }

    function closeRecSig(marker, side, tEnd) {
        const open = marker._recSigOpen;
        if (!open || open[side] == null) return;
        const t0 = open[side];
        open[side] = null;
        marker._signals = marker._signals || [];
        marker._signals.push({ t0: t0, t1: Math.max(t0 + 50, tEnd), side: side });
        marker._signals.sort((a, b) => a.t0 - b.t0);
    }

    function recordSignalChange(marker) {
        // Поворотники пишем только у машинок, реально записываемых в этой сессии
        // (тронуты после старта REC). У остальных — например, проигрывающихся —
        // состояние сигнала не должно попадать в чужую запись.
        if (!_recOn || !marker || marker._isTl || !marker._recActive) return;
        const L = marker._blinkSide === 'left' || marker._blinkSide === 'both';
        const R = marker._blinkSide === 'right' || marker._blinkSide === 'both';
        const t = Math.max(0, recSignalTime(marker));
        const open = marker._recSigOpen || (marker._recSigOpen = { left: null, right: null });
        [['left', L], ['right', R]].forEach(p => {
            const side = p[0], want = p[1];
            if (want && open[side] == null) open[side] = t;
            else if (!want && open[side] != null) closeRecSig(marker, side, t);
        });
    }

    function closeAllRecSigs(marker, tEnd) {
        if (!marker._recSigOpen) return;
        closeRecSig(marker, 'left', tEnd);
        closeRecSig(marker, 'right', tEnd);
        marker._recSigOpen = undefined;
    }

    // Запись переключений ламп светофора: пока активен REC, каждое нажатие на лампу
    // фиксируется в marker._tlRec как {t, key, on}. Хук вызывается из setLamp
    // (trafficlights.js), т.е. ловит все пути изменения ламп.
    function recordTlLamp(marker, key, on) {
        if (!_recOn || !marker || !marker._isTl || marker._playing) return;
        if (_playAll && marker._phaseOffset == null) {
            marker._phaseOffset = (performance.now() - _masterStart) % loopDur(marker);
        }
        if (marker._tlInit == null) {
            marker._tlInit = {};
            ['red', 'yellow', 'green', 'left', 'right'].forEach(k => marker._tlInit[k] = !!marker._lampState[k]);
        }
        marker._tlRec = marker._tlRec || [];
        marker._tlRec.push({ t: Math.round(Math.max(0, recSignalTime(marker))), key: key, on: !!on });
    }
    window.onTlLampChange = recordTlLamp;

    // Оборачиваем переключение поворотников
    const origSetBlink = window.setBlink;
    const origSetHazard = window.setHazard;
    window.setBlink = function (marker, side) {
        origSetBlink(marker, side);
        recordSignalChange(marker);
    };
    window.setHazard = function (marker) {
        origSetHazard(marker);
        recordSignalChange(marker);
    };

    function stopRec() {
        if (!_recOn) return;
        _recOn = false;
        if (_recRaf) cancelAnimationFrame(_recRaf);
        _recRaf = null;
        placedMarkers.forEach(m => {
            // Закрываем незавершённую паузу, чтобы она не росла после остановки записи.
            closePause(m);
            if (!m._recActive) { m._prevSamples = undefined; return; }
            // Конец на собственной шкале машинки (а не _maxDur/времени сессии):
            // при записи во время воспроизведения шкала сдвинута на _phaseOffset.
            const tEnd = Math.round(relTime(m));
            closeAllRecSigs(m, tEnd);
            if (m._prevSamples && !hasMovement(m)) {
                m._samples = m._prevSamples; // тронули, но не сдвинули — вернуть старую запись
            } else if (hasMovement(m)) {
                // Финальная точка с текущим положением — чтобы endTrim/последний t были точными
                m._samples.push({ t: tEnd, lat: m._lat, lon: m._lon, heading: m._heading });
                m._startTrim = 0;      // свежая запись — диапазон целиком
                m._endTrim = undefined;
            }
            m._prevSamples = undefined;
        });
        if (_playAll) joinRecordedToPlay();
        updateRecBtn();
        updatePlayAllBtn();
        // После завершения записи обновляем панель машинки — там появится кнопка воспроизведения.
        if (window.updateSignalBtns) window.updateSignalBtns();
    }

    function toggleRec() {
        cancelPlaceText();
        if (_recOn) {
            stopRec();
        } else {
            placedMarkers.forEach(m => { m._recActive = false; m._prevSamples = undefined; m._lastRel = 0; m._lastSampleT = undefined; m._recSigOpen = undefined; m._stylusOn = false; m._activePtr = null; m._pauseAcc = 0; m._pausePhase = 0; m._pauseFrom = null; });
            // Новая сессия записи: у светофоров обнуляем запись ламп (движение не пишется)
            placedMarkers.forEach(m => {
                if (m._isTl && !m._playing) { m._tlRec = []; m._tlInit = null; m._phaseOffset = 0; }
            });
            _recOn = true;
            _recStart = performance.now();
            _recRaf = requestAnimationFrame(recFrame);
            updateRecBtn();
            updatePlayAllBtn();
        }
    }

    // Активируем машинку в текущей сессии при касании её (кроме кнопок панели)
    window.addEventListener('pointerdown', e => {
        if (!_recOn) return;
        const t = e.target;
        if (!t || !t.closest) return;
        const markerEl = t.closest('.pic-marker');
        if (!markerEl) return;
        const marker = placedMarkers.find(m => m._select === markerEl);
        if (marker && !marker._recActive && !marker._isTl) {
            marker._recActive = true;
            marker._prevSamples = marker._samples;
            marker._samples = [];
            marker._signals = [];
            marker._lastRel = 0;
            marker._recSigOpen = { left: null, right: null };
            if (_playAll) {
                marker._phaseOffset = (performance.now() - _masterStart) % loopDur(marker);
                marker._lastSampleT = 0;
                marker._samples.push({ t: 0, lat: marker._lat, lon: marker._lon, heading: marker._heading });
            } else {
                marker._phaseOffset = 0;
                marker._lastSampleT = performance.now() - _recStart;
                marker._samples.push({ t: marker._lastSampleT, lat: marker._lat, lon: marker._lon, heading: marker._heading });
            }
            // Поворотники, включённые ещё до касания, пишем с начала записи машинки
            recordSignalChange(marker);
        }
    }, true);

    // ---- Паузы записи при убранном стилусе ----
    // Пока стилус убран с машинки (или идёт перетаскивание карты без касания машинки),
    // шкала времени этой машинки «замораживается»: время её записи идёт только пока
    // машинка реально перетаскивается. Паузы накапливаются в marker._pauseAcc и
    // вычитаются в relTime, поэтому при воспроизведении движение остаётся непрерывным,
    // а паузы (когда не тянешь) выпадают.
    //
    // Начало записи привязано НЕ к касанию (pointerdown), а к моменту фиксации драга
    // на границе изображения — об этом сообщает setupTopDrag через window.onCarDragStart.
    // Отпускание (конец драга) ловится по pointerup/pointercancel по сохранённому
    // pointerId, чтобы срабатывать даже когда кнопку мыши отпускают далеко от машинки.
    // Закрыть открытую паузу записи машинки: накопить её длительность в смещении шкалы.
    // В обычной записи смещение копится в _pauseAcc (реальные миллисекунды), а при записи
    // во время воспроизведения (_playAll) — в _pausePhase (та же величина, но в фазовой
    // шкале цикла), чтобы продолжение записи не прыгало по времени.
    function closePause(marker) {
        if (marker._pauseFrom == null) return;
        const dur = performance.now() - marker._pauseFrom;
        marker._pauseFrom = null;
        if (_playAll) {
            const ld = loopDur(marker);
            marker._pausePhase = ((marker._pausePhase || 0) + dur) % ld;
        } else {
            marker._pauseAcc = (marker._pauseAcc || 0) + dur;
        }
    }

    window.onCarDragStart = function (marker, pid) {
        if (!_recOn || !marker || marker._isTl) return;
        if (marker._stylusOn && marker._activePtr === pid) return; // уже тянем эту машинку
        marker._stylusOn = true;
        marker._activePtr = pid;
        // Начался реальный драг — завершаем открытую паузу.
        closePause(marker);
    };

    function endStylusRec(e) {
        if (!_recOn) return;
        // Ищем машинку по сохранённому pointerId, а НЕ по e.target: на десктопе
        // кнопку мыши могут отпустить далеко от машинки (курсор уведён на карту),
        // и тогда e.target — карта, а не .pic-marker. По pointerId событие находится
        // надёжно независимо от того, где именно произошло отпускание.
        const marker = placedMarkers.find(m => !m._isTl && m._activePtr === e.pointerId);
        if (!marker) return;
        marker._stylusOn = false;
        marker._activePtr = null;
        // Стилус убран машинки — открываем паузу (завершится при следующем драге).
        if (marker._pauseFrom == null) marker._pauseFrom = performance.now();
    }
    window.addEventListener('pointerup', endStylusRec, true);
    window.addEventListener('pointercancel', endStylusRec, true);
    window.addEventListener('pointerlostcapture', endStylusRec, true);

    // ---- Временные текстовые надписи ----
    // Каждая надпись хранится в marker._timedTexts: { id, lat, lon, text, t0, t1 }.
    // t0/t1 — мс записи (та же шкала, что _samples/_signals). Во время воспроизведения
    // надпись видна, когда «recording elapsed» машинки попадает в [t0, t1].

    // Создать DOM-метку временной надписи (не таскается, не редактируется, скрыта).
    window.buildTimedTextDom = function (marker, tt) {
        if (!window.makeTextMarker) return;
        // Синхронизировать генератор id с восстановленными надписями,
        // чтобы новые id не пересекались с уже существующими.
        if (tt.id && /^tt\d+$/.test(tt.id)) {
            const n = parseInt(tt.id.slice(2), 10) + 1;
            if (n > _ttSeq) _ttSeq = n;
        }
        const ta = document.createElement('div');
        ta.className = 'text-input timed-text-input';
        ta.textContent = tt.text || '';
        const m = window.makeTextMarker(tt.lat, tt.lon, ta, {
            // Перетаскивание при открытой шторке: новая позиция пишется обратно в tt.
            onDragEnd: () => {
                if (!tt) return;
                tt.lat = m._lat;
                tt.lon = m._lon;
                if (window.commit) window.commit();
            }
        });
        m._timed = true;
        m._tt = tt;
        m._fixed = true;
        m.update({ draggable: false });
        m._select.classList.add('fixed');
        m._select.classList.add('timed-text');
        marker._ttEls = marker._ttEls || new Map();
        marker._ttEls.set(tt.id, m);
        map.addChild(m);
        return m;
    };

    function removeTimedTextDom(marker, tt) {
        const mm = marker._ttEls && marker._ttEls.get(tt.id);
        if (mm) {
            map.removeChild(mm);
            marker._ttEls.delete(tt.id);
        }
    }

    function removeAllTimedTextDom(marker) {
        if (!marker._ttEls) return;
        marker._ttEls.forEach(mm => map.removeChild(mm));
        marker._ttEls.clear();
    }

    // Текущее «recording elapsed» машинки для заданного времени главных часов.
    // Идентично формуле, что в sampleAt/signalAt: e = st + (elapsed - phaseOffset), clamped.
    function recElapsedOf(marker, elapsed) {
        const s = marker._samples;
        if (!s || s.length < 2) return 0;
        const st = marker._startTrim || 0;
        const et = marker._endTrim != null ? marker._endTrim : s[s.length - 1].t;
        let e = st + (elapsed - (marker._phaseOffset || 0));
        if (e < st) e = st;
        else if (e > et) e = et;
        return e;
    }

    // Обновить видимость всех временных надписей машинки по времени главных часов.
    // elapsed может быть null — тогда все прячем.
    function applyTimedTexts(marker, elapsed) {
        const e = (elapsed == null) ? null : recElapsedOf(marker, elapsed);
        applyTimedTextsAt(marker, e);
    }

    // Обновить видимость по «recording elapsed» (мс записи) напрямую.
    // recMs может быть null — тогда все прячем.
    function applyTimedTextsAt(marker, recMs) {
        const list = marker._timedTexts;
        if (!list || !list.length || !marker._ttEls) return;
        const e = (recMs == null) ? -1 : recMs;
        for (const tt of list) {
            const m = marker._ttEls.get(tt.id);
            if (!m) continue;
            const visible = e >= tt.t0 && e <= tt.t1;
            m._select.classList.toggle('visible', visible);
        }
    }

    function hideAllTimedTexts() {
        placedMarkers.forEach(m => applyTimedTexts(m, null));
    }

    // Включить/выключить перетаскивание временных надписей машинки.
    // Pointer-events получают только видимые (visible) надписи — остальные
    // не мешают карте даже при включённом draggable.
    function setTimedTextsInteractive(marker, on) {
        if (!marker || !marker._ttEls) return;
        marker._ttEls.forEach(m => {
            m.update({ draggable: on });
            m._select.classList.toggle('tt-draggable', on);
        });
    }

    // Общий стейт: перетаскивание доступно только для машинки открытой шторки,
    // когда воспроизведение не идёт.
    function updateTimedTextsInteractive() {
        const on = _scrubOpen && !_playAll;
        placedMarkers.forEach(m => setTimedTextsInteractive(m, on && m === _scrubMarker));
    }

    // Начать установку новой надписи тапом по карте.
    function beginPlaceText(marker, text, t0) {
        if (_placeTextMode) return;
        _placeTextMode = true;
        _pendingText = { marker, text, t0 };
        if (_scrubOpen) closeScrubber();
        // Скрыть панель машинки, чтобы тап не перехватывался её элементами
        if (marker._panelOpen) setPanel(marker, false);
        _ttHint.classList.add('visible');
        _registerMapTap();
    }

    function cancelPlaceText() {
        if (!_placeTextMode) return;
        _placeTextMode = false;
        _pendingText = null;
        _ttHint.classList.remove('visible');
    }

    function finishPlaceText(lat, lon) {
        const p = _pendingText;
        if (!p) { cancelPlaceText(); return; }
        _placeTextMode = false;
        _pendingText = null;
        _ttHint.classList.remove('visible');
        const marker = p.marker;
        marker._timedTexts = marker._timedTexts || [];
        const tt = { id: 'tt' + (_ttSeq++), lat, lon, text: p.text, t0: p.t0, t1: p.t0 + 300 };
        marker._timedTexts.push(tt);
        const dom = window.buildTimedTextDom(marker, tt);
        // Показать только что поставленную надпись, чтобы пользователь её увидел,
        // затем скрыть (дальше видимостью управляет воспроизведение).
        if (dom && dom._select) {
            dom._select.classList.add('visible');
            setTimeout(() => {
                if (!_playAll) dom._select.classList.remove('visible');
            }, 1200);
        }
        if (window.commit) window.commit();
        highlightCar(marker, true);
        // Вернуть шторку с обновлённым списком
        openScrubber(marker);
    }

    function _registerMapTap() {
        window.onMapTap = function (event) {
            if (!_placeTextMode) return false;
            if (!event || !event.coordinates) return true; // событие без координат — глушим
            finishPlaceText(event.coordinates[1], event.coordinates[0]);
            return true;
        };
    }

    // ---- Воспроизведение всех записей ----
    const MASTER_FRAME_MS = 33; // ~30fps — данные записаны ~10fps, этого достаточно для плавности

    // Применить состояние одной машинки на момент elapsed (мс). Возвращает true,
    // если машинка что-то воспроизводила (тексты/лампы/движение).
    function advanceMarker(m, elapsed, bounds) {
        let any = false;
        if (m._playing && m._timedTexts && m._timedTexts.length) { applyTimedTexts(m, elapsed); any = true; }
        if (m._playing && m._isTl && m._tlRec && m._tlRec.length) { applyTlAt(m, elapsed); any = true; }
        else if (m._playing && m._samples && m._samples.length >= 2) {
            sampleAt(m, elapsed);
            if (!bounds || inBounds(bounds, m._lon, m._lat)) applyPosition(m);
            any = true;
        }
        return any;
    }

    // Завершить одиночное воспроизведение: поставить машинку в конец записи,
    // вернуть её сигнал и снять блокировку перетаскивания.
    function endSinglePlay(m) {
        if (!m._playing) return;
        markStopped(m, true);
        _playingSingle = null;
        _playAll = false;
        if (_masterRaf) cancelAnimationFrame(_masterRaf);
        _masterRaf = null;
        hideAllTimedTexts();
        updateTimedTextsInteractive();
        updatePlayAllBtn();
        if (window.updateSignalBtns) window.updateSignalBtns();
    }

    function masterFrame() {
        if (!_playAll) { _masterRaf = null; return; }
        const now = performance.now();
        if (now - _masterLast >= MASTER_FRAME_MS) {
            _masterLast = now;
            const bounds = visibleBounds(); // [[lngMin,latMin],[lngMax,latMax]] или null
            // Одиночное воспроизведение одной машинки — без цикла, один проход.
            if (_playingSingle) {
                const m = _playingSingle;
                const elapsed = now - _masterStart;
                if (!m || elapsed >= endPhase(m)) { if (m) endSinglePlay(m); else stopAll(); return; }
                if (!advanceMarker(m, elapsed, bounds)) { stopAll(); return; }
                _masterRaf = requestAnimationFrame(masterFrame);
                return;
            }
            // У каждой машинки/светофора — свой цикл (loopDur), общие часы (_masterStart)
            let any = false;
            placedMarkers.forEach(m => {
                const elapsed = (now - _masterStart) % loopDur(m);
                if (advanceMarker(m, elapsed, bounds)) any = true;
            });
            if (!any) { _playAll = false; _masterRaf = null; updatePlayAllBtn(); return; }
        }
        _masterRaf = requestAnimationFrame(masterFrame);
    }

    // Текущие границы видимой области карты [[lngMin,latMin],[lngMax,latMax]] или null.
    // Yandex Maps v3 не даёт готового getBounds(), поэтому вычисляем приблизительно
    // из map.center/map.zoom и размера контейнера (Web Mercator).
    function visibleBounds() {
        try {
            const m = map;
            if (!m || !m.center || !isFinite(m.zoom)) return null;
            const container = document.getElementById('map');
            const wpx = container ? container.clientWidth : window.innerWidth;
            const hpx = container ? container.clientHeight : window.innerHeight;
            const cLat = m.center[1], cLng = m.center[0];
            const latRad = cLat * Math.PI / 180;
            const mpp = 156543.03392 * Math.cos(latRad) / Math.pow(2, m.zoom);
            const halfW = (wpx / 2) * mpp;
            const halfH = (hpx / 2) * mpp;
            const padM = 150; // небольшой запас, чтобы машинка у края не мигала
            const dLng = (halfW + padM) / (111320 * Math.cos(latRad));
            const dLat = (halfH + padM) / 110540;
            return [[cLng - dLng, cLat - dLat], [cLng + dLng, cLat + dLat], m.zoom];
        } catch (e) { /* ignore */ }
        return null;
    }

    // Проверка попадания точки внутри границ (с небольшим запасом).
    function inBounds(bounds, lon, lat) {
        const [[lngMin, latMin], [lngMax, latMax]] = bounds;
        return lon >= lngMin && lon <= lngMax && lat >= latMin && lat <= latMax;
    }


    // Подготовить машинку к воспроизведению: пометить играющей, сохранить
    // текущий сигнал/лампы и заблокировать перетаскивание.
    function markPlaying(m) {
        m._playing = true;
        m._savedBlink = m._blinkSide;
        if (m._isTl && m._lampState) m._savedLamps = Object.assign({}, m._lampState);
        m.update({ draggable: false });
        m._select.style.pointerEvents = 'none';
    }

    // После остановки вернуть машинке её состояние: восстановить сигнал/лампы
    // и снять блокировку перетаскивания. final=true — оставить в конце записи.
    function markStopped(m, final) {
        m._playing = false;
        if (m._isTl) {
            const L = m._savedLamps;
            if (L) for (const k in L) { if (window.tlSetLamp) window.tlSetLamp(m, k, L[k]); }
            m._savedLamps = undefined;
        } else {
            if (final) { sampleAt(m, endPhase(m)); applyPosition(m); }
            else { sampleAt(m, m._phaseOffset || 0); applyPosition(m); }
            applySignal(m, m._savedBlink);
        }
        m._select.style.pointerEvents = '';
        m.update({ draggable: window.markerDraggable ? window.markerDraggable(m) : !(m._panelOpen || drawMode || eraserMode) });
    }

    // Запустить общий rAF-цикл воспроизведения с нуля.
    function beginMaster() {
        _masterStart = performance.now();
        _masterLast = 0;
        _masterRaf = requestAnimationFrame(masterFrame);
        updateTimedTextsInteractive();
        updatePlayAllBtn();
    }

    function startAll() {
        cancelPlaceText();
        if (_recOn) stopRec();
        // Если идёт одиночное воспроизведение — остановить его и начать общее.
        if (_playingSingle && _playAll) stopAll();
        if (_playAll) return;
        const targets = playables().concat(tlRecMarkers());
        if (!targets.length) return;
        targets.forEach(markPlaying);
        _maxDur = maxDurOf(targets);
        _playAll = true;
        _paused = false;
        beginMaster();
    }

    // Одиночное воспроизведение записи одной машинки (кнопка Плей на панели).
    function startSinglePlay(marker) {
        if (!marker) return;
        if (!(marker._samples && marker._samples.length >= 2) && !(marker._isTl && marker._tlRec && marker._tlRec.length)) return;
        cancelPlaceText();
        if (_recOn) stopRec();
        if (_scrubOpen) closeScrubber();
        if (_playAll) stopAll(); // снимает _playing со всех машинок
        markPlaying(marker);
        _maxDur = maxDurOf([marker]);
        _playingSingle = marker;
        _playAll = true;
        beginMaster();
        if (window.updateSignalBtns) window.updateSignalBtns();
    }

    function stopAll() {
        if (!_playAll) return;
        _playAll = false;
        _paused = false;
        if (_masterRaf) cancelAnimationFrame(_masterRaf);
        _masterRaf = null;
        _playingSingle = null;
        placedMarkers.forEach(m => { if (m._playing) markStopped(m, false); });
        hideAllTimedTexts();
        updateTimedTextsInteractive();
        updatePlayAllBtn();
        if (window.updateSignalBtns) window.updateSignalBtns();
    }

    // Пауза общего воспроизведения: останавливаем rAF-цикл, но сохраняем позицию —
    // _playAll и _playing у маркеров остаются, поэтому при resume продолжим с того же места.
    // Пока пауза активна, машинки можно двигать руками (см. setupTopDrag); при возобновлении
    // воспроизведения они снова запираются и продолжают движение с фазы паузы.
    function setPlayingCarsDraggable(on) {
        placedMarkers.forEach(m => {
            if (!m._playing || m._isZnak || m._isTl) return;
            m.update({ draggable: on ? (window.markerDraggable ? window.markerDraggable(m) : true) : false });
            if (m._select) m._select.style.pointerEvents = on ? '' : 'none';
        });
    }

    function pauseAll() {
        if (!_playAll || _playingSingle || _paused) return;
        _paused = true;
        _pauseStart = performance.now();
        if (_masterRaf) cancelAnimationFrame(_masterRaf);
        _masterRaf = null;
        setPlayingCarsDraggable(true);
        updatePlayAllBtn();
    }

    // Продолжить общее воспроизведение с места, где было остановлено на паузу.
    function resumeAll() {
        if (!_paused) return;
        // Сдвигаем общие часы вперёд на длительность паузы, чтобы elapsed не «прыгнул».
        _masterStart += performance.now() - _pauseStart;
        _paused = false;
        _masterLast = 0;
        // Возвращаем блокировку: машинки продолжают движение с фазы, на которой стояли на паузе.
        setPlayingCarsDraggable(false);
        _masterRaf = requestAnimationFrame(masterFrame);
        updatePlayAllBtn();
    }

    // Включить только что записанные машинки в текущее воспроизведение
    function joinRecordedToPlay() {
        let changed = false;
        placedMarkers.forEach(m => {
            if (!m._playing && ((m._recActive && hasMovement(m)) || (m._isTl && hasTlRec(m)))) {
                markPlaying(m);
                changed = true;
            }
        });
        if (changed) {
            _maxDur = maxDurOf(placedMarkers.filter(m =>
                m._playing && (m._isTl ? hasTlRec(m) : (m._samples && m._samples.length >= 2))));
        }
    }

    // ---- Окно перемотки (долгое нажатие на PLAY) ----
    function scrubTo(marker, t) {
        marker._scrubT = t;
        sampleAt(marker, t - startTrim(marker) + (marker._phaseOffset || 0));
        applyPosition(marker);
    }

    function fmtTime(ms) {
        return (ms / 1000).toFixed(1) + 'с';
    }

    function openScrubber(marker) {
        cancelPlaceText();
        if (_scrubOpen) {
            if (marker && marker !== _scrubMarker) {
                _scrubMarker = marker;
                buildScrubRows(marker);
                updateTimedTextsInteractive();
                applyTimedTextsAt(marker, marker._scrubT);
            }
            return;
        }
        if (_recOn) stopRec();
        if (_playAll) stopAll();
        _scrubOpen = true;
        _scrubMarker = marker || null;
        playables().forEach(m => { m._savedBlink = m._blinkSide; });
        buildScrubRows(marker);
        updateTimedTextsInteractive();
        if (marker) applyTimedTextsAt(marker, marker._scrubT);
        scrubModal.classList.add('visible');
    }

    // Отцентрировать камеру на машинке (без подсветки строки).
    function highlightCar(marker, centerView) {
        if (centerView && marker && map) {
            try {
                // Центрируем камеру на машинке, сохраняя текущий азимут: обработка
                // location сбрасывает азимут, поэтому возвращаем его camera-only.
                const az = (map.azimuth != null && isFinite(map.azimuth)) ? map.azimuth : 0;
                const zoom = (map.zoom != null && isFinite(map.zoom)) ? map.zoom : 16;
                map.setLocation({ center: [marker._lon, marker._lat], zoom: zoom, duration: 600 });
                map.update({ camera: { azimuth: az, duration: 600 } });
            } catch (e) {}
        }
    }

    // Есть ли у машинки запись движения.
    function hasRecording(m) {
        return !!(m._samples && m._samples.length >= 2 && hasMovement(m));
    }

    function showConfirm(marker) {
        _confirmMarker = marker;
        confirmModal.classList.add('visible');
    }

    function hideConfirm() {
        _confirmMarker = null;
        confirmModal.classList.remove('visible');
    }

    function deleteRecording(marker) {
        marker._samples = [];
        marker._startTrim = 0;
        marker._endTrim = undefined;
        marker._phaseOffset = 0;
        marker._signals = [];
        marker._loopMs = undefined;
        marker._timedTexts = [];
        removeAllTimedTextDom(marker);
        if (_scrubOpen) buildScrubRows(marker);
        updatePlayAllBtn();
    }

    function buildScrubRows(marker) {
        hideConfirm();
        scrubBody.textContent = '';
        if (!marker || !hasRecording(marker)) {
            scrubThumb.style.display = 'none';
            scrubTime.style.display = 'none';
            scrubTime.textContent = '';
            scrubDeleteBtn.classList.add('hidden');
            const empty = document.createElement('div');
            empty.className = 'scrub-empty';
            empty.textContent = 'Нет записи';
            scrubBody.appendChild(empty);
            return;
        }
        scrubThumb.style.display = '';
        scrubTime.style.display = '';
        scrubDeleteBtn.classList.remove('hidden');
        scrubThumb.src = marker._img ? marker._img.src : '';
        {
            const dur = marker._samples[marker._samples.length - 1].t;
            if (marker._startTrim == null) marker._startTrim = 0;
            if (marker._endTrim == null) marker._endTrim = dur;
            // страховка: старые сохранения могли увести границы за длительность записи
            if (marker._startTrim > dur) marker._startTrim = 0;
            if (marker._endTrim > dur) marker._endTrim = dur;
            const row = document.createElement('div');
            row.className = 'scrub-row';
            row._marker = marker;
            // Клик по строке: центрировать камеру на машинке.
            row.addEventListener('click', e => {
                if (e.target && e.target.closest &&
                    (e.target.closest('.scrub-sigtrack') || e.target.closest('.scrub-sigsec') ||
                     e.target.closest('.scrub-confirm-btn') || e.target.closest('.scrub-loop') ||
                     e.target.closest('.scrub-tttrack') || e.target.closest('.scrub-ttsec'))) return;
                highlightCar(marker, true);
            });
            const sigsec = document.createElement('div');
            sigsec.className = 'scrub-sigsec';
            const timeWrap = document.createElement('div');
            timeWrap.className = 'scrub-timewrap';
            timeWrap.appendChild(scrubThumb);
            timeWrap.appendChild(scrubTime);
            // Поле длины цикла машинки (секунды). Пустое или 0 — вернуть общий период
            const loopWrap = document.createElement('div');
            loopWrap.className = 'scrub-loop';
            const loopLabel = document.createElement('span');
            loopLabel.textContent = 'Цикл';
            const loopInput = document.createElement('input');
            loopInput.type = 'number';
            loopInput.min = '0.1';
            loopInput.step = '0.1';
            loopInput.value = (((marker._loopMs != null && marker._loopMs > 0) ? marker._loopMs : loopDefaultMs()) / 1000).toFixed(1);
            const loopUnit = document.createElement('span');
            loopUnit.textContent = 'с';
            loopWrap.appendChild(loopLabel);
            loopWrap.appendChild(loopInput);
            loopWrap.appendChild(loopUnit);
            timeWrap.appendChild(loopWrap);
            loopInput.addEventListener('input', () => {
                const v = parseFloat(loopInput.value);
                marker._loopMs = (isFinite(v) && v > 0) ? Math.round(v * 1000) : undefined;
                // Паузу перед движением (phaseOffset) не трогаем — укороченный цикл
                // обрезает только правую часть (хвост/конец движения) на шкале и в воспроизведении.
                refresh();
            });
            loopInput.addEventListener('change', () => {
                const v = parseFloat(loopInput.value);
                loopInput.value = (isFinite(v) && v > 0 ? v : loopMsOf(marker) / 1000).toFixed(1);
            });
            // Полоса времени в стиле полос поворотников: часовая песочница + трек
            const timeLine = document.createElement('div');
            timeLine.className = 'scrub-sigline scrub-timeline';
            const timeLabel = document.createElement('div');
            timeLabel.className = 'scrub-siglabel';
            timeLabel.textContent = '⏳';
            const timeTrack = document.createElement('div');
            timeTrack.className = 'scrub-sigtrack scrub-timetrack';
            // Шкала = весь цикл машинки [0, loop]; затемнённые зоны — отрезанное начало и хвост/стоянка
            const waitStart = document.createElement('div');
            waitStart.className = 'scrub-wait';
            const waitEnd = document.createElement('div');
            waitEnd.className = 'scrub-wait';
            const active = document.createElement('div');
            active.className = 'scrub-active';
            const actH0 = document.createElement('div');
            actH0.className = 'sig-h sig-h-s';
            const actH1 = document.createElement('div');
            actH1.className = 'sig-h sig-h-e';
            active.appendChild(actH0);
            active.appendChild(actH1);
            timeTrack.appendChild(waitStart);
            timeTrack.appendChild(waitEnd);
            timeTrack.appendChild(active);
            timeLine.appendChild(timeLabel);
            timeLine.appendChild(timeTrack);
            row.appendChild(timeWrap);
            row.appendChild(timeLine);
            // ---- Ползунок времени: ось = полный цикл машинки [0..loop].
            //      Зелёный = движение, на оси цикла проходит интервал
            //      [phaseOffset+startTrim .. phaseOffset+endTrim] (все величины в мс).
            //      Затемнённые зоны слева/справа = ожидание: до начала движения и простой до конца цикла.
            //      Ручки правят startTrim/endTrim (мс записи), координаты пересчитываются в цикл-мс. ----
            let tDrag = null;
            const MINTRY = 150; // минимальная длина интервала, мс (0.15с)
            const msAt = (rect, loop, cx) => {
                if (!rect.width) return loop / 2;
                return Math.max(0, Math.min(loop, (cx - rect.left) / rect.width * loop));
            };
            // Общий обработчик drag: какой край тянут — решает tDrag.mode из pointerdown
            // (элемент ручки), а не позиция пальца в момент нажатия.
            const timeDragMove = e => {
                if (!tDrag) return;
                const rect = timeTrack.getBoundingClientRect();
                if (!rect.width) return;
                const c = msAt(rect, tDrag.loop, e.clientX); // цикл-мс под пальцем
                const et = Math.min(marker._endTrim != null ? marker._endTrim : dur, dur);
                if (tDrag.mode === 's') {
                    marker._startTrim = Math.max(0, Math.min(c - tDrag.ph, et - MINTRY));
                    scrubTo(marker, marker._startTrim);
                } else {
                    marker._endTrim = Math.max(marker._startTrim + MINTRY, Math.min(c - tDrag.ph, dur));
                    scrubTo(marker, marker._endTrim);
                }
                refresh();
            };
            const timeDragEnd = e => {
                if (!tDrag) return;
                try {
                    const hold = tDrag.el;
                    if (hold && hold.hasPointerCapture && hold.hasPointerCapture(e.pointerId)) hold.releasePointerCapture(e.pointerId);
                } catch (_) {}
                tDrag = null;
            };
            const beginTimeDrag = (mode, hold, e, loop, ph) => {
                tDrag = { mode, loop, ph, el: hold };
                try { hold.setPointerCapture(e.pointerId); } catch (_) {}
            };
            // Ручки — самостоятельные элементы: палец на правой ручке ВСЕГДА двигает правый край.
            const grabHandle = (mode, hold, e) => {
                e.stopPropagation();
                e.preventDefault();
                const rect = timeTrack.getBoundingClientRect();
                if (!rect.width) return;
                beginTimeDrag(mode, hold, e, loopMsOf(marker), marker._phaseOffset || 0);
            };
            actH0.addEventListener('pointerdown', e => grabHandle('s', actH0, e));
            actH1.addEventListener('pointerdown', e => grabHandle('e', actH1, e));
            actH0.addEventListener('pointermove', timeDragMove);
            actH1.addEventListener('pointermove', timeDragMove);
            actH0.addEventListener('pointerup', timeDragEnd);
            actH1.addEventListener('pointerup', timeDragEnd);
            actH0.addEventListener('pointercancel', timeDragEnd);
            actH1.addEventListener('pointercancel', timeDragEnd);
            // Тап по треку мимо ручек — прыгнуть к ближайшей ручке (стандарт двойного слайдера);
            // очевидный тап вдалеке от ручек — только предпросмотр, тримы не меняем.
            timeTrack.addEventListener('pointerdown', e => {
                e.stopPropagation();
                if (e.target && e.target.closest('.sig-h')) return; // ручки ловят сами
                const rect = timeTrack.getBoundingClientRect();
                if (!rect.width) return;
                const loop = loopMsOf(marker);
                const ph = marker._phaseOffset || 0;
                const st = marker._startTrim;
                const et = Math.min(marker._endTrim != null ? marker._endTrim : dur, dur);
                const gL = Math.min(loop, ph + st);
                const gR = Math.min(loop, ph + et);
                const sx = rect.left + (gL / loop) * rect.width;
                const ex = rect.left + (gR / loop) * rect.width;
                const ds = Math.abs(e.clientX - sx);
                const de = Math.abs(e.clientX - ex);
                const near = 16;
                if (ds <= near || de <= near) {
                    // рядом с ручкой (но не на ней) — берём ближайшую и передаём ей жест
                    beginTimeDrag(ds <= de ? 's' : 'e', timeTrack, e, loop, ph);
                } else {
                    scrubTo(marker, msAt(rect, loop, e.clientX));
                }
            });
            timeTrack.addEventListener('pointermove', timeDragMove);
            timeTrack.addEventListener('pointerup', timeDragEnd);
            timeTrack.addEventListener('pointercancel', timeDragEnd);

            // ---- редактор поворотников (2 линии, всегда раскрыты) ----
            const attachSigTrack = side => {
                const line = document.createElement('div');
                line.className = 'scrub-sigline';
                const label = document.createElement('div');
                label.className = 'scrub-siglabel' + (side === 'right' ? ' right' : '');
                label.textContent = side === 'left' ? '←' : '→';
                const track = document.createElement('div');
                track.className = 'scrub-sigtrack';
                line.appendChild(label);
                line.appendChild(track);
                sigsec.appendChild(line);
                const renderSegs = () => {
                    track.textContent = '';
                    (marker._signals || []).filter(s => s.side === side).forEach(seg => {
                        const d = document.createElement('div');
                        d.className = 'sig-seg sig-seg-' + seg.side;
                        d._seg = seg;
                        const hs = document.createElement('div');
                        hs.className = 'sig-h sig-h-s';
                        const he = document.createElement('div');
                        he.className = 'sig-h sig-h-e';
                        const del = document.createElement('div');
                        del.className = 'sig-del';
                        del.textContent = '✕';
                        del.addEventListener('click', e => {
                            e.stopPropagation();
                            marker._signals = marker._signals.filter(s => s !== seg);
                            buildScrubRows(marker);
                        });
                        d.appendChild(hs);
                        d.appendChild(he);
                        d.appendChild(del);
                        track.appendChild(d);
                        placeSeg(d, seg);
                    });
                };
                const placeSeg = (el, seg) => {
                    el.style.left = (seg.t0 / dur * 100) + '%';
                    el.style.width = Math.max(0.5, (seg.t1 - seg.t0) / dur * 100) + '%';
                };
                const tFromEvent = e => {
                    const rect = track.getBoundingClientRect ? track.getBoundingClientRect() : track._rect;
                    if (rect && rect.width) return Math.max(0, Math.min(dur, (e.clientX - rect.left) / rect.width * dur));
                    return dur / 2;
                };
                const MINLEN = 0.15;
                let sigDrag = null;
                track.addEventListener('pointerdown', e => {
                    e.stopPropagation();
                    const t = tFromEvent(e);
                    const segEl = e.target && e.target.closest ? e.target.closest('.sig-seg') : null;
                    if (segEl && segEl._seg) {
                        const seg = segEl._seg;
                        if (e.target.closest('.sig-del')) return; // удаление — через click крестика
                        const onStart = e.target.closest('.sig-h-s');
                        const onEnd = e.target.closest('.sig-h-e');
                        if (!onStart && !onEnd) return; // перенос целиком отключён — только края
                        sigDrag = { mode: 'resize', marker, seg, edge: onStart ? 's' : 'e', segEl };
                        scrubTo(marker, onStart ? seg.t0 : seg.t1);
                        return;
                    }
                    sigDrag = { mode: 'draw', marker, side, t0: t, t1: t };
                    scrubTo(marker, t);
                    const d = document.createElement('div');
                    d.className = 'sig-seg sig-seg-' + side + ' sig-draw';
                    track.appendChild(d);
                    sigDrag.segEl = d;
                    const upd = () => {
                        const a = Math.min(sigDrag.t0, sigDrag.t1), b = Math.max(sigDrag.t0, sigDrag.t1);
                        placeSeg(sigDrag.segEl, { t0: a, t1: b });
                    };
                    sigDrag.update = upd;
                    upd();
                });
                track.addEventListener('pointermove', e => {
                    if (!sigDrag) return;
                    const t = tFromEvent(e);
                    if (sigDrag.mode === 'draw') {
                        sigDrag.t1 = t;
                        sigDrag.update();
                        scrubTo(marker, t);
                    } else if (sigDrag.mode === 'resize') {
                        const seg = sigDrag.seg;
                        if (sigDrag.edge === 's') seg.t0 = Math.max(0, Math.min(t, seg.t1 - MINLEN));
                        else seg.t1 = Math.min(dur, Math.max(t, seg.t0 + MINLEN));
                        placeSeg(sigDrag.segEl, seg);
                        scrubTo(marker, sigDrag.edge === 's' ? seg.t0 : seg.t1);
                    }
                });
                track.addEventListener('pointerup', e => {
                    if (!sigDrag) return;
                    const d = sigDrag;
                    sigDrag = null;
                    if (d.mode === 'draw') {
                        let a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
                        if (b - a < 0.15) { const c = (a + b) / 2; a = Math.max(0, c - 0.35); b = Math.min(dur, c + 0.35); }
                        marker._signals = marker._signals || [];
                        marker._signals.push({ t0: a, t1: b, side: d.side });
                        marker._signals.sort((x, y) => x.t0 - y.t0);
                        buildScrubRows(marker);
                        return;
                    }
                    if (d.mode === 'resize') {
                        marker._signals.sort((x, y) => x.t0 - y.t0);
                        buildScrubRows(marker);
                    }
                });
                track.addEventListener('pointercancel', () => { sigDrag = null; renderSegs(); });
                renderSegs();
            };
            // ---- секция временных текстов: поле + добавить + список с шкалами ----
            function attachTimedTextSection(marker, dur, row) {
                const sec = document.createElement('div');
                sec.className = 'scrub-ttsec';
                const title = document.createElement('div');
                title.className = 'scrub-tt-title';
                title.textContent = 'Текст на карте (появляется на время)';
                const addWrap = document.createElement('div');
                addWrap.className = 'scrub-tt-add';
                const inp = document.createElement('textarea');
                inp.className = 'scrub-tt-input';
                inp.rows = 1;
                inp.placeholder = 'Введите текст…';
                inp.spellcheck = false;
                inp.autocomplete = 'off';
                const autoGrow = () => {
                    inp.style.height = 'auto';
                    inp.style.height = inp.scrollHeight + 'px';
                };
                inp.addEventListener('input', autoGrow);
                autoGrow();
                const addBtn = document.createElement('button');
                addBtn.className = 'scrub-tt-addbtn';
                addBtn.textContent = 'Добавить';
                addWrap.appendChild(inp);
                addWrap.appendChild(addBtn);
                const list = document.createElement('div');
                sec.appendChild(title);
                sec.appendChild(addWrap);
                sec.appendChild(list);
                row.appendChild(sec);

                addBtn.addEventListener('pointerdown', e => e.stopPropagation());
                addBtn.addEventListener('click', () => {
                    beginPlaceText(marker, inp.value, scrubToTime());
                });

                // Текущее время перемотки: _scrubT фиксируется в scrubTo() (мс записи).
                function scrubToTime() {
                    if (marker._scrubT != null) return marker._scrubT;
                    return marker._startTrim || 0;
                }

                const mkTTItem = (tt) => {
                    const item = document.createElement('div');
                    item.className = 'scrub-tt-item';
                    const head = document.createElement('div');
                    head.className = 'scrub-tt-head';
                    const textEl = document.createElement('div');
                    textEl.className = 'scrub-tt-text' + ((tt.text || '').trim() ? '' : ' empty');
                    textEl.textContent = (tt.text || '').trim() || '(пустой текст)';
                    const delBtn = document.createElement('button');
                    delBtn.className = 'scrub-tt-del';
                    delBtn.textContent = '✕';
                    delBtn.title = 'Удалить надпись';
                    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
                    delBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        removeTimedTextDom(marker, tt);
                        marker._timedTexts = marker._timedTexts.filter(t => t !== tt);
                        if (window.commit) window.commit();
                        buildScrubRows(marker);
                    });
                    head.appendChild(textEl);
                    head.appendChild(delBtn);
                    item.appendChild(head);

                    // Шкала видимости [t0,t1] на оси длительности записи dur
                    const line = document.createElement('div');
                    line.className = 'scrub-tt-line';
                    const label = document.createElement('div');
                    label.className = 'scrub-tt-label';
                    label.textContent = 'Т';
                    const track = document.createElement('div');
                    track.className = 'scrub-tttrack';
                    const none = document.createElement('div');
                    none.className = 'tt-none';
                    const vis = document.createElement('div');
                    vis.className = 'tt-visible';
                    const h0 = document.createElement('div');
                    h0.className = 'sig-h sig-h-s';
                    const h1 = document.createElement('div');
                    h1.className = 'sig-h sig-h-e';
                    vis.appendChild(h0);
                    vis.appendChild(h1);
                    track.appendChild(none);
                    track.appendChild(vis);
                    line.appendChild(label);
                    line.appendChild(track);
                    item.appendChild(line);
                    list.appendChild(item);

                    const place = () => {
                        const a = Math.min(tt.t0, tt.t1), b = Math.max(tt.t0, tt.t1);
                        const aP = Math.max(0, Math.min(100, a / dur * 100));
                        const bP = Math.max(0, Math.min(100, b / dur * 100));
                        vis.style.left = aP + '%';
                        vis.style.width = Math.max(0, bP - aP) + '%';
                    };
                    place();

                    const atFromEvent = e => {
                        const rect = track.getBoundingClientRect();
                        if (!rect.width) return dur / 2;
                        return Math.max(0, Math.min(dur, (e.clientX - rect.left) / rect.width * dur));
                    };
                    let ttDrag = null;
                    const dragMove = e => {
                        if (!ttDrag) return;
                        const t = atFromEvent(e);
                        const edge = ttDrag.edge;
                        if (edge === 's') tt.t0 = Math.max(0, Math.min(t, tt.t1 - MINTRY_MS));
                        else tt.t1 = Math.min(dur, Math.max(t, tt.t0 + MINTRY_MS));
                        place();
                        scrubTo(marker, edge === 's' ? tt.t0 : tt.t1);
                        applyTimedTextsAt(marker, marker._scrubT);
                    };
                    const dragEnd = () => { if (ttDrag) { ttDrag = null; if (window.commit) window.commit(); } };
                    const grab = (edge, e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        ttDrag = { edge };
                        try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
                    };
                    h0.addEventListener('pointerdown', e => grab('s', e));
                    h1.addEventListener('pointerdown', e => grab('e', e));
                    h0.addEventListener('pointermove', dragMove);
                    h1.addEventListener('pointermove', dragMove);
                    h0.addEventListener('pointerup', dragEnd);
                    h1.addEventListener('pointerup', dragEnd);
                    h0.addEventListener('pointercancel', dragEnd);
                    h1.addEventListener('pointercancel', dragEnd);
                    track.addEventListener('pointerdown', e => {
                        e.stopPropagation();
                        if (e.target && e.target.closest('.sig-h')) return;
                        const t = atFromEvent(e);
                        // тап по треку — предпросмотр в этой точке (не меняем границы)
                        scrubTo(marker, t);
                        applyTimedTextsAt(marker, t);
                    });
                };

                (marker._timedTexts || []).forEach(mkTTItem);
            }
            attachSigTrack('left');
            attachSigTrack('right');
            row.appendChild(sigsec);
            attachTimedTextSection(marker, dur, row);
            scrubBody.appendChild(row);

            const refresh = () => {
                const loop = loopMsOf(marker);
                const ph = marker._phaseOffset || 0;
                const st = marker._startTrim;
                // Движение занимает на оси цикла [ph+st .. ph+et], где et=endTrim; всё clamped по длине цикла
                const et = Math.min(marker._endTrim != null ? marker._endTrim : dur, dur);
                const gL = Math.min(loop, ph + st);
                const gR = Math.min(loop, ph + et);
                const p1 = (gL / loop) * 100;
                const p2 = (gR / loop) * 100;
                active.style.left = p1 + '%';
                active.style.width = Math.max(0, p2 - p1) + '%';
                waitStart.style.width = p1 + '%';
                waitEnd.style.left = Math.min(100, p2) + '%';
                waitEnd.style.width = Math.max(0, 100 - p2) + '%';
                scrubTime.textContent = fmtTime(ph + st) + '–' + fmtTime(ph + et) + ' (' + fmtTime(et - st) + ')';
            };
            scrubTo(marker, marker._startTrim);
            refresh();
        }
        scrubModal.classList.add('visible');
    }

    function closeScrubber() {
        hideConfirm();
        if (!_scrubOpen) return;
        _scrubOpen = false;
        _scrubMarker = null;
        scrubModal.classList.remove('visible');
        updateTimedTextsInteractive();
        hideAllTimedTexts();
        playables().forEach(m => applySignal(m, m._savedBlink));
    }
    scrubClose.addEventListener('click', closeScrubber);
    confirmYes.addEventListener('click', () => { const m = _confirmMarker; hideConfirm(); if (m) deleteRecording(m); });
    confirmNo.addEventListener('click', hideConfirm);
    confirmModal.addEventListener('click', e => { if (e.target === confirmModal) hideConfirm(); });

    // ---- Кнопки ----
    function updateRecBtn() {
        if (!recAllBtn) return;
        recAllBtn.classList.toggle('active', _recOn);
        recAllBtn.innerHTML = _recOn ? 'СТОП' : 'REC';
    }

    function updatePlayAllBtn() {
        if (!playAllBtn) return;
        const any = playables().length > 0 || placedMarkers.some(hasTlRec);
        // Глобальная кнопка отражает только общее воспроизведение (не одиночное).
        // На паузе кнопка показывает PLAY — значит «продолжить».
        const allPlaying = _playAll && !_playingSingle && !_paused;
        const hidden = document.body.classList.contains('controls-hidden');
        if (hidden && any && !allPlaying) {
            playAllBtn.style.display = 'flex';
            playAllBtn.style.background = 'rgba(15,15,15,0.3)';
            playAllBtn.style.boxShadow = 'none';
            playAllBtn.classList.remove('active');
            playAllBtn.innerHTML = ICON_PLAY;
        } else {
            playAllBtn.style.background = '';
            playAllBtn.style.boxShadow = '';
            playAllBtn.style.display = any ? 'flex' : 'none';
            playAllBtn.classList.toggle('active', allPlaying);
            playAllBtn.innerHTML = allPlaying ? ICON_STOP : ICON_PLAY;
        }
        // Кнопка полной остановки видна, пока идёт воспроизведение или пауза
        // (в том числе в режиме скрытия кнопок — показывается полупрозрачной).
        if (stopAllBtn) {
            stopAllBtn.style.display = _playAll ? 'flex' : 'none';
            if (hidden) {
                stopAllBtn.style.background = 'rgba(15,15,15,0.3)';
                stopAllBtn.style.boxShadow = 'none';
            } else {
                stopAllBtn.style.background = '';
                stopAllBtn.style.boxShadow = '';
            }
        }
    }

    // При переключении режима скрытия элементов управления (controls-hidden)
    // обновляем видимость/прозрачность кнопки PLAY.
    new MutationObserver(() => updatePlayAllBtn())
        .observe(document.body, { attributes: true, attributeFilter: ['class'] });

    recAllBtn.addEventListener('click', toggleRec);
    playAllBtn.addEventListener('click', () => {
        if (_scrubOpen) { closeScrubber(); return; }
        // Если стоит пауза — продолжаем с сохранённого места.
        if (_paused) { resumeAll(); return; }
        // При активном общем воспроизведении — пауза; иначе запускаем общее
        // (startAll сам остановит одиночное, если оно идёт).
        if (_playAll && !_playingSingle) { if (_recOn) stopRec(); pauseAll(); } else startAll();
    });
    // Кнопка полной остановки: сбрасывает воспроизведение (и паузу) в начало.
    stopAllBtn.addEventListener('click', () => {
        if (_recOn) stopRec();
        stopAll();
    });

    window.startSinglePlay = startSinglePlay;
    window.openScrubber = openScrubber;
    window.isSinglePlaying = function (m) { return !!m && _playingSingle === m && _playAll; };
    window.stopAll = stopAll;

    // ---- Патч removeMarker: обновляем видимость кнопки PLAY ----
    const origRemove = window.removeMarker;
    window.removeMarker = function (marker) {
        removeAllTimedTextDom(marker);
        origRemove(marker);
        updatePlayAllBtn();
    };

    // Патч restoreScene: после загрузки/восстановления сцены маркеры получают
    // _samples, поэтому обновляем видимость кнопки PLAY (иначе запись не запустить).
    const origRestoreScene = window.restoreScene;
    window.restoreScene = function (snap) {
        const result = origRestoreScene ? origRestoreScene(snap) : undefined;
        updatePlayAllBtn();
        return result;
    };

    // ---- Индивидуальные фазы мигания поворотников ----
    // Каждая машинка хранит момент включения (_blinkSince) и мигает в своём ритме.
    let _blinkOn = false;
    setInterval(() => {
        const now = performance.now();
        placedMarkers.forEach(m => {
            if (!m._rotWrap) return;
            if (m._blinkSide) {
                if (!m._blinkSince) m._blinkSince = now;
                m._rotWrap.classList.toggle('blink-on', ((now - m._blinkSince) / 450) % 2 < 1);
            } else {
                m._blinkSince = 0;
                m._rotWrap.classList.remove('blink-on');
            }
        });
    }, 100);
})();