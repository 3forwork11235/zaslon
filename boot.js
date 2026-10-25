// «Заслон» — запуск WebGL-сборки: полоса загрузки, проверка WebGL2, подсказка про поворот экрана, обработка ошибок.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var loader = $('loader'), barFill = $('bar-fill'), loadText = $('load-text');
  var failBox = $('fail'), failText = $('fail-text'), rotateBox = $('rotate'), toast = $('toast');
  var canvas = $('unity-canvas');

  // Ограничитель частоты кадров. Unity в браузере рисует кадр на каждый кадр экрана, а на телефонах и мониторах с 90–144 Гц это лишний нагрев
  // и 100% видеокарты. Игра выставляет предел (window.ZASLON_MAXFPS, 0 — без предела). Следующий кадр главного цикла ждёт по таймеру до нужного
  // момента и только потом выравнивается одним rAF (пропускать «пустые» rAF нельзя: так Unity получал вдвое меньше кадров, а в Android WebView
  // подача кадров рушилась до 1 в секунду). Проверено в Chrome на компьютере: ровно 30 / 60 кадров при пределе 30 / 60.
  (function () {
    var raf = window.requestAnimationFrame.bind(window), next = 0;
    window.ZASLON_MAXFPS = 0;
    // Пропуск кадров проверен только в браузере на компьютере: в приложении для Android предел ставит сама система (частота экрана),
    // а в мобильных браузерах он ломал подачу кадров, поэтому там ограничитель выключен.
    var limiterOk = !window.ZaslonAndroid && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    window.requestAnimationFrame = function (cb) {
      // ограничиваем ТОЛЬКО главный цикл Unity: рядом крутится второй rAF-цикл самого загрузчика (замер частоты), его нельзя трогать
      var m = limiterOk && cb && cb.name === 'Browser_mainLoop_runner' ? window.ZASLON_MAXFPS : 0;
      var run = function (t) {
        if (m > 0) { var period = 1000 / m; next = (t - next > period) ? t + period : next + period; }
        cb(t);
      };
      if (m > 0) {
        var wait = next - performance.now() - 5;
        if (wait > 1) return setTimeout(function () { raf(run); }, wait);
      }
      return raf(run);
    };
    // Частота экрана: меряем интервалы настоящего rAF (ограничитель на них не влияет) и держим максимум оценок. Тяжёлый кадр игры растягивает
    // интервалы и занижает оценку, поэтому занижение не запоминаем: берём наибольшее значение, а округляем до обычных частот экранов.
    window.ZASLON_REFRESH = 60;
    (function () {
      var ds = [], lt = 0, n = 0, rates = [30, 45, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240];
      raf(function tick(t) {
        if (lt) { ds.push(t - lt); if (ds.length > 90) ds.shift(); }
        lt = t;
        if (++n % 45 === 0 && ds.length >= 30) {
          var s = ds.slice().sort(function (a, b) { return a - b; });
          var p = s[Math.floor(s.length * 0.25)];
          if (p > 3 && p < 40) {
            var hz = 1000 / p, best = Math.round(hz);
            for (var i = 0; i < rates.length; i++) if (Math.abs(hz - rates[i]) / rates[i] < 0.06) { best = rates[i]; break; }
            if (best > window.ZASLON_REFRESH || n === 45) window.ZASLON_REFRESH = best;
          }
        }
        raf(tick);
      });
    })();
  })();
  var started = false, toastTimer = 0;

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  }
  function fail(msg) {
    if (loader) loader.classList.add('done');
    failText.textContent = String(msg || 'Неизвестная ошибка');
    failBox.hidden = false;
  }
  function say(msg) {
    toast.textContent = msg; toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 5000);
  }
  $('fail-reload').addEventListener('click', function () { location.reload(); });

  // Поворот экрана: игра рассчитана на горизонтальное положение
  function checkOrientation() {
    var portrait = window.innerHeight > window.innerWidth * 1.05;
    rotateBox.hidden = !(isMobile() && portrait);
  }
  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', function () { setTimeout(checkOrientation, 200); });
  checkOrientation();

  // Браузерные действия, которые мешают игре
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });
  window.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return;          // поле ввода текста (код комнаты, позывной) печатает как обычно
    var k = e.key;
    if (k === 'Tab' || k === ' ' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Backspace') e.preventDefault();
  }, { passive: false });
  window.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
  canvas.addEventListener('pointerdown', function () { try { canvas.focus(); } catch (e) { } });
  window.addEventListener('focus', function () { try { canvas.focus(); } catch (e) { } });

  function hasWebGL2() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch (e) { return false; }
  }

  function start() {
    if (started) return; started = true;
    var B = window.ZASLON_BUILD;
    if (!B) {
      fail('Это шаблон страницы. Соберите проект в Unity: меню «Заслон → Сборка → WebGL» (или File → Build Settings → WebGL), '
        + 'затем откройте index.html из папки сборки через веб-сервер (например, GitHub Pages или «python -m http.server»).');
      return;
    }
    if (!hasWebGL2()) {
      fail('Браузер не поддерживает WebGL 2. Обновите браузер или включите аппаратное ускорение в его настройках.');
      return;
    }
    var cfg = B.config;
    cfg.showBanner = function (msg, type) {
      if (type === 'error') { try { console.error(msg); } catch (e) { } fail(msg); }
      else { try { console.warn(msg); } catch (e) { } say(msg); }
    };
    // Старт — в умеренном разрешении (быстрая загрузка), а дальше игра сама выбирает долю от РОДНОГО разрешения экрана:
    // 100% в настройках — это все физические пиксели (например, 3000×2000 на планшете), а не пиксели CSS.
    var dpr = window.devicePixelRatio || 1;
    var q = 0; try { q = parseFloat(new URLSearchParams(location.search).get('dpr')) || 0; } catch (e) { }
    var native = Math.max(0.5, Math.min(dpr, 4));
    cfg.devicePixelRatio = q > 0 ? q : Math.min(native, 1.25);
    cfg.matchWebGLToCanvasSize = true;
    window.ZASLON_BASE_DPR = q > 0 ? q : native;                    // база для настройки разрешения (игра умножает её на долю 0,2…1)

    loadText.textContent = 'Загрузка…';
    var script = document.createElement('script');
    script.src = B.loaderUrl;
    script.onerror = function () { fail('Не найден загрузчик игры (' + B.loaderUrl + '). Откройте страницу через веб-сервер из папки сборки.'); };
    script.onload = function () {
      window.createUnityInstance(canvas, cfg, function (p) {
        var pct = Math.round(p * 100);
        barFill.style.width = pct + '%';
        loadText.textContent = p < 0.9 ? 'Загрузка… ' + pct + '%' : 'Запуск…';
      }).then(function (inst) {
        window.unityInstance = inst;
        barFill.style.width = '100%';
        loader.classList.add('done');
        setTimeout(function () { loader.style.display = 'none'; }, 600);
        try { canvas.focus(); } catch (e) { }
      }).catch(function (m) { fail(m); });
    };
    document.body.appendChild(script);
  }

  // Сервис-воркер: установка как приложение и запуск без сети. Только по https (на localhost и в приложении для Android он не нужен)
  try {
    if ('serviceWorker' in navigator && location.protocol === 'https:' && !/ZaslonApp\//.test(navigator.userAgent) && location.hostname !== 'appassets.androidplatform.net')
      navigator.serviceWorker.register('sw.js').catch(function () { });
  } catch (e) { }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
