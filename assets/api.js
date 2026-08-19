/* ════════════════════════════════════════════════════════════
 *  Apps Script JSON API 클라이언트
 *
 *  동시 접속 대비 설계
 *   - GET/POST 모두 단순 요청(simple request)으로 보내 CORS 프리플라이트를 피함
 *   - 실패 시 지수 백오프로 자동 재시도 (0.8s → 1.6s → 3.2s → 6.4s)
 *   - POST가 막히면 GET(base64) 경로로 자동 우회
 *   - 타임아웃 25초, 그 뒤 재시도
 * ════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  function base() {
    var u = (global.API_URL || '').trim();
    if (!u || u.indexOf('http') !== 0) {
      throw new Error('config.js 의 API_URL 이 아직 설정되지 않았습니다.');
    }
    return u;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function withTimeout(promise, ms) {
    var timer;
    return Promise.race([
      promise.finally(function () { clearTimeout(timer); }),
      new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error('TIMEOUT')); }, ms); })
    ]);
  }

  /** 한글 포함 JSON → base64 (URL 안전) */
  function b64(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
  }

  function qs(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  function unwrap(data) {
    if (!data || typeof data !== 'object') throw new Error('서버 응답을 읽을 수 없습니다.');
    if (data.ok === false) throw new Error(data.error || '알 수 없는 오류');
    return data;
  }

  /** GET 요청 1회 */
  function rawGet(params) {
    return withTimeout(
      fetch(base() + '?' + qs(params), { method: 'GET', redirect: 'follow' })
        .then(function (r) { return r.json(); }),
      25000
    );
  }

  /** POST 요청 1회 — text/plain 이라 프리플라이트가 발생하지 않음 */
  function rawPost(body) {
    return withTimeout(
      fetch(base(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow'
      }).then(function (r) { return r.json(); }),
      25000
    );
  }

  /**
   * 재시도 래퍼.
   * onRetry(회차, 남은시도) 로 화면에 상태를 알릴 수 있습니다.
   */
  function retrying(fn, tries, onRetry) {
    tries = tries || 4;
    var attempt = 0;
    function go() {
      attempt++;
      return fn().then(unwrap).catch(function (err) {
        var msg = String(err && err.message || err);
        // 서버가 명확히 거절한 경우(마감·PIN 오류 등)는 재시도하지 않음
        var permanent = /마감|PIN|찾을 수 없|올바르지 않|API_URL/.test(msg);
        if (permanent || attempt >= tries) throw err;
        if (onRetry) onRetry(attempt, tries - attempt);
        return sleep(800 * Math.pow(2, attempt - 1)).then(go);
      });
    }
    return go();
  }

  var API = {
    ping: function () { return retrying(function () { return rawGet({ api: 'ping' }); }, 2); },

    getQuiz: function (id, onRetry) {
      return retrying(function () { return rawGet({ api: 'quiz', id: id }); }, 4, onRetry)
        .then(function (d) { return d.quiz; });
    },

    /** POST 우선, 막히면 GET(base64)로 우회 */
    submit: function (payload, onRetry) {
      var body = Object.assign({ action: 'submit' }, payload);
      return retrying(function () { return rawPost(body); }, 3, onRetry)
        .catch(function (err) {
          if (/마감|찾을 수 없/.test(String(err.message))) throw err;
          return retrying(function () {
            return rawGet({ api: 'submit', p: b64(payload) });
          }, 3, onRetry);
        })
        .then(function (d) { return d.result; });
    },

    dashboard: function (pin, quizId, onRetry) {
      return retrying(function () {
        return rawGet({ api: 'dash', pin: pin, id: quizId || '' });
      }, 3, onRetry).then(function (d) { return d.data; });
    }
  };

  global.API = API;
})(window);
