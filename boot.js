// «Заслон» — запуск WebGL-сборки: полоса загрузки, проверка WebGL2, подсказка про поворот экрана, обработка ошибок.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var loader = $('loader'), barFill = $('bar-fill'), loadText = $('load-text');
  var failBox = $('fail'), failText = $('fail-text'), rotateBox = $('rotate'), toast = $('toast');
  var canvas = $('unity-canvas');
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
