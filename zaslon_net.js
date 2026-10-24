// «Заслон» — сетевой мост для WebGL-версии: PeerJS (WebRTC) → запасной канал MQTT. Внутри Unity вызывается через ZaslonNet.jslib.
// Игра (C#) опрашивает очередь событий: ZaslonNet.poll(heap, ptr, cap). Все сообщения — бинарные.
// Кадр события в очереди: [тип u8][cid i32 LE][данные…].
//   1 хост готов · 2 ошибка хоста (строка) · 3 гость пришёл (данные: 0 p2p / 1 mq) · 4 гость ушёл · 5 данные гостя
//   6 гость: канал открыт (0 p2p / 1 mq) · 7 гость: закрыт (причина) · 8 гость: данные · 9 стадия подключения (строка)
(function (root) {
  'use strict';
  var CFG = { peerPrefix: 'zaslon-', mqttBase: 'zaslon/v1/' };
  var STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  // Ключ TURN-ретранслятора Metered — тот же, что у «Лучника», «Ножей», «Фей» и «Стрижей» (в открытом коде для TURN это нормально)
  var TURN_USER = '0eea1dbe53ebb64348d2e282', TURN_PASS = 'IpRgNw5q7HDm5nlk';
  var TURN = ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:80?transport=tcp', 'turn:global.relay.metered.ca:443', 'turns:global.relay.metered.ca:443?transport=tcp']
    .map(function (u) { return { urls: u, username: TURN_USER, credential: TURN_PASS }; });
  var MQ_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  var MQ_SWITCH = 6000;
  var PEER_URLS = ['vendor/peerjs.min.js', 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js', 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'];
  var MQTT_URLS = ['vendor/mqtt.min.js', 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js', 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js'];

  var E = { HOST_READY: 1, HOST_ERROR: 2, GUEST_IN: 3, GUEST_OUT: 4, GUEST_DATA: 5, JOIN_OPEN: 6, JOIN_CLOSED: 7, JOIN_DATA: 8, JOIN_STAGE: 9 };
  var Q = [];
  var enc = new TextEncoder();
  var libs = {};

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function push(type, cid, payload) {
    var p = payload == null ? new Uint8Array(0) : (typeof payload === 'string' ? enc.encode(payload) : payload);
    var out = new Uint8Array(5 + p.length);
    out[0] = type;
    out[1] = cid & 255; out[2] = (cid >> 8) & 255; out[3] = (cid >> 16) & 255; out[4] = (cid >> 24) & 255;
    out.set(p, 5);
    Q.push(out);
  }
  function toU8(d) {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (typeof d === 'string') return enc.encode(d);
    return null;
  }

  function loadLib(urls, test, key) {
    if (test()) return Promise.resolve();
    if (libs[key]) return libs[key];
    libs[key] = new Promise(function (res, rej) {
      var next = function (i) {
        if (i >= urls.length) { libs[key] = null; rej('no-lib'); return; }
        var s = document.createElement('script'); s.src = urls[i]; s.crossOrigin = 'anonymous';
        s.onload = function () { test() ? res() : next(i + 1); };
        s.onerror = function () { s.remove(); next(i + 1); };
        document.head.appendChild(s);
      };
      next(0);
    });
    return libs[key];
  }
  var loadPeer = function () { return loadLib(PEER_URLS, function () { return !!root.Peer; }, 'peer'); };
  var loadMqtt = function () { return loadLib(MQTT_URLS, function () { return !!root.mqtt; }, 'mqtt'); };

  function peerOpts() {
    var o = null; try { o = JSON.parse(lsGet('zaslon_peer') || 'null'); } catch (e) { }
    var ice = STUN.concat(TURN);
    var cfg = { iceServers: ice };
    if (lsGet('zaslon_relay') === '1') cfg.iceTransportPolicy = 'relay';
    return Object.assign({ debug: 1, config: cfg }, o || {});
  }

  // ---------------------------------------------------------------- хост
  var H = { peer: null, conns: new Map(), nextCid: 1, mq: null, gid: null };

  function hostStart(code) {
    hostStop();
    H.gid = code;
    loadPeer().then(function () {
      if (H.gid !== code) return;
      var peer = new root.Peer(CFG.peerPrefix + code, peerOpts());
      H.peer = peer;
      var opened = false;
      peer.on('open', function () { opened = true; push(E.HOST_READY, 0); H.mq = mqttListen(code); });
      peer.on('error', function (e) { if (!opened) { push(E.HOST_ERROR, 0, (e && e.type) || 'error'); try { peer.destroy(); } catch (x) { } } });
      peer.on('disconnected', function () { setTimeout(function () { if (H.peer === peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) { } } }, 2000); });
      peer.on('connection', function (dc) {
        var cid = H.nextCid++;
        var g = { cid: cid, kind: 0, dc: dc, open: false };
        H.conns.set(cid, g);
        dc.on('open', function () { g.open = true; push(E.GUEST_IN, cid, new Uint8Array([0])); });
        dc.on('data', function (d) { var u = toU8(d); if (u) push(E.GUEST_DATA, cid, u); });
        var gone = function () { if (H.conns.get(cid) === g) { H.conns.delete(cid); if (g.open) push(E.GUEST_OUT, cid); } };
        dc.on('close', gone); dc.on('error', gone);
      });
    }, function () { push(E.HOST_ERROR, 0, 'no-lib'); });
    return true;
  }

  function hostStop() {
    var p = H.peer, m = H.mq;
    H.peer = null; H.mq = null; H.gid = null;
    H.conns.forEach(function (g) { try { if (g.dc) g.dc.close(); } catch (e) { } });
    H.conns.clear();
    if (m) setTimeout(function () { m.destroy(); }, 400);
    if (p) setTimeout(function () { try { p.destroy(); } catch (e) { } }, 400);
  }

  // Запасной канал у хоста: слушаем сразу все серверы. Кадры: гость→хозяин на «база/h»: [вид][длина cid][cid][данные], вид 1 привет · 2 жив · 3 данные · 4 пока
  // хозяин→гость на «база/g/cid»: [вид][данные], вид 5 принят · 3 данные · 4 закрыто
  function mqttListen(code) {
    var base = CFG.mqttBase + code;
    var L = { clients: [], guests: new Map(), dead: false, destroy: function () {
      L.dead = true; clearInterval(L.iv);
      L.guests.forEach(function (g) { push(E.GUEST_OUT, g.cid); H.conns.delete(g.cid); });
      L.guests.clear();
      L.clients.forEach(function (c) { try { c.end(true); } catch (e) { } });
    } };
    loadMqtt().then(function () {
      if (L.dead) return;
      MQ_BROKERS.forEach(function (url, bi) {
        var c = root.mqtt.connect(url, { reconnectPeriod: 3000, connectTimeout: 8000, clean: true, keepalive: 20 });
        L.clients.push(c);
        c.on('connect', function () { c.subscribe(base + '/h', { qos: 0 }); });
        c.on('error', function () { });
        c.on('message', function (tp, buf) {
          var u = toU8(buf); if (!u || u.length < 2) return;
          var kind = u[0], n = u[1];
          if (u.length < 2 + n || n === 0 || n > 24) return;
          var cidStr = String.fromCharCode.apply(null, u.subarray(2, 2 + n));
          var payload = u.subarray(2 + n);
          var key = bi + ':' + cidStr, out = base + '/g/' + cidStr;
          var g = L.guests.get(key);
          if (kind === 1) {
            if (g) { L.guests.delete(key); H.conns.delete(g.cid); push(E.GUEST_OUT, g.cid); }
            var cid = H.nextCid++;
            g = { cid: cid, kind: 1, seen: Date.now(), key: key, client: c, out: out, open: true };
            L.guests.set(key, g); H.conns.set(cid, g);
            push(E.GUEST_IN, cid, new Uint8Array([1]));
            c.publish(out, new Uint8Array([5]));
          } else if (!g) {
            if (kind === 3 || kind === 2) c.publish(out, new Uint8Array([4]));
          } else if (kind === 2) g.seen = Date.now();
          else if (kind === 3) { g.seen = Date.now(); push(E.GUEST_DATA, g.cid, new Uint8Array(payload)); }
          else if (kind === 4) { L.guests.delete(key); H.conns.delete(g.cid); push(E.GUEST_OUT, g.cid); }
        });
      });
    }, function () { });
    L.iv = setInterval(function () {
      var now = Date.now();
      L.guests.forEach(function (g, k) { if (now - g.seen > 15000) { L.guests.delete(k); H.conns.delete(g.cid); push(E.GUEST_OUT, g.cid); } });
    }, 3000);
    return L;
  }

  function hostSend(cid, u8) {
    var g = H.conns.get(cid); if (!g) return;
    try {
      if (g.kind === 0) { if (g.dc && g.dc.open) g.dc.send(u8); }
      else {
        var f = new Uint8Array(1 + u8.length); f[0] = 3; f.set(u8, 1);
        g.client.publish(g.out, f);
      }
    } catch (e) { }
  }
  function hostClose(cid) {
    var g = H.conns.get(cid); if (!g) return;
    setTimeout(function () {
      try {
        if (g.kind === 0) { if (g.dc) g.dc.close(); }
        else { g.client.publish(g.out, new Uint8Array([4])); }
      } catch (e) { }
      H.conns.delete(cid);
      if (g.kind === 1 && g.key) { try { var l = H.mq; if (l) l.guests.delete(g.key); } catch (e) { } }
    }, 300);
  }

  // ---------------------------------------------------------------- гость
  var G = { cur: null };

  function guestStart(code) {
    guestStop();
    var S = { code: code, closed: false, chosen: null, p: null, m: null, timers: [], reason: '' };
    G.cur = S;
    var stage = function (s) { if (G.cur === S && !S.chosen) push(E.JOIN_STAGE, 0, s); };
    var finish = function (reason) {
      if (S.closed) return; S.closed = true;
      S.timers.forEach(clearTimeout);
      if (S.p) S.p.close(); if (S.m) S.m.close();
      push(E.JOIN_CLOSED, 0, reason || 'closed');
    };
    var choose = function (t) {
      if (S.chosen || S.closed) { t.close(); return; }
      S.chosen = t;
      if (t !== S.p && S.p) S.p.close();
      if (t !== S.m && S.m) S.m.close();
      S.timers.forEach(clearTimeout);
      push(E.JOIN_OPEN, 0, new Uint8Array([t.kind]));
      keepAwake();
    };
    var lostBoth = function () {
      if (S.chosen || S.closed) return;
      if (S.p.dead && (!S.m || S.m.dead)) finish((S.m && S.m.err === 'no-answer' && S.p.err !== 'peer-unavailable') ? 'no-answer' : (S.p.err || (S.m && S.m.err) || 'timeout'));
    };
    S.p = peerGuest(code, S, stage, choose, function (t) {
      if (S.chosen === t) finish(t.err || 'closed'); else { t.dead = true; startMq(); lostBoth(); }
    });
    var startMq = function () {
      if (S.m || S.closed || S.chosen) return;
      stage('backup');
      S.m = mqttGuest(code, S, choose, function (t) { if (S.chosen === t) finish(t.err || 'closed'); else { t.dead = true; lostBoth(); } });
    };
    S.timers.push(setTimeout(startMq, MQ_SWITCH));
    // запасной срок: ничего не открылось за 25 с
    S.timers.push(setTimeout(function () { if (!S.chosen && !S.closed) { if (S.p) S.p.close(); if (S.m) S.m.close(); finish(S.p && S.p.err ? S.p.err : 'timeout'); } }, 25000));
    return true;
  }

  function guestStop() {
    var S = G.cur; G.cur = null;
    if (!S) return;
    S.closed = true; S.timers.forEach(clearTimeout);
    if (S.p) S.p.close(); if (S.m) S.m.close();
    releaseWake();
  }

  function peerGuest(code, S, stage, onOpen, onDead) {
    var t = { kind: 0, dead: false, err: '', peer: null, dc: null, send: null, close: null };
    var types = {};
    t.close = function () { t.dead = true; try { if (t.peer) t.peer.destroy(); } catch (e) { } };
    t.send = function (u8) { if (t.dc && t.dc.open) t.dc.send(u8); };
    var fail = function (err) { if (t.dead) return; t.err = err; t.dead = true; try { if (t.peer) t.peer.destroy(); } catch (e) { } onDead(t); };
    loadPeer().then(function () {
      if (t.dead || S.closed) return;
      var peer = new root.Peer(peerOpts()); t.peer = peer;
      peer.on('error', function (e) { if (!t.dead && !S.chosen) fail((e && e.type) || 'error'); });
      peer.on('open', function () {
        if (t.dead) return;
        var dc = peer.connect(CFG.peerPrefix + code, { reliable: true }); t.dc = dc;
        var pc = dc.peerConnection;
        if (pc) pc.addEventListener('iceconnectionstatechange', function () { if (!S.chosen) stage(pc.iceConnectionState === 'checking' ? 'checking' : (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed' ? 'connected' : pc.iceConnectionState)); });
        stage('offer');
        dc.on('open', function () { if (!t.dead) onOpen(t); });
        dc.on('data', function (d) { if (S.chosen === t) { var u = toU8(d); if (u) push(E.JOIN_DATA, 0, u); } });
        dc.on('close', function () { fail('closed'); });
        dc.on('error', function (e) { fail((e && e.type) || 'dc-error'); });
      });
    }, function () { fail('no-lib'); });
    // не нашли друг друга за 20 с (если путь уже найден — ждём дольше)
    setTimeout(function () {
      if (t.dead || S.chosen || S.closed) return;
      var pc = t.dc && t.dc.peerConnection, st = pc && pc.iceConnectionState;
      if (pc && pc.remoteDescription && /checking|connected|completed/.test(st || '')) { setTimeout(function () { if (!t.dead && !S.chosen) fail('timeout'); }, 25000); return; }
      fail(!t.dc ? (t.peer && t.peer.open ? 'timeout' : 'no-signal') : (pc && !pc.remoteDescription ? 'no-answer' : 'timeout'));
    }, 20000);
    return t;
  }

  function mqttGuest(code, S, onOpen, onDead) {
    var t = { kind: 1, dead: false, err: '', clients: [], win: null, cid: '', ka: null, send: null, close: null };
    var cidChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 10; i++) t.cid += cidChars[Math.floor(Math.random() * cidChars.length)];
    var base = CFG.mqttBase + code, cidB = enc.encode(t.cid);
    var frame = function (kind, payload) {
      var p = payload || new Uint8Array(0);
      var f = new Uint8Array(2 + cidB.length + p.length); f[0] = kind; f[1] = cidB.length; f.set(cidB, 2); f.set(p, 2 + cidB.length); return f;
    };
    var fail = function (err) {
      if (t.dead) return; t.dead = true; t.err = err; clearInterval(t.ka);
      t.clients.forEach(function (c) { try { c.end(true); } catch (e) { } });
      onDead(t);
    };
    t.close = function () {
      if (t.dead) return; t.dead = true; clearInterval(t.ka);
      t.clients.forEach(function (c) { try { c.publish(base + '/h', frame(4)); c.end(false); } catch (e) { } });
    };
    t.send = function (u8) { if (t.win) t.win.publish(base + '/h', frame(3, u8)); };
    var okT = null;
    loadMqtt().then(function () {
      if (t.dead || S.closed) return;
      MQ_BROKERS.forEach(function (url) {
        var c = root.mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 6000, clean: true, keepalive: 20 });
        t.clients.push(c);
        c.on('connect', function () { c.subscribe(base + '/g/' + t.cid, { qos: 0 }, function () { c.publish(base + '/h', frame(1)); }); });
        c.on('message', function (tp, buf) {
          var u = toU8(buf); if (!u || u.length < 1) return;
          if (!t.win) {
            if (u[0] !== 5 || t.dead) return;
            t.win = c; clearTimeout(okT);
            t.clients.forEach(function (o) { if (o !== c) { try { o.publish(base + '/h', frame(4)); o.end(false); } catch (e) { } } });
            t.clients = [c];
            t.ka = setInterval(function () { if (t.win === c) c.publish(base + '/h', frame(2)); }, 4000);
            onOpen(t);
            return;
          }
          if (t.win !== c) return;
          if (u[0] === 3) { if (S.chosen === t) push(E.JOIN_DATA, 0, new Uint8Array(u.subarray(1))); }
          else if (u[0] === 4) fail('closed');
        });
        c.on('error', function () { t.err = 'mq-error'; });
        c.on('close', function () { c.__dead = true; if (t.win === c) fail('closed'); else if (!t.win && t.clients.every(function (x) { return x.__dead; })) fail(t.err || 'mq-fail'); });
      });
      okT = setTimeout(function () { if (!t.win) fail('no-answer'); }, 9000);
    }, function () { fail('no-lib'); });
    return t;
  }

  // ---------------------------------------------------------------- экран не гаснет
  var wake = null;
  function keepAwake() {
    if (wake || document.hidden || !navigator.wakeLock) return;
    wake = 'pending';
    navigator.wakeLock.request('screen').then(function (l) { if (wake !== 'pending') { l.release().catch(function () { }); return; } wake = l; l.addEventListener('release', function () { if (wake === l) wake = null; }); }, function () { if (wake === 'pending') wake = null; });
  }
  function releaseWake() { var l = wake; wake = null; if (l && l !== 'pending') l.release().catch(function () { }); }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { if (G.cur && G.cur.chosen) keepAwake(); if (H.peer && H.peer.disconnected && !H.peer.destroyed) { try { H.peer.reconnect(); } catch (e) { } } }
  });

  // ---------------------------------------------------------------- Unity
  var api = {
    version: 1,
    E: E,
    available: function () { return true; },
    hostStart: hostStart, hostStop: hostStop,
    guestStart: guestStart, guestStop: guestStop,
    send: function (cid, u8) {
      if (cid < 0) { var S = G.cur; if (S && S.chosen) { try { S.chosen.send(u8); } catch (e) { } } }
      else hostSend(cid, u8);
    },
    closeConn: hostClose,
    // Отдаёт следующее событие: копирует в память игры, возвращает длину; 0 — пусто; отрицательное — буфер мал (нужно -N байт)
    poll: function (heap, ptr, cap) {
      if (Q.length === 0) return 0;
      var e = Q[0];
      if (e.length > cap) return -e.length;
      Q.shift();
      heap.set(e, ptr);
      return e.length;
    },
    queueLength: function () { return Q.length; },
    _push: push, _toU8: toU8,
    copyText: function (s) {
      try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s); return; } } catch (e) { }
      var ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { } ta.remove();
    },
    share: function (title, url) {
      if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () { }); }
      else api.copyText(url);
    },
    urlParam: function (name) {
      var v = '';
      try { v = new URLSearchParams(location.search).get(name) || ''; } catch (e) { }
      if (!v) { var m = new RegExp('[#&]' + name + '=([^&]*)').exec(location.hash || ''); if (m) v = decodeURIComponent(m[1]); }
      return v;
    },
    isMobile: function () { return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); },
    fullscreen: function () {
      try {
        if (!document.fullscreenElement) { var el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || function () { }).call(el); }
        else (document.exitFullscreen || document.webkitExitFullscreen || function () { }).call(document);
      } catch (e) { }
    },
    vibrate: function (ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { } },
  };
  root.ZaslonNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
