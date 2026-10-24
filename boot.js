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
    // на телефонах рисуем в меньшем разрешении: так заметно плавнее
    var dpr = window.devicePixelRatio || 1;
    var q = 0; try { q = parseFloat(new URLSearchParams(location.search).get('dpr')) || 0; } catch (e) { }
    cfg.devicePixelRatio = q > 0 ? q : Math.min(dpr, 1.25);          // выше 1,25 кадры заметно дороже, а картинка почти не выигрывает
    cfg.matchWebGLToCanvasSize = true;

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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
