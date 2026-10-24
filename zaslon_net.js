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
  var MQ_SWITCH = 6000, MQ_MAX_WAIT = 16000, MQ_GRACE = 3500;      // когда включать запасной канал; предел ожидания прямого; льгота прямому каналу после готовности запасного
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
    var S = { ready: false, tries: 0 };
    var ready = function () { if (H.gid !== code || S.ready) return; S.ready = true; push(E.HOST_READY, 0); };
    // Запасной канал (MQTT) поднимаем сразу, не дожидаясь сервера знакомств PeerJS: комната доступна, даже если тот ответил не с первого раза.
    H.mq = mqttListen(code, ready);
    keepAwake();                                      // у хозяина экран не должен гаснуть: игра считается у него
    var attempt = function () {
      if (H.gid !== code) return;
      loadPeer().then(function () {
        if (H.gid !== code) return;
        var peer = new root.Peer(CFG.peerPrefix + code, peerOpts());
        H.peer = peer;
        var opened = false, rec = 0;
        peer.on('open', function () { opened = true; ready(); });
        peer.on('error', function (e) {
          var type = (e && e.type) || 'error';
          if (opened) return;
          try { peer.destroy(); } catch (x) { }
          if (H.peer === peer) H.peer = null;
          if (H.gid !== code) return;
          S.tries++;
          if (type === 'unavailable-id' && S.tries === 1) { push(E.HOST_ERROR, 0, type); return; }      // код занят: игра выберет другой
          if (S.tries < 7) { setTimeout(attempt, Math.min(8000, 1500 * S.tries)); return; }               // сервер знакомств не ответил — пробуем ещё
          if (!S.ready) push(E.HOST_ERROR, 0, type);
        });
        // сервер знакомств оборвал связь: возвращаемся, пока не получится (канал уже открытых игроков от этого не страдает)
        peer.on('disconnected', function () {
          if (rec) return;
          rec = setInterval(function () {
            if (H.peer !== peer || peer.destroyed || !peer.disconnected) { clearInterval(rec); rec = 0; return; }
            try { peer.reconnect(); } catch (e) { }
          }, 2500);
        });
        peer.on('connection', function (dc) {
          var cid = H.nextCid++;
          var g = { cid: cid, kind: 0, dc: dc, open: false };
          H.conns.set(cid, g);
          dc.on('open', function () { g.open = true; push(E.GUEST_IN, cid, new Uint8Array([0])); });
          dc.on('data', function (d) { var u = toU8(d); if (u) push(E.GUEST_DATA, cid, u); });
          var gone = function () { if (H.conns.get(cid) === g) { H.conns.delete(cid); if (g.open) push(E.GUEST_OUT, cid); } };
          dc.on('close', gone); dc.on('error', gone);
        });
      }, function () { if (!S.ready) push(E.HOST_ERROR, 0, 'no-lib'); });
    };
    attempt();
    return true;
  }

  function hostStop() {
    var p = H.peer, m = H.mq;
    H.peer = null; H.mq = null; H.gid = null;
    if (!G.cur) releaseWake();
    H.conns.forEach(function (g) { try { if (g.dc) g.dc.close(); } catch (e) { } });
    H.conns.clear();
    if (m) setTimeout(function () { m.destroy(); }, 400);
    if (p) setTimeout(function () { try { p.destroy(); } catch (e) { } }, 400);
  }

  // Запасной канал у хоста: слушаем сразу все серверы. Кадры: гость→хозяин на «база/h»: [вид][длина cid][cid][данные], вид 1 привет · 2 жив · 3 данные · 4 пока
  // хозяин→гость на «база/g/cid»: [вид][данные], вид 5 принят · 3 данные · 4 закрыто
  // Публичные брокеры режут частые сообщения (EMQX отдаёт не больше ~10 в секунду на подписчика, остальное теряет и затем разрывает связь),
  // поэтому по запасному каналу всё, что накопилось за MQ_BATCH мс, уходит ОДНИМ сообщением (вид 7: [длина u16 LE][данные]…).
  // Возможность «умею пачки» стороны сообщают при знакомстве (вид 1/6: байт возможностей у гостя, ответ 5: байт у хозяина), так что старые версии не ломаются.
  var MQ_CAP = 2, MQ_BATCH = 110;
  function packBatch(q) {
    var n = 0, i, p = 0;
    for (i = 0; i < q.length; i++) n += 2 + q[i].length;
    var out = new Uint8Array(n);
    for (i = 0; i < q.length; i++) { var len = q[i].length; out[p++] = len & 255; out[p++] = (len >> 8) & 255; out.set(q[i], p); p += len; }
    return out;
  }
  function unbatch(u8, cb) {
    var p = 0;
    while (p + 2 <= u8.length) {
      var len = u8[p] | (u8[p + 1] << 8); p += 2;
      if (p + len > u8.length) break;
      cb(new Uint8Array(u8.subarray(p, p + len))); p += len;
    }
  }
  // Складывает сообщение в очередь o и один раз за окно отправляет всё накопленное через flush(пакет)
  function batchAdd(o, u8, flush) {
    o.q.push(u8);
    if (!o.timer) o.timer = setTimeout(function () {
      o.timer = 0;
      var q = o.q; o.q = [];
      if (q.length) flush(packBatch(q));
    }, MQ_BATCH);
  }

  function mqttListen(code, onReady) {
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
        c.on('connect', function () { c.subscribe(base + '/h', { qos: 0 }, function (err) { if (!err && !L.dead && onReady) onReady(); }); });
        c.on('error', function () { });
        c.on('message', function (tp, buf) {
          var u = toU8(buf); if (!u || u.length < 2) return;
          var kind = u[0], n = u[1];
          if (u.length < 2 + n || n === 0 || n > 24) return;
          var cidStr = String.fromCharCode.apply(null, u.subarray(2, 2 + n));
          var payload = u.subarray(2 + n);
          var key = bi + ':' + cidStr, out = base + '/g/' + cidStr;
          var g = L.guests.get(key);
          if (kind === 1 || (kind === 6 && !g)) {
            // привет (или повтор привета, если первый потерялся): заводим гостя
            if (g) { L.guests.delete(key); H.conns.delete(g.cid); push(E.GUEST_OUT, g.cid); }
            var cid = H.nextCid++;
            g = { cid: cid, kind: 1, seen: Date.now(), key: key, client: c, out: out, open: true, cap: payload.length > 0 ? payload[0] : 0, o: { q: [], timer: 0 } };
            L.guests.set(key, g); H.conns.set(cid, g);
            push(E.GUEST_IN, cid, new Uint8Array([1]));
            c.publish(out, new Uint8Array([5, MQ_CAP]));
          } else if (kind === 6) {
            g.seen = Date.now(); c.publish(out, new Uint8Array([5, MQ_CAP]));       // ответ «принят» потерялся — повторяем
          } else if (!g) {
            if (kind === 3 || kind === 2 || kind === 7) c.publish(out, new Uint8Array([4]));
          } else if (kind === 2) g.seen = Date.now();
          else if (kind === 3) { g.seen = Date.now(); push(E.GUEST_DATA, g.cid, new Uint8Array(payload)); }
          else if (kind === 7) { g.seen = Date.now(); unbatch(payload, function (m) { push(E.GUEST_DATA, g.cid, m); }); }
          else if (kind === 4) { L.guests.delete(key); H.conns.delete(g.cid); push(E.GUEST_OUT, g.cid); }
        });
      });
    }, function () { });
    L.iv = setInterval(function () {
      var now = Date.now();
      L.guests.forEach(function (g, k) { if (now - g.seen > 20000) { L.guests.delete(k); H.conns.delete(g.cid); push(E.GUEST_OUT, g.cid); } });
    }, 3000);
    return L;
  }

  function hostSend(cid, u8) {
    var g = H.conns.get(cid); if (!g) return;
    try {
      if (g.kind === 0) { if (g.dc && g.dc.open) g.dc.send(u8); }
      else if (g.cap >= 2 && u8.length < 60000) {
        batchAdd(g.o, u8, function (pack) { var f = new Uint8Array(1 + pack.length); f[0] = 7; f.set(pack, 1); try { g.client.publish(g.out, f); } catch (e) { } });
      } else {
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
    var S = { code: code, closed: false, chosen: null, p: null, m: null, timers: [], reason: '', t0: Date.now(), waiting: null, waited: false };
    G.cur = S;
    var stage = function (s) { if (G.cur === S && !S.chosen) push(E.JOIN_STAGE, 0, s); };
    var finish = function (reason) {
      if (S.closed) return; S.closed = true;
      S.timers.forEach(clearTimeout);
      if (S.p) S.p.close(); if (S.m) S.m.close();
      push(E.JOIN_CLOSED, 0, reason || 'closed');
    };
    // Прямой канал (WebRTC) намного лучше запасного (публичные брокеры теряют и режут сообщения), поэтому, пока он ещё строится, запасной не торопим.
    var p2pBusy = function () {
      var t = S.p; if (!t || t.dead) return false;
      var pc = t.dc && t.dc.peerConnection;
      if (!pc) return false;                                          // сервер знакомств молчит или канал ещё не создан: ждать нечего
      var st = pc.iceConnectionState;
      return st === 'new' || st === 'checking' || st === 'connected' || st === 'completed';
    };
    var commit = function (t) {
      if (S.chosen || S.closed) { t.close(); return; }
      S.chosen = t;
      if (t !== S.p && S.p) S.p.close();
      if (t !== S.m && S.m) S.m.close();
      S.timers.forEach(clearTimeout);
      push(E.JOIN_OPEN, 0, new Uint8Array([t.kind]));
      keepAwake();
    };
    var choose = function (t) {
      if (S.chosen || S.closed) { t.close(); return; }
      if (t.kind === 1 && !S.waited && p2pBusy()) {
        // запасной канал открылся раньше, но прямой на подходе: даём ему несколько секунд
        S.waited = true; S.waiting = t;
        S.timers.push(setTimeout(function () { var w = S.waiting; S.waiting = null; if (w && !w.dead && !S.chosen && !S.closed) commit(w); }, MQ_GRACE));
        return;
      }
      commit(t);
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
    var mqGate = function () {
      if (S.m || S.closed || S.chosen) return;
      if (Date.now() - S.t0 < MQ_MAX_WAIT && p2pBusy()) { S.timers.push(setTimeout(mqGate, 1000)); return; }
      startMq();
    };
    S.timers.push(setTimeout(mqGate, MQ_SWITCH));
    // запасной срок: ничего не открылось за 25 с
    S.timers.push(setTimeout(function () { if (!S.chosen && !S.closed) { if (S.p) S.p.close(); if (S.m) S.m.close(); finish(S.p && S.p.err ? S.p.err : 'timeout'); } }, 40000));
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
    var t = { kind: 1, dead: false, err: '', clients: [], win: null, cid: '', ka: null, hi: null, cap: 0, o: { q: [], timer: 0 }, lastTx: 0, send: null, close: null };
    var cidChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 10; i++) t.cid += cidChars[Math.floor(Math.random() * cidChars.length)];
    var base = CFG.mqttBase + code, cidB = enc.encode(t.cid);
    var frame = function (kind, payload) {
      var p = payload || new Uint8Array(0);
      var f = new Uint8Array(2 + cidB.length + p.length); f[0] = kind; f[1] = cidB.length; f.set(cidB, 2); f.set(p, 2 + cidB.length); return f;
    };
    var fail = function (err) {
      if (t.dead) return; t.dead = true; t.err = err; clearInterval(t.ka); clearInterval(t.hi);
      t.clients.forEach(function (c) { try { c.end(true); } catch (e) { } });
      onDead(t);
    };
    t.close = function () {
      if (t.dead) return; t.dead = true; clearInterval(t.ka); clearInterval(t.hi);
      t.clients.forEach(function (c) { try { c.publish(base + '/h', frame(4)); c.end(false); } catch (e) { } });
    };
    t.send = function (u8) {
      if (!t.win) return;
      t.lastTx = Date.now();
      if (t.cap >= 2 && u8.length < 60000) batchAdd(t.o, u8, function (pack) { try { if (t.win) t.win.publish(base + '/h', frame(7, pack)); } catch (e) { } });
      else t.win.publish(base + '/h', frame(3, u8));
    };
    var okT = null;
    loadMqtt().then(function () {
      if (t.dead || S.closed) return;
      var hello = function (kind) { t.clients.forEach(function (c) { if (c.connected) { try { c.publish(base + '/h', frame(kind, new Uint8Array([MQ_CAP]))); } catch (e) { } } }); };
      MQ_BROKERS.forEach(function (url) {
        var c = root.mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 6000, clean: true, keepalive: 20 });
        t.clients.push(c);
        c.on('connect', function () { c.subscribe(base + '/g/' + t.cid, { qos: 0 }, function () { try { c.publish(base + '/h', frame(1, new Uint8Array([MQ_CAP]))); } catch (e) { } }); });
        c.on('message', function (tp, buf) {
          var u = toU8(buf); if (!u || u.length < 1) return;
          if (!t.win) {
            if (u[0] !== 5 || t.dead) return;
            t.win = c; clearTimeout(okT); clearInterval(t.hi);
            t.cap = u.length > 1 ? u[1] : 0;
            t.clients.forEach(function (o) { if (o !== c) { try { o.publish(base + '/h', frame(4)); o.end(false); } catch (e) { } } });
            t.clients = [c];
            t.lastTx = Date.now();
            t.ka = setInterval(function () { if (t.win === c && Date.now() - t.lastTx > 3000) { t.lastTx = Date.now(); c.publish(base + '/h', frame(2)); } }, 2000);
            onOpen(t);
            return;
          }
          if (t.win !== c) return;
          if (u[0] === 3) { if (S.chosen === t) push(E.JOIN_DATA, 0, new Uint8Array(u.subarray(1))); }
          else if (u[0] === 7) { if (S.chosen === t) unbatch(u.subarray(1), function (m) { push(E.JOIN_DATA, 0, m); }); }
          else if (u[0] === 4) fail('closed');
        });
        c.on('error', function () { t.err = 'mq-error'; });
        c.on('close', function () { c.__dead = true; if (t.win === c) fail('closed'); else if (!t.win && t.clients.every(function (x) { return x.__dead; })) fail(t.err || 'mq-fail'); });
      });
      // привет мог уйти раньше, чем хозяин подписался на этом брокере (сообщения без хранения не ждут): повторяем, пока нас не примут
      t.hi = setInterval(function () { if (!t.win && !t.dead) hello(6); }, 1500);
      okT = setTimeout(function () { if (!t.win) fail('no-answer'); }, 10000);
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
    if (!document.hidden) { if ((G.cur && G.cur.chosen) || H.gid) keepAwake(); if (H.peer && H.peer.disconnected && !H.peer.destroyed) { try { H.peer.reconnect(); } catch (e) { } } }
  });

  // ---------------------------------------------------------------- мышь
  // Свой захват указателя: Cursor.lockState в WebGL ненадёжен — Unity не всегда узнаёт, что браузер снял захват по Esc,
  // после чего положение курсора «замирает» и кнопки меню не нажимаются. Здесь: захват внутри клика (требование браузера),
  // точные приращения movementX/Y (без ускорения ОС, если браузер умеет) и флаг «захват потерян» — это и есть нажатие Esc в бою.
  var M = { inited: false, want: false, locked: false, exiting: false, lostLock: false, dx: 0, dy: 0 };
  function gameCanvas() { return document.getElementById('unity-canvas') || document.querySelector('canvas'); }
  function lockNow() {
    var c = gameCanvas(); if (!c || !c.requestPointerLock) return;
    try {
      var p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(function () { try { var q = c.requestPointerLock(); if (q && q.catch) q.catch(function () { }); } catch (e) { } });
    } catch (e) { try { c.requestPointerLock(); } catch (e2) { } }
  }
  function mouseInit() {
    if (M.inited) return; M.inited = true;
    document.addEventListener('pointerlockchange', function () {
      var was = M.locked; M.locked = !!document.pointerLockElement;
      if (was && !M.locked) { if (!M.exiting) M.lostLock = true; M.exiting = false; M.dx = M.dy = 0; }
    });
    document.addEventListener('mousemove', function (e) { if (M.locked) { M.dx += e.movementX || 0; M.dy += e.movementY || 0; } }, true);
    document.addEventListener('mousedown', function (e) {
      var c = gameCanvas();
      if (M.want && !M.locked && c && (e.target === c)) lockNow();
    }, true);
  }
  mouseInit();

  // ---------------------------------------------------------------- ввод текста
  // Поле ввода рисует игра, а печатать удобнее в настоящем элементе страницы: он ставится ровно поверх поля и вызывает обычную
  // экранную клавиатуру телефона. Игра читает значение каждый кадр (textValue/textActive). Координаты — доли окна игры (0…1).
  var TX = { el: null, open: false, id: 0, value: '', mode: 0, max: 0, orig: '' };
  var CODE_OK = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // алфавит кода комнаты (без похожих I, O, 0, 1)
  function txFilter(s, mode, max) {
    s = String(s == null ? '' : s);
    if (mode === 1) {
      s = s.toUpperCase();
      var o = '';
      for (var i = 0; i < s.length; i++) if (CODE_OK.indexOf(s.charAt(i)) >= 0) o += s.charAt(i);
      s = o;
    } else s = s.replace(/[\u0000-\u001f\u007f]/g, '');
    if (max > 0 && s.length > max) s = s.slice(0, max);
    return s;
  }
  // Клавиши в поле принадлежат полю, а не игре: Unity ловит клавиатуру на window и гасит нажатия (Backspace, Enter), поэтому перехватываем
  // раньше него (этот обработчик подключён первым) и не пускаем событие дальше; сам ввод в поле от этого не страдает.
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      if (!TX.el || e.target !== TX.el) return;
      if (t === 'keydown') {
        if (e.key === 'Enter') { e.preventDefault(); textClose(false); }
        else if (e.key === 'Escape') { e.preventDefault(); textClose(true); }
      }
      e.stopImmediatePropagation();
    }, true);
  });
  function txEnsure() {
    if (TX.el) return TX.el;
    var el = document.createElement('input');
    el.type = 'text'; el.id = 'zaslon-text';
    el.setAttribute('autocomplete', 'off'); el.setAttribute('autocorrect', 'off'); el.setAttribute('spellcheck', 'false');
    el.setAttribute('enterkeyhint', 'done');
    var st = el.style;
    st.position = 'fixed'; st.zIndex = '15'; st.display = 'none'; st.margin = '0'; st.border = '2px solid #40c7ff'; st.borderRadius = '0';
    st.outline = 'none'; st.background = '#050d14'; st.color = '#fff'; st.caretColor = '#40c7ff'; st.boxSizing = 'border-box';
    st.padding = '0 12px'; st.fontFamily = '"Inter","Segoe UI","Roboto",Arial,sans-serif'; st.fontWeight = '600';
    st.webkitUserSelect = 'text'; st.userSelect = 'text'; st.touchAction = 'manipulation'; st.webkitAppearance = 'none'; st.appearance = 'none';
    el.addEventListener('input', function () {
      var f = txFilter(el.value, TX.mode, TX.max);
      if (f !== el.value) el.value = f;
      TX.value = f;
    });
    el.addEventListener('blur', function () { if (TX.open) textClose(false); });
    (document.getElementById('stage') || document.body).appendChild(el);      // внутри #stage: при подъёме игры над клавиатурой поле едет вместе с ней
    TX.el = el;
    return el;
  }
  function textOpen(x, y, w, h, value, max, mode, id, via) {
    var el = txEnsure();
    var c = gameCanvas();
    var r = c ? c.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    var st = el.style;
    st.left = (r.left + x * r.width) + 'px'; st.top = (r.top + y * r.height) + 'px';
    st.width = (w * r.width) + 'px'; st.height = (h * r.height) + 'px';
    st.fontSize = Math.max(14, Math.round(h * r.height * 0.46)) + 'px';
    st.letterSpacing = mode === 1 ? '0.14em' : '0';
    st.textTransform = mode === 1 ? 'uppercase' : 'none';
    el.setAttribute('autocapitalize', mode === 1 ? 'characters' : 'words');
    el.setAttribute('inputmode', 'text');
    TX.mode = mode | 0; TX.max = max | 0; TX.id = id | 0;
    el.maxLength = 256;                                  // длину режет txFilter: так вставка длинного текста («AB-C234») не обрезается до фильтра
    el.value = txFilter(value, TX.mode, TX.max);
    TX.value = el.value; TX.orig = el.value; TX.open = true; TX.lift = 0;
    st.display = 'block';
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { }
    txLift();
  }
  // Высота экранной клавиатуры (CSS-пиксели) приходит из приложения. Если она перекрывает поле — приподнимаем игру, чтобы поле было видно.
  var IME = { h: 0, known: false };
  function isTouchEnv() { return navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent); }
  function txLift() {
    var stage = document.getElementById('stage'); if (!stage) return;
    var shift = 0;
    if (TX.open && TX.el) {
      var kb = IME.known ? IME.h : (isTouchEnv() ? window.innerHeight * 0.58 : 0);
      var r = TX.el.getBoundingClientRect();
      var lift = TX.lift || 0;
      var top0 = r.top + lift, bottom0 = r.bottom + lift;                   // положение без подъёма
      if (kb > 0) shift = Math.max(0, bottom0 + 14 - (window.innerHeight - kb));
      shift = Math.min(shift, Math.max(0, top0 - 8));                       // верх поля не должен уйти за экран
    }
    TX.lift = shift;
    stage.style.transition = 'transform .18s ease';
    stage.style.transform = shift > 0 ? 'translateY(' + (-shift) + 'px)' : '';
  }
  function textClose(cancel) {
    if (!TX.open) return;
    TX.open = false;
    if (cancel && TX.el) { TX.value = TX.orig; TX.el.value = TX.orig; }
    if (TX.el) { TX.el.style.display = 'none'; try { TX.el.blur(); } catch (e) { } }
    txLift();
    var c = gameCanvas(); if (c) { try { c.focus(); } catch (e) { } }
  }
  // касание игры вне поля закрывает ввод (клавиатура уходит)
  document.addEventListener('pointerdown', function (e) { if (TX.open && e.target !== TX.el) textClose(false); }, true);

  // Браузер показывает экранную клавиатуру только если поле получило фокус прямо внутри касания пользователя, а игра узнаёт о касании лишь на
  // следующем кадре. Поэтому игра каждый кадр сообщает, где у неё нарисованы поля (textReg), а касание по такому месту открывает поле здесь же, в обработчике.
  var REG = {};
  function textReg(id, x, y, w, h, value, max, mode) { REG[id] = { x: x, y: y, w: w, h: h, value: value, max: max, mode: mode, t: Date.now() }; }
  function regAt(cx, cy) {
    var c = gameCanvas(); if (!c) return 0;
    var r = c.getBoundingClientRect(), now = Date.now();
    for (var id in REG) {
      var g = REG[id];
      if (now - g.t > 700) { delete REG[id]; continue; }
      var l = r.left + g.x * r.width, t = r.top + g.y * r.height;
      if (cx >= l && cx <= l + g.w * r.width && cy >= t && cy <= t + g.h * r.height) return +id;
    }
    return 0;
  }
  function tapOpen(cx, cy) {
    var id = regAt(cx, cy);
    if (!id || (TX.open && TX.id === id)) return;
    var g = REG[id];
    textOpen(g.x, g.y, g.w, g.h, g.value, g.max, g.mode, id, "tap");
  }
  var tapStart = null;
  document.addEventListener('touchstart', function (e) { var t = e.touches.length === 1 ? e.touches[0] : null; tapStart = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; }, true);
  document.addEventListener('touchend', function (e) {
    var s = tapStart; tapStart = null;
    var t = e.changedTouches && e.changedTouches[0];
    if (!s || !t || Math.abs(t.clientX - s.x) > 16 || Math.abs(t.clientY - s.y) > 16 || Date.now() - s.at > 800) return;
    tapOpen(t.clientX, t.clientY);
  }, true);
  document.addEventListener('mouseup', function (e) { if (e.button === 0 && e.target !== TX.el) tapOpen(e.clientX, e.clientY); }, true);

  // ---------------------------------------------------------------- Unity
  var api = {
    textOpen: function (x, y, w, h, value, max, mode, id) { textOpen(x, y, w, h, value, max, mode, id, "game"); }, textReg: textReg,
    imeHeight: function (h) {
      var was = IME.h; IME.h = +h || 0; IME.known = true;
      if (TX.open && was > 40 && IME.h < 40) { textClose(false); return; }      // клавиатуру убрали кнопкой «назад» — ввод закончен
      txLift();
    },
    textOpenId: function () { return TX.open ? (TX.id || -1) : 0; },
    textClose: function () { textClose(false); },
    textValue: function () { return TX.value; },
    textActive: function () { return TX.open; },
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
      try { if (root.ZaslonAndroid && root.ZaslonAndroid.copy) { root.ZaslonAndroid.copy(String(s)); return; } } catch (e) { }
      try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s); return; } } catch (e) { }
      var ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { } ta.remove();
    },
    share: function (title, url) {
      try { if (root.ZaslonAndroid && root.ZaslonAndroid.share) { root.ZaslonAndroid.share(String(title), String(url)); return; } } catch (e) { }
      if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () { }); }
      else api.copyText(url);
    },
    urlParam: function (name) {
      var v = '';
      try { v = new URLSearchParams(location.search).get(name) || ''; } catch (e) { }
      if (!v) { var m = new RegExp('[#&]' + name + '=([^&]*)').exec(location.hash || ''); if (m) v = decodeURIComponent(m[1]); }
      return v;
    },
    isMobile: function () { return /[?&]mobile=1/.test(location.search) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); },
    fullscreen: function () {
      try {
        if (!document.fullscreenElement) { var el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || function () { }).call(el); }
        else (document.exitFullscreen || document.webkitExitFullscreen || function () { }).call(document);
      } catch (e) { }
    },
    vibrate: function (ms) { try { if (root.ZaslonAndroid && root.ZaslonAndroid.vibrate) { root.ZaslonAndroid.vibrate(ms); return; } if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { } },
    // Мышь. mouseWant(true) — «в бою хотим захват»: он случится при ближайшем клике по игре; mouseWant(false) — отпустить.
    mouseWant: function (on) {
      M.want = !!on;
      // Если игрок только что кликнул (например, «Продолжить»), активация пользователя ещё жива — захватываем сразу, без второго клика
      if (on && !M.locked) { try { if (navigator.userActivation && navigator.userActivation.isActive) lockNow(); } catch (e) { } }
      if (!on && M.locked) { M.exiting = true; try { document.exitPointerLock(); } catch (e) { } }
      if (!on) { M.dx = M.dy = 0; }
    },
    // Запущено в приложении для Android (оно добавляет метку ZaslonApp в User-Agent)
    isApp: function () { return /ZaslonApp\//.test(navigator.userAgent); },
    quit: function () { try { if (root.ZaslonAndroid && root.ZaslonAndroid.quit) root.ZaslonAndroid.quit(); else root.close(); } catch (e) { } },
    // Адрес для приглашений: из приложения — адрес игры в интернете (внутренний адрес приложения друзьям не открыть)
    publicUrl: function () {
      if (api.isApp()) return 'https://3forwork11235.github.io/zaslon/';
      return String(location.href).split(/[?#]/)[0];
    },
    // Кнопка «назад» телефона: как нажатие Esc (Unity опрашивает клавиши раз в кадр, поэтому «отпускание» чуть позже)
    androidBack: function () {
      if (TX.open) { textClose(false); return; }                 // «назад» при открытом поле ввода закрывает только его
      var c = gameCanvas() || document.body;
      var ev = function (t) { return new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }); };
      try { c.dispatchEvent(ev('keydown')); setTimeout(function () { try { c.dispatchEvent(ev('keyup')); } catch (e) { } }, 90); } catch (e) { }
    },
    mouseLocked: function () { return M.locked; },
    mouseLostLock: function () { var v = M.lostLock; M.lostLock = false; return v; },
    mouseTake: function () { var r = [M.dx, M.dy]; M.dx = 0; M.dy = 0; return r; },
  };
  root.ZaslonNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
