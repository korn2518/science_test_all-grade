/*═══════════════════════════════════════════════════════════
  과학 형성평가 — 간단판 v3
  두레자연중학교

  이 파일 하나가 전부입니다.
  · 붙여넣기 1번, 배포 1번 하면 다시 건드릴 일이 없습니다.
  · API 키 없음. 외부 연결 없음. 설정 파일 없음.

  설치
   1) 구글 스프레드시트 새로 만들기
   2) 확장 프로그램 → Apps Script
   3) 이 내용을 전부 붙여넣고 저장(⌘S)
   4) 배포 → 새 배포 → 웹 앱
        · 실행: 나
        · 액세스: 모든 사용자
   5) 나온 주소를 즐겨찾기에 저장. 끝.
═══════════════════════════════════════════════════════════*/

const VERSION = 'v3.1';
const TZ = 'Asia/Seoul';

/*───────────── 라우팅 ─────────────*/

function doGet(e) {
  const p = (e && e.parameter) || {};
  let page;

  if (p.go) {
    // 태블릿 홈 화면에 설치하는 고정 주소.
    // 지금 '공개' 중인 평가로 보내 줍니다.
    page = today_();
  } else if (p.id) {
    // 문항을 페이지 안에 미리 넣어서 보낸다.
    // → 학생 1명당 서버 호출이 2번에서 1번으로 줄어듭니다. (동시 접속에 가장 큰 효과)
    let data = null, err = '';
    try { data = getQuiz(p.id); } catch (ex) { err = ex.message || String(ex); }
    page = student_(p.id, data, err);
  } else {
    page = teacher_();
  }

  return HtmlService.createHtmlOutput(page)
    .setTitle(p.id ? '형성평가' : '형성평가 관리실')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/*───────────── 시트 ─────────────*/

const BANK_H = ['ID', '만든날짜', '제목', '학년', '성취기준', '제한시간', '상태', '문항JSON'];
const RESP_H = ['제출시각', 'ID', '제목', '성취기준', '학년', '반', '번호', '이름',
  '점수', '만점', '백분율', '수준', '소요초', '오답문항', '답안JSON'];

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SSID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (err) { } }
  const s = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('과학 형성평가 데이터');
  PropertiesService.getScriptProperties().setProperty('SSID', s.getId());
  return s;
}

function sh_(name, headers) {
  const s = ss_();
  let sh = s.getSheetByName(name);
  if (!sh) {
    sh = s.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0f172a').setFontColor('#67e8f9');
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, headers.length, 120);
  }
  return sh;
}
function bank_() { return sh_('문제은행', BANK_H); }
function resp_() { return sh_('응답', RESP_H); }

/** 편집기에서 한 번 실행하면 시트를 만들어 둡니다 (안 해도 자동 생성됨) */
function setup() { bank_(); resp_(); return ss_().getUrl(); }

/*───────────── 관리자 확인 ─────────────*/

function pinState() {
  const p = PropertiesService.getScriptProperties().getProperty('PIN') || '';
  return { set: !!p, version: VERSION };
}
function setPin(pin) {
  pin = String(pin || '').trim();
  if (pin.length < 4) throw new Error('4자 이상으로 정해 주세요.');
  const P = PropertiesService.getScriptProperties();
  if (P.getProperty('PIN')) throw new Error('이미 설정되어 있습니다.');
  P.setProperty('PIN', pin);
  return true;
}
function checkPin_(pin) {
  const real = PropertiesService.getScriptProperties().getProperty('PIN') || '';
  if (!real) throw new Error('비밀번호가 아직 설정되지 않았습니다. 새로고침 후 정해 주세요.');
  if (String(pin || '') !== real) throw new Error('비밀번호가 다릅니다.');
  return true;
}

/*───────────── 문항 등록 ─────────────*/

/** 붙여넣은 문항 코드를 검사하고 저장한다 */
function saveQuiz(pin, raw) {
  checkPin_(pin);

  // AI가 앞뒤에 설명글이나 ``` 표시를 붙여 와도 JSON 부분만 뽑아냅니다.
  let q;
  try {
    let t = String(raw || '').trim();
    t = t.replace(/```(?:json)?/gi, ' ');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no json');
    q = JSON.parse(t.slice(a, b + 1));
  } catch (err) {
    throw new Error('문항 코드를 읽지 못했습니다.\n' +
      '· 코드가 { 로 시작해서 } 로 끝나는지 확인하세요.\n' +
      '· 복사할 때 일부가 빠졌을 수 있습니다. 코드 블록의 [복사] 버튼을 쓰면 확실합니다.');
  }

  if (!q.items || !q.items.length) throw new Error('문항이 들어 있지 않습니다.');

  const items = q.items.map(function (it, i) {
    const o = {
      n: i + 1,
      t: it.t === 'SA' ? 'SA' : 'MC',
      lv: it.lv || '중',
      q: String(it.q || '').trim(),
      c: it.t === 'SA' ? [] : (it.c || []).map(function (x) { return String(x).trim(); }),
      a: String(it.a || '').trim(),
      ok: it.t === 'SA' ? (it.ok && it.ok.length ? it.ok : [it.a]).map(function (x) { return String(x).trim(); }) : [],
      e: String(it.e || '').trim()
    };
    if (o.t === 'MC') {
      if (o.c.length < 2) throw new Error((i + 1) + '번 문항에 선택지가 없습니다.');
      if (!/^[1-9]$/.test(o.a)) {
        const idx = o.c.indexOf(o.a);
        if (idx < 0) throw new Error((i + 1) + '번 문항의 정답을 찾을 수 없습니다.');
        o.a = String(idx + 1);
      }
    }
    if (!o.q) throw new Error((i + 1) + '번 문항의 질문이 비어 있습니다.');
    return o;
  });

  const id = 'Q' + Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss');
  bank_().appendRow([id, new Date(), q.title || '형성평가', q.grade || '', q.code || '',
    Number(q.time) || 0, '공개', JSON.stringify(items)]);

  cachePut_(id, {
    id: id, title: q.title || '형성평가', grade: q.grade || '', code: q.code || '',
    time: Number(q.time) || 0, status: '공개', items: items
  });
  try { CacheService.getScriptCache().remove('OPEN'); } catch (e) { }

  return { id: id, url: url_() + '?id=' + id, count: items.length, title: q.title || '형성평가' };
}

function url_() { return ScriptApp.getService().getUrl(); }

/*───────────── 불러오기 (캐시) ─────────────*/

function cachePut_(id, obj) {
  try { CacheService.getScriptCache().put('Q' + id, JSON.stringify(obj), 21600); } catch (e) { }
}

function load_(id) {
  if (!id) throw new Error('주소가 올바르지 않습니다.');
  const hit = CacheService.getScriptCache().get('Q' + id);
  if (hit) { try { return JSON.parse(hit); } catch (e) { } }

  const sh = bank_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) throw new Error('등록된 평가가 없습니다.');
  const v = sh.getRange(2, 1, n, BANK_H.length).getValues();
  for (var i = n - 1; i >= 0; i--) {
    if (v[i][0] === id) {
      const o = {
        id: id, title: v[i][2], grade: v[i][3], code: v[i][4],
        time: Number(v[i][5]) || 0, status: v[i][6], items: JSON.parse(v[i][7])
      };
      cachePut_(id, o);
      return o;
    }
  }
  throw new Error('평가를 찾을 수 없습니다. 링크를 다시 확인해 주세요.');
}

/** 지금 공개 중인 평가 목록 (가벼움 — 캐시 사용) */
function openQuizzes_() {
  const c = CacheService.getScriptCache();
  const hit = c.get('OPEN');
  if (hit) { try { return JSON.parse(hit); } catch (e) { } }

  const sh = bank_();
  const n = sh.getLastRow() - 1;
  let out = [];
  if (n > 0) {
    const v = sh.getRange(2, 1, n, BANK_H.length).getValues();
    out = v.filter(function (x) { return x[6] === '공개'; })
      .map(function (x) { return { id: x[0], title: x[2], grade: x[3] }; })
      .reverse().slice(0, 12);
  }
  try { c.put('OPEN', JSON.stringify(out), 60); } catch (e) { }  // 1분 캐시
  return out;
}

/** 학생용 — 정답 없이 */
function getQuiz(id) {
  const q = load_(id);
  if (q.status !== '공개') throw new Error('마감된 평가입니다. 선생님께 문의하세요.');
  return {
    id: q.id, title: q.title, grade: q.grade, time: q.time,
    items: q.items.map(function (it) { return { n: it.n, t: it.t, q: it.q, c: it.c }; })
  };
}

/*───────────── 채점 ─────────────*/

function norm_(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s·.,'"“”‘’()\[\]/\-_]/g, '')
    .replace(/입니다$|이다$|요$/, '');
}

function ok_(it, given) {
  if (it.t === 'MC') return String(given).trim() === String(it.a);
  const g = norm_(given);
  if (!g) return false;
  return (it.ok || [it.a]).some(function (a) {
    const na = norm_(a);
    return na && (g === na || (na.length >= 2 && g.indexOf(na) >= 0));
  });
}

function submit(payload) {
  const q = load_(payload.id);
  if (q.status !== '공개') throw new Error('마감된 평가입니다.');

  const ans = payload.answers || {};
  let score = 0;
  const wrong = [], detail = [];

  // 채점은 잠금 밖에서 (캐시의 정답으로 계산 — 시트를 읽지 않음)
  q.items.forEach(function (it) {
    const g = String(ans[it.n] == null ? '' : ans[it.n]).trim();
    const good = ok_(it, g);
    if (good) score++; else wrong.push(it.n);
    // 문항 본문·선택지는 학생 화면에 이미 있으므로 다시 보내지 않는다 (응답 크기 60% 감소)
    detail.push({ n: it.n, given: g, a: it.a, ok: good, e: it.e });
  });

  const total = q.items.length;
  const pct = Math.round(score / total * 100);
  const lv = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'E';

  const row = [new Date(), q.id, q.title, q.code, payload.grade, payload.cls, payload.no,
    payload.name, score, total, pct, lv, payload.sec || '', wrong.join(','), JSON.stringify(ans)];

  // 잠금 구간은 시트에 한 줄 쓰는 것뿐 (약 0.3초).
  // 여러 명이 동시에 눌러도 서로 밀리지 않도록 대기 시간을 조금씩 다르게 줍니다.
  const lock = LockService.getScriptLock();
  let got = false;
  for (var i = 0; i < 3 && !got; i++) {
    got = lock.tryLock(9000);
    if (!got) Utilities.sleep(150 + Math.floor(Math.random() * 500));
  }
  if (!got) throw new Error('BUSY');
  try { resp_().appendRow(row); } finally { lock.releaseLock(); }

  return { score: score, total: total, pct: pct, lv: lv, name: payload.name, title: q.title, detail: detail };
}

/*───────────── 관리 화면용 ─────────────*/

function listAll(pin) {
  checkPin_(pin);
  const sh = bank_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];

  const v = sh.getRange(2, 1, n, BANK_H.length).getValues();
  const r = resp_();
  const rn = r.getLastRow() - 1;
  const cnt = {}, sum = {};
  if (rn > 0) {
    r.getRange(2, 1, rn, RESP_H.length).getValues().forEach(function (x) {
      cnt[x[1]] = (cnt[x[1]] || 0) + 1;
      sum[x[1]] = (sum[x[1]] || 0) + x[10];
    });
  }
  return v.map(function (x) {
    return {
      id: x[0], date: Utilities.formatDate(new Date(x[1]), TZ, 'MM/dd HH:mm'),
      title: x[2], grade: x[3], code: x[4], status: x[6],
      n: cnt[x[0]] || 0,
      avg: cnt[x[0]] ? Math.round(sum[x[0]] / cnt[x[0]]) : 0,
      url: url_() + '?id=' + x[0]
    };
  }).reverse();
}

function toggle(pin, id) {
  checkPin_(pin);
  const sh = bank_();
  const n = sh.getLastRow() - 1;
  const v = sh.getRange(2, 1, n, 1).getValues();
  for (var i = 0; i < n; i++) {
    if (v[i][0] === id) {
      const next = sh.getRange(i + 2, 7).getValue() === '공개' ? '마감' : '공개';
      sh.getRange(i + 2, 7).setValue(next);
      const c = CacheService.getScriptCache();
      c.remove('Q' + id);
      c.remove('OPEN');
      return next;
    }
  }
  throw new Error('찾을 수 없습니다.');
}

function results(pin, id) {
  checkPin_(pin);
  const r = resp_();
  const rn = r.getLastRow() - 1;
  if (rn <= 0) return { rows: [], stat: null, items: [] };

  const all = r.getRange(2, 1, rn, RESP_H.length).getValues()
    .filter(function (x) { return !id || x[1] === id; });
  if (!all.length) return { rows: [], stat: null, items: [] };

  const rows = all.map(function (x) {
    return {
      time: Utilities.formatDate(new Date(x[0]), TZ, 'MM/dd HH:mm'),
      title: x[2], grade: x[4], cls: x[5], no: x[6], name: x[7],
      score: x[8], total: x[9], pct: x[10], lv: x[11], wrong: String(x[13] || '')
    };
  }).reverse();

  const pcts = rows.map(function (x) { return x.pct; });
  const dist = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  rows.forEach(function (x) { dist[x.lv]++; });

  // 문항별 정답률 — 답안JSON으로 계산
  let items = [];
  if (id) {
    try {
      const q = load_(id);
      const agg = q.items.map(function (it) {
        return { n: it.n, t: it.t === 'MC' ? '객관식' : '단답형', lv: it.lv, o: 0, tot: 0, w: {} };
      });
      all.forEach(function (x) {
        let a = {};
        try { a = JSON.parse(x[14] || '{}'); } catch (e) { }
        q.items.forEach(function (it, i) {
          const g = String(a[it.n] == null ? '' : a[it.n]).trim();
          agg[i].tot++;
          if (ok_(it, g)) agg[i].o++;
          else {
            const k = g ? (it.t === 'MC' ? g + '번' : g) : '(무응답)';
            agg[i].w[k] = (agg[i].w[k] || 0) + 1;
          }
        });
      });
      items = agg.map(function (a) {
        const top = Object.keys(a.w).sort(function (p, n) { return a.w[n] - a.w[p]; })[0];
        return {
          n: a.n, t: a.t, lv: a.lv,
          rate: a.tot ? Math.round(a.o / a.tot * 100) : 0,
          top: top ? top + ' (' + a.w[top] + '명)' : '-'
        };
      });
    } catch (e) { items = []; }
  }

  return {
    rows: rows, items: items,
    stat: {
      n: rows.length,
      avg: Math.round(pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length),
      max: Math.max.apply(null, pcts), min: Math.min.apply(null, pcts), dist: dist
    }
  };
}

function sheetUrl(pin) { checkPin_(pin); return ss_().getUrl(); }

/*───────────── 공용 CSS ─────────────*/

function css_() {
  return "<style>" +
    "@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Noto+Sans+KR:wght@400;500;700&display=swap');" +
    ":root{--cy:#22d3ee;--mg:#f0f;--vi:#a855f7;--li:#a3e635;--am:#fbbf24;--ro:#fb7185;--tx:#e6f6ff;--dm:#8ea6c8}" +
    "*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}" +
    "body{margin:0;padding:0;background:#05060f;color:var(--tx);font-family:'Noto Sans KR',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}" +
    "body::before{content:'';position:fixed;inset:0;z-index:-2;background:radial-gradient(900px 600px at 10% -5%,rgba(168,85,247,.3),transparent 60%),radial-gradient(800px 600px at 90% 8%,rgba(34,211,238,.25),transparent 60%),radial-gradient(700px 500px at 50% 105%,rgba(255,0,255,.18),transparent 60%),linear-gradient(180deg,#05060f,#080b1c 45%,#05060f)}" +
    "body::after{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(rgba(34,211,238,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.05) 1px,transparent 1px);background-size:46px 46px;-webkit-mask-image:linear-gradient(180deg,#000,transparent 85%);mask-image:linear-gradient(180deg,#000,transparent 85%)}" +
    ".w{max-width:760px;margin:0 auto;padding:24px 16px 80px}" +
    ".w.big{max-width:1020px}" +
    "h1{font-family:'Orbitron','Noto Sans KR',sans-serif;font-weight:900;letter-spacing:.05em;font-size:clamp(21px,4.4vw,34px);margin:0 0 6px;color:#eafcff;text-shadow:0 0 4px #fff,0 0 14px var(--cy),0 0 34px var(--cy)}" +
    "h1.pk{text-shadow:0 0 4px #fff,0 0 14px var(--mg),0 0 34px var(--mg)}" +
    ".sub{color:var(--dm);font-size:12.5px;margin:0 0 20px}" +
    ".vb{margin-left:7px;padding:2px 9px;border-radius:99px;font-size:11px;border:1px solid rgba(163,230,53,.5);color:var(--li);background:rgba(163,230,53,.1)}" +
    ".card{background:rgba(12,18,42,.75);border:1px solid rgba(103,232,249,.2);border-radius:16px;padding:20px;margin-bottom:16px;backdrop-filter:blur(12px);box-shadow:0 16px 44px rgba(0,0,0,.55),0 0 28px rgba(34,211,238,.08)}" +
    ".card h2{font-family:'Orbitron','Noto Sans KR',sans-serif;font-size:14px;letter-spacing:.1em;margin:0 0 14px;color:var(--cy);text-shadow:0 0 9px rgba(34,211,238,.75);display:flex;align-items:center;gap:8px}" +
    ".card h2::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--cy);box-shadow:0 0 10px var(--cy)}" +
    "label{display:block;font-size:12px;color:var(--dm);margin:0 0 6px}" +
    "input,select,textarea{width:100%;padding:12px 13px;background:rgba(2,6,23,.85);border:1px solid rgba(103,232,249,.26);border-radius:10px;color:var(--tx);font-family:inherit;font-size:14px;outline:none}" +
    "input:focus,select:focus,textarea:focus{border-color:var(--cy);box-shadow:0 0 0 3px rgba(34,211,238,.13)}" +
    "select option{background:#0a0f24}" +
    "textarea{min-height:150px;resize:vertical;font-family:ui-monospace,monospace;font-size:12px;line-height:1.6}" +
    ".r{display:grid;gap:10px;margin-bottom:12px}.r3{grid-template-columns:1fr 1fr 1fr}.r2{grid-template-columns:1fr 1fr}" +
    ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:12px 22px;border-radius:11px;cursor:pointer;font-family:'Orbitron','Noto Sans KR',sans-serif;font-weight:700;font-size:13.5px;letter-spacing:.06em;background:transparent;color:var(--cy);border:1.5px solid var(--cy);box-shadow:0 0 11px rgba(34,211,238,.4);text-shadow:0 0 8px rgba(34,211,238,.8);transition:.18s}" +
    ".btn:hover:not(:disabled){background:rgba(34,211,238,.13);box-shadow:0 0 24px rgba(34,211,238,.75)}" +
    ".btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}" +
    ".btn.g{color:var(--li);border-color:var(--li);box-shadow:0 0 11px rgba(163,230,53,.4);text-shadow:0 0 8px rgba(163,230,53,.8)}" +
    ".btn.g:hover:not(:disabled){background:rgba(163,230,53,.13)}" +
    ".btn.p{color:var(--mg);border-color:var(--mg);box-shadow:0 0 11px rgba(255,0,255,.4);text-shadow:0 0 8px rgba(255,0,255,.8)}" +
    ".btn.p:hover:not(:disabled){background:rgba(255,0,255,.13)}" +
    ".btn.v{color:var(--vi);border-color:var(--vi);box-shadow:0 0 11px rgba(168,85,247,.4)}" +
    ".btn.s{padding:7px 13px;font-size:11.5px;border-radius:8px}" +
    ".btn.bl{width:100%}" +
    ".br{display:flex;gap:9px;flex-wrap:wrap}" +
    ".chip{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;border:1px solid rgba(103,232,249,.4);color:var(--cy);background:rgba(34,211,238,.09)}" +
    ".chip.g{border-color:rgba(163,230,53,.45);color:var(--li);background:rgba(163,230,53,.09)}" +
    ".chip.p{border-color:rgba(255,0,255,.45);color:#ff8bff;background:rgba(255,0,255,.09)}" +
    ".chip.a{border-color:rgba(251,191,36,.45);color:var(--am);background:rgba(251,191,36,.09)}" +
    ".chip.r{border-color:rgba(251,113,133,.45);color:var(--ro);background:rgba(251,113,133,.09)}" +
    ".chip.d{border-color:rgba(142,166,200,.35);color:var(--dm);background:rgba(142,166,200,.07)}" +
    "table{width:100%;border-collapse:collapse;font-size:12.5px}" +
    "th,td{padding:8px 7px;text-align:left;border-bottom:1px solid rgba(103,232,249,.12)}" +
    "th{color:var(--cy);font-size:10.5px;letter-spacing:.08em}" +
    ".sc{overflow-x:auto}" +
    ".hint{font-size:12px;color:var(--dm);line-height:1.65}.hint b{color:var(--cy)}" +
    ".ld{display:none;text-align:center;padding:30px}.ld.on{display:block}" +
    ".ring{width:50px;height:50px;margin:0 auto 14px;border-radius:50%;border:3px solid rgba(34,211,238,.15);border-top-color:var(--cy);border-right-color:var(--mg);animation:sp .9s linear infinite;box-shadow:0 0 22px rgba(34,211,238,.5)}" +
    "@keyframes sp{to{transform:rotate(360deg)}}" +
    ".ld p{color:var(--cy);font-family:Orbitron,sans-serif;letter-spacing:.12em;font-size:11.5px}" +
    ".tst{position:fixed;left:50%;bottom:24px;transform:translate(-50%,150%);background:rgba(6,10,26,.96);border:1px solid var(--cy);padding:12px 20px;border-radius:11px;font-size:13px;z-index:99;box-shadow:0 0 22px rgba(34,211,238,.55);transition:.28s;max-width:88vw;text-align:center}" +
    ".tst.on{transform:translate(-50%,0)}.tst.e{border-color:var(--ro);box-shadow:0 0 22px rgba(251,113,133,.55)}" +
    ".err{border-color:rgba(251,113,133,.5)!important;box-shadow:0 0 26px rgba(251,113,133,.2)!important}" +
    ".err h2{color:var(--ro)!important;text-shadow:0 0 9px rgba(251,113,133,.8)!important}" +
    ".err h2::before{background:var(--ro)!important;box-shadow:0 0 10px var(--ro)!important}" +
    "pre.em{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.7;background:rgba(2,6,23,.8);padding:13px;border-radius:9px;margin:0 0 12px;color:#ffd9de;font-family:ui-monospace,monospace}" +
    ".hd{display:none}.dv{height:1px;background:linear-gradient(90deg,transparent,rgba(103,232,249,.3),transparent);margin:16px 0}" +
    "</style>";
}

function js_() {
  return "<script>" +
    "function $(i){return document.getElementById(i)}" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}" +
    "function toast(m,e){var t=$('tst');t.textContent=m;t.className='tst on'+(e?' e':'');clearTimeout(window._tt);window._tt=setTimeout(function(){t.className='tst'+(e?' e':'')},4000)}" +
    "function show(i){$(i).classList.remove('hd')}function hide(i){$(i).classList.add('hd')}" +
    "function showErr(e,w){var m=(e&&e.message)?e.message:String(e);" +
    " if(!$('emsg')){toast(m,true);return}" +
    " $('emsg').textContent='['+(w||'오류')+']\\n'+m;show('ecard');" +
    " window.scrollTo({top:$('ecard').offsetTop-20,behavior:'smooth'})}" +
    "function copyText(t){var a=document.createElement('textarea');document.body.appendChild(a);a.value=t;a.select();try{document.execCommand('copy');toast('복사했습니다.')}catch(e){prompt('복사하세요',t)}document.body.removeChild(a)}" +
    "<\/script>";
}

function errCard_() {
  return "<div class='card err hd' id='ecard'><h2>오류</h2>" +
    "<pre class='em' id='emsg'></pre>" +
    "<div class='br'><button class='btn s' onclick=\"copyText($('emsg').textContent)\">복사</button>" +
    "<button class='btn s' onclick=\"hide('ecard')\">닫기</button></div></div>";
}

/*───────────── 관리 화면 ─────────────*/

function teacher_() {
  return "<!DOCTYPE html><html lang='ko'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>형성평가 관리실</title>" + css_() + "</head><body><div class='w big'>" +

    "<h1>QUIZ CONTROL</h1>" +
    "<p class='sub'>두레자연중학교 과학 형성평가<span class='vb'>" + VERSION + "</span></p>" +

    /* 비밀번호 */
    "<div class='card' id='lock'>" +
    "<h2 id='ltitle'>확인 중…</h2>" +
    "<div class='r'><div><label id='llab'>비밀번호</label>" +
    "<input id='pin' type='password' autocomplete='off' placeholder='4자 이상'></div></div>" +
    "<button class='btn bl g' id='lgo'>열기</button>" +
    "<p class='hint' id='lhint' style='margin-top:11px'></p></div>" +

    "<div id='main' class='hd'>" +
    errCard_() +

    /* 등록 */
    "<div class='card'><h2>새 형성평가 등록</h2>" +
    "<p class='hint' style='margin-bottom:12px'>대화창에서 받은 <b>문항 코드</b>를 그대로 붙여넣고 등록을 누르세요.</p>" +
    "<textarea id='code' placeholder='{ \"title\": ... } 로 시작하는 코드를 붙여넣으세요'></textarea>" +
    "<div class='br' style='margin-top:12px'>" +
    "<button class='btn g' id='save'>등록하고 링크 만들기</button>" +
    "<button class='btn s' id='clear'>지우기</button></div></div>" +

    /* 링크 */
    "<div class='card hd' id='lk'><h2>학생 링크</h2>" +
    "<div id='lkinfo' style='margin-bottom:10px'></div>" +
    "<div style='display:flex;gap:8px'><input id='lurl' readonly style='font-family:ui-monospace,monospace;font-size:12px'>" +
    "<button class='btn s' id='lcopy'>복사</button></div>" +
    "<div id='qr' style='margin-top:14px;text-align:center'></div></div>" +

    /* 태블릿 설치 */
    "<div class='card'><h2>태블릿에 설치하기</h2>" +
    "<p class='hint' style='margin-bottom:11px'>아래 <b>고정 주소</b>를 학생 태블릿 홈 화면에 한 번만 추가해 두면, " +
    "다음 시간부터는 아이콘만 누르면 <b>그때 열려 있는 평가</b>로 바로 들어갑니다. 매번 링크를 나눠줄 필요가 없습니다.</p>" +
    "<div style='display:flex;gap:8px'><input id='gurl' readonly style='font-family:ui-monospace,monospace;font-size:12px'>" +
    "<button class='btn s' id='gcopy'>복사</button></div>" +
    "<div class='br' style='margin-top:11px'>" +
    "<button class='btn s g' id='gqr'>QR 크게 띄우기</button>" +
    "<button class='btn s v' id='ghow'>설치 방법 보기</button></div>" +
    "<div id='gbox' style='margin-top:14px'></div></div>" +

    /* 목록 */
    "<div class='card'><h2>등록된 평가</h2>" +
    "<div class='br' style='margin-bottom:12px'>" +
    "<button class='btn s' id='rl'>새로고침</button>" +
    "<button class='btn s p' id='gs'>스프레드시트 열기</button></div>" +
    "<div class='sc'><table><thead><tr><th>날짜</th><th>제목</th><th>학년</th><th>성취기준</th>" +
    "<th>응시</th><th>평균</th><th>상태</th><th>링크</th><th>결과</th></tr></thead>" +
    "<tbody id='list'><tr><td colspan='9' class='hint'>불러오는 중…</td></tr></tbody></table></div></div>" +

    /* 결과 */
    "<div class='card hd' id='res'><h2 id='restitle'>결과</h2><div id='resbody'></div></div>" +

    "</div><div class='ld' id='ld'><div class='ring'></div><p>LOADING…</p></div>" +
    "<div class='tst' id='tst'></div></div>" + js_() +

    "<script>" +
    "var PIN='';" +
    "function run(fn,args,okc,errc){$('ld').classList.add('on');" +
    " var r=google.script.run.withSuccessHandler(function(x){$('ld').classList.remove('on');okc&&okc(x)})" +
    "  .withFailureHandler(function(e){$('ld').classList.remove('on');errc?errc(e):showErr(e,fn)});" +
    " r[fn].apply(r,args||[]);}" +

    /* 잠금 화면 */
    "google.script.run.withSuccessHandler(function(s){" +
    " if(s.set){$('ltitle').textContent='비밀번호를 입력하세요';$('lhint').textContent='관리 화면을 여는 비밀번호입니다.';}" +
    " else{$('ltitle').textContent='비밀번호를 정하세요';$('llab').textContent='새 비밀번호 (4자 이상)';" +
    "  $('lhint').innerHTML='처음 여는 화면입니다. 여기서 정한 비밀번호로 앞으로 관리 화면을 엽니다.';$('lgo').textContent='정하기';}" +
    " window.__set=s.set;" +
    "}).withFailureHandler(function(e){$('ltitle').textContent='연결 오류';$('lhint').textContent=e.message}).pinState();" +

    "$('lgo').onclick=function(){var p=$('pin').value.trim();" +
    " if(p.length<4){toast('4자 이상 입력하세요.',true);return}" +
    " if(!window.__set){run('setPin',[p],function(){PIN=p;openMain()},function(e){toast(e.message,true)});}" +
    " else {PIN=p;run('listAll',[p],function(l){openMain();paint(l)},function(e){toast(e.message,true)});}};" +
    "$('pin').onkeydown=function(e){if(e.key==='Enter')$('lgo').click()};" +

    "function openMain(){hide('lock');show('main');load()}" +
    "function load(){run('listAll',[PIN],paint)}" +
    "$('rl').onclick=load;" +

    "function paint(l){" +
    " if(!l.length){$('list').innerHTML='<tr><td colspan=\"9\" class=\"hint\">아직 등록된 평가가 없습니다.</td></tr>';return}" +
    " $('list').innerHTML=l.map(function(q){return '<tr>'+" +
    "  '<td class=\"hint\">'+esc(q.date)+'</td>'+" +
    "  '<td>'+esc(q.title)+'</td>'+" +
    "  '<td>'+(q.grade?'중'+q.grade:'-')+'</td>'+" +
    "  '<td><span class=\"chip g\">'+esc(q.code||'-')+'</span></td>'+" +
    "  '<td><b style=\"color:var(--cy)\">'+q.n+'</b></td>'+" +
    "  '<td>'+(q.n?q.avg+'%':'-')+'</td>'+" +
    "  '<td><span class=\"chip '+(q.status==='공개'?'':'r')+'\" style=\"cursor:pointer\" onclick=\"tg(\\''+q.id+'\\')\">'+esc(q.status)+'</span></td>'+" +
    "  '<td><button class=\"btn s\" onclick=\"copyText(\\''+q.url+'\\')\">복사</button></td>'+" +
    "  '<td><button class=\"btn s v\" onclick=\"see(\\''+q.id+'\\',\\''+esc(q.title).replace(/'/g,'')+'\\')\">보기</button></td></tr>'}).join('')}" +

    "function tg(id){run('toggle',[PIN,id],function(s){toast('→ '+s);load()})}" +

    "$('save').onclick=function(){hide('ecard');var c=$('code').value.trim();" +
    " if(!c){toast('문항 코드를 붙여넣으세요.',true);return}" +
    " run('saveQuiz',[PIN,c],function(r){" +
    "  show('lk');$('lurl').value=r.url;" +
    "  $('lkinfo').innerHTML='<span class=\"chip g\">'+esc(r.title)+'</span> <span class=\"chip\">'+r.count+'문항</span>';" +
    "  $('qr').innerHTML='<img alt=\"QR\" style=\"border-radius:11px;box-shadow:0 0 24px rgba(34,211,238,.5)\" src=\"https://api.qrserver.com/v1/create-qr-code/?size=190x190&margin=8&data='+encodeURIComponent(r.url)+'\">';" +
    "  $('code').value='';toast('등록되었습니다.');load();" +
    "  window.scrollTo({top:$('lk').offsetTop-20,behavior:'smooth'})},function(e){showErr(e,'문항 등록')})};" +

    "$('clear').onclick=function(){$('code').value=''};" +

    /* 태블릿 설치 주소 */
    "var GURL='" + url_() + "?go=1';" +
    "$('gurl').value=GURL;" +
    "$('gcopy').onclick=function(){copyText(GURL)};" +
    "$('gqr').onclick=function(){$('gbox').innerHTML='<div style=\"text-align:center;padding:16px;background:#fff;border-radius:14px\">'+" +
    " '<img alt=\"QR\" style=\"width:min(320px,72vw)\" src=\"https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data='+encodeURIComponent(GURL)+'\">'+" +
    " '<div style=\"color:#0b1220;font-weight:700;margin-top:10px;font-size:15px\">과학 형성평가</div></div>'};" +
    "$('ghow').onclick=function(){$('gbox').innerHTML=" +
    " '<div style=\"border:1px solid rgba(103,232,249,.25);border-radius:12px;padding:14px 16px;font-size:13px;line-height:1.9\">'+" +
    " '<b style=\"color:var(--cy)\">아이패드 (Safari)</b><br>QR로 주소 열기 → 아래쪽 <b>공유</b> 버튼 → <b>홈 화면에 추가</b> → 이름을 <b>과학 형성평가</b>로 → 추가<br><br>'+" +
    " '<b style=\"color:var(--cy)\">안드로이드 (Chrome)</b><br>QR로 주소 열기 → 오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b> → 추가<br><br>'+" +
    " '<span class=\"hint\">한 대에서 먼저 해보고, 학생들에게 QR을 띄워 각자 따라 하게 하면 5분이면 끝납니다.</span></div>'};" +
    "$('lcopy').onclick=function(){copyText($('lurl').value)};" +
    "$('gs').onclick=function(){run('sheetUrl',[PIN],function(u){window.open(u,'_blank')})};" +

    "function see(id,title){run('results',[PIN,id],function(d){" +
    " show('res');$('restitle').textContent=title+' — 결과';" +
    " if(!d.stat){$('resbody').innerHTML='<p class=\"hint\">아직 응시한 학생이 없습니다.</p>';return}" +
    " var s=d.stat,C={A:'#a3e635',B:'#22d3ee',C:'#fbbf24',D:'#a855f7',E:'#fb7185'};" +
    " var h='<div class=\"br\" style=\"margin-bottom:14px\">'+" +
    "  '<span class=\"chip\">응시 '+s.n+'명</span><span class=\"chip g\">평균 '+s.avg+'%</span>'+" +
    "  '<span class=\"chip a\">최고 '+s.max+'%</span><span class=\"chip r\">최저 '+s.min+'%</span></div>';" +
    " h+='<div style=\"display:flex;height:30px;border-radius:9px;overflow:hidden;border:1px solid rgba(103,232,249,.2);margin-bottom:8px\">';" +
    " ['A','B','C','D','E'].forEach(function(k){var w=s.dist[k]/s.n*100;" +
    "  h+='<div style=\"width:'+w+'%;background:'+C[k]+';color:#04121a;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center\">'+(w>8?k+' '+s.dist[k]:'')+'</div>'});" +
    " h+='</div><p class=\"hint\">A 90↑ B 80↑ C 70↑ D 60↑ E 60미만</p>';" +
    " if(d.items.length){h+='<div class=\"dv\"></div><div class=\"sc\"><table><thead><tr><th>문항</th><th>유형</th><th>난이도</th><th>정답률</th><th>최다 오답</th></tr></thead><tbody>';" +
    "  d.items.forEach(function(i){h+='<tr><td><b>'+i.n+'</b></td><td>'+i.t+'</td><td>'+i.lv+'</td>'+" +
    "   '<td style=\"color:'+(i.rate<50?'var(--ro)':i.rate>=80?'var(--li)':'var(--tx)')+';font-weight:700\">'+i.rate+'%</td>'+" +
    "   '<td class=\"hint\">'+esc(i.top)+'</td></tr>'});h+='</tbody></table></div>';" +
    "  h+='<p class=\"hint\" style=\"margin-top:9px\">정답률 <b>50% 미만</b> 문항은 다음 차시에 5분 재설명 대상입니다.</p>'}" +
    " h+='<div class=\"dv\"></div><div class=\"sc\"><table><thead><tr><th>제출</th><th>학급</th><th>번호</th><th>이름</th><th>점수</th><th>%</th><th>수준</th><th>틀린 문항</th></tr></thead><tbody>';" +
    " d.rows.forEach(function(r){h+='<tr><td class=\"hint\">'+esc(r.time)+'</td><td>'+r.grade+'-'+r.cls+'</td><td>'+r.no+'</td>'+" +
    "  '<td><b>'+esc(r.name)+'</b></td><td>'+r.score+'/'+r.total+'</td>'+" +
    "  '<td style=\"color:'+(r.pct<60?'var(--ro)':r.pct>=90?'var(--li)':'var(--tx)')+'\">'+r.pct+'</td>'+" +
    "  '<td><span class=\"chip\" style=\"background:'+C[r.lv]+';color:#04121a;border:none\">'+r.lv+'</span></td>'+" +
    "  '<td class=\"hint\">'+esc(r.wrong||'-')+'</td></tr>'});" +
    " h+='</tbody></table></div>';$('resbody').innerHTML=h;" +
    " window.scrollTo({top:$('res').offsetTop-20,behavior:'smooth'})})}" +
    "<\/script></body></html>";
}

/*───────────── 오늘의 평가 (태블릿 홈 화면용) ─────────────*/

function today_() {
  const list = openQuizzes_();
  const base = url_();

  let body;
  if (!list.length) {
    body = "<div class='card' style='text-align:center;padding:34px 20px'>" +
      "<div style='font-size:44px;margin-bottom:12px'>🌙</div>" +
      "<h2 style='justify-content:center'>지금은 열린 평가가 없어요</h2>" +
      "<p class='hint'>선생님이 평가를 열면 여기에 나타납니다.<br>이 화면을 그대로 두고 잠시 기다리세요.</p>" +
      "<button class='btn g' style='margin-top:16px' onclick='location.reload()'>새로고침</button></div>";
  } else if (list.length === 1) {
    const q = list[0];
    body = "<div class='card' style='text-align:center;padding:30px 20px'>" +
      "<span class='chip g'>지금 열린 평가</span>" +
      "<div style='margin:14px 0 6px;font-size:19px;font-weight:700;line-height:1.5'>" + esc_(q.title) + "</div>" +
      (q.grade ? "<div class='hint'>중" + esc_(q.grade) + "학년</div>" : "") +
      "<a class='btn bl g' style='margin-top:18px;text-decoration:none' href='" + base + "?id=" + q.id + "'>시작하기</a>" +
      "<p class='hint' style='margin-top:14px'>버튼이 안 눌리면 화면을 아래로 당겨 새로고침하세요.</p></div>";
  } else {
    body = "<div class='card'><h2>오늘 열린 평가</h2>" +
      list.map(function (q) {
        return "<a class='btn bl' style='margin-bottom:9px;text-decoration:none;justify-content:space-between' href='" +
          base + "?id=" + q.id + "'><span>" + esc_(q.title) + "</span>" +
          (q.grade ? "<span class='chip d'>중" + esc_(q.grade) + "</span>" : "") + "</a>";
      }).join('') +
      "<p class='hint' style='margin-top:10px'>본인 학년의 평가를 고르세요.</p></div>";
  }

  return "<!DOCTYPE html><html lang='ko'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>" +
    "<meta name='apple-mobile-web-app-capable' content='yes'>" +
    "<meta name='apple-mobile-web-app-status-bar-style' content='black-translucent'>" +
    "<meta name='apple-mobile-web-app-title' content='과학 형성평가'>" +
    "<meta name='mobile-web-app-capable' content='yes'>" +
    "<meta name='theme-color' content='#05060f'>" +
    "<title>과학 형성평가</title>" + css_() + "</head><body><div class='w'>" +
    "<h1 class='pk' style='text-align:center'>POP QUIZ</h1>" +
    "<p class='sub' style='text-align:center'>두레자연중학교 과학</p>" +
    body +
    "<p class='hint' style='text-align:center;margin-top:18px'>이 화면을 홈 화면에 추가해 두면<br>다음 시간부터 아이콘만 누르면 됩니다.</p>" +
    "</div></body></html>";
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/*───────────── 학생 화면 ─────────────*/

function student_(id, data, err) {
  return "<!DOCTYPE html><html lang='ko'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>" +
    "<meta name='apple-mobile-web-app-capable' content='yes'>" +
    "<meta name='apple-mobile-web-app-status-bar-style' content='black-translucent'>" +
    "<meta name='apple-mobile-web-app-title' content='과학 형성평가'>" +
    "<meta name='mobile-web-app-capable' content='yes'>" +
    "<meta name='theme-color' content='#05060f'>" +
    "<title>형성평가</title>" + css_() +
    "<style>" +
    ".qc{border:1px solid rgba(103,232,249,.2);border-radius:15px;padding:17px;margin-bottom:13px;background:rgba(2,6,23,.55)}" +
    ".qc.dn{border-color:rgba(163,230,53,.35);box-shadow:0 0 18px rgba(163,230,53,.1)}" +
    ".qn{font-family:Orbitron,sans-serif;font-weight:900;font-size:16px;color:var(--cy);text-shadow:0 0 11px var(--cy)}" +
    ".qt{font-size:15px;line-height:1.75;margin:10px 0 13px;word-break:keep-all}" +
    ".op{display:flex;gap:10px;align-items:flex-start;padding:12px 13px;margin-bottom:8px;border-radius:10px;border:1px solid rgba(103,232,249,.18);background:rgba(2,6,23,.6);cursor:pointer;font-size:14px;line-height:1.6;transition:.16s}" +
    ".op:hover{border-color:rgba(34,211,238,.5);background:rgba(34,211,238,.06)}" +
    ".op.on{border-color:var(--cy);background:rgba(34,211,238,.15);box-shadow:0 0 16px rgba(34,211,238,.3)}" +
    ".op .nm{font-family:Orbitron,sans-serif;font-weight:700;min-width:21px;height:21px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10.5px;border:1px solid rgba(103,232,249,.4);color:var(--dm);flex-shrink:0;margin-top:2px}" +
    ".op.on .nm{background:var(--cy);color:#04121a;border-color:var(--cy)}" +
    ".bar{position:sticky;top:0;z-index:9;background:rgba(5,6,15,.93);backdrop-filter:blur(10px);border-bottom:1px solid rgba(103,232,249,.2);padding:10px 15px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}" +
    ".who{font-size:12px;color:var(--dm)}" +
    ".tm{font-family:Orbitron,sans-serif;font-weight:900;font-size:16px;color:var(--li);text-shadow:0 0 11px var(--li)}" +
    ".tm.wn{color:var(--ro);text-shadow:0 0 12px var(--ro)}" +
    ".pg{height:4px;background:rgba(103,232,249,.12);border-radius:99px;overflow:hidden;flex:1 0 100%}" +
    ".pg i{display:block;height:100%;background:linear-gradient(90deg,var(--cy),var(--mg));width:0;transition:.3s}" +
    ".big{font-family:Orbitron,sans-serif;font-weight:900;font-size:clamp(54px,15vw,92px);line-height:1;color:#eafcff;text-shadow:0 0 8px #fff,0 0 24px var(--cy),0 0 56px var(--cy)}" +
    ".big.lo{text-shadow:0 0 8px #fff,0 0 24px var(--ro),0 0 56px var(--ro)}" +
    ".lv{font-family:Orbitron,sans-serif;font-size:38px;font-weight:900;margin-top:5px}" +
    ".rs{border-left:3px solid var(--li);padding:13px 15px;border-radius:0 11px 11px 0;background:rgba(163,230,53,.06);margin-bottom:10px}" +
    ".rs.x{border-color:var(--ro);background:rgba(251,113,133,.07)}" +
    ".rs .t{font-size:12.5px;font-weight:700;margin-bottom:6px;display:flex;gap:7px;align-items:center}" +
    ".rs .q{font-size:13.5px;line-height:1.7;color:#cfe4f7;margin-bottom:7px;word-break:keep-all}" +
    ".rs .a{font-size:12.5px;line-height:1.7;color:var(--dm)}.rs .a b{color:var(--li)}.rs.x .a b.mi{color:var(--ro)}" +
    ".rs .e{margin-top:7px;font-size:12.5px;line-height:1.7;color:#f3e3b8;background:rgba(251,191,36,.07);padding:9px 11px;border-radius:8px}" +
    "</style></head><body>" +

    /* 1. 시작 */
    "<div class='w' id='s1'><h1 class='pk'>POP QUIZ</h1><p class='sub'>두레자연중학교 과학</p>" +
    "<div class='card' id='info'><p class='hint'>불러오는 중…</p></div>" +
    "<div class='card hd' id='lg'><h2>누구인가요?</h2>" +
    "<div class='r r3'>" +
    "<div><label>학년</label><select id='g'><option>1</option><option>2</option><option>3</option></select></div>" +
    "<div><label>반</label><input id='c' type='number' inputmode='numeric' placeholder='3'></div>" +
    "<div><label>번호</label><input id='n' type='number' inputmode='numeric' placeholder='12'></div></div>" +
    "<div class='r'><div><label>이름</label><input id='nm' maxlength='10' placeholder='홍길동' autocomplete='off'></div></div>" +
    "<button class='btn bl g' id='go'>시작하기</button>" +
    "<p class='hint' style='margin-top:11px'>제출하면 바로 채점되고 점수가 선생님께 전송됩니다.</p></div></div>" +

    /* 2. 응시 */
    "<div id='s2' class='hd'><div class='bar'><div class='who' id='who'></div>" +
    "<div class='tm' id='tm'>--:--</div><div class='pg'><i id='pg'></i></div></div>" +
    "<div class='w'><div id='qs'></div>" +
    "<button class='btn bl p' id='sub' style='margin-top:6px'>제출하기</button>" +
    "<p class='hint' style='text-align:center;margin-top:11px'>제출 후에는 수정할 수 없습니다.</p></div></div>" +

    /* 3. 결과 */
    "<div id='s3' class='hd'><div class='w'>" +
    "<div class='card' style='text-align:center;padding:26px 14px'>" +
    "<div class='hint' id='rn'></div><div class='big' id='rb'>0</div>" +
    "<div class='hint' style='margin-top:4px'>/ 100점</div>" +
    "<div class='lv' id='rl'>A</div><div style='margin-top:13px' id='rc'></div></div>" +
    "<div class='card'><h2>문항별 결과와 해설</h2><div id='rlist'></div></div>" +
    "<p class='hint' style='text-align:center'>틀린 문항의 해설을 꼭 읽고 교과서에서 다시 확인하세요.</p></div></div>" +

    "<div class='ld' id='ld'><div class='ring'></div><p id='ldt'>LOADING…</p></div>" +
    "<div class='tst' id='tst'></div>" + js_() +

    "<script>" +
    "var ID='" + id + "';" +
    "var Q=" + (data ? JSON.stringify(data) : 'null') + ";" +
    "var ERR=" + JSON.stringify(err || '') + ";" +
    "var A={},T0=0,TM=null,ME={},SEND=false;" +
    "function scr(n){['s1','s2','s3'].forEach(function(s,i){$(s).classList.toggle('hd',i!==n-1)});window.scrollTo(0,0)}" +
    "function mem(op,v){try{if(op==='g')return localStorage.getItem('pq');localStorage.setItem('pq',v)}catch(e){if(op==='g')return window._m||null;window._m=v}}" +

    /* 문항이 페이지에 이미 들어 있으므로 서버를 다시 부르지 않습니다 */
    "if(ERR||!Q){$('info').innerHTML='<p class=\"hint\" style=\"color:var(--ro)\">'+esc(ERR||'평가를 불러오지 못했습니다.')+'</p>'+" +
    "  '<button class=\"btn s\" style=\"margin-top:12px\" onclick=\"location.reload()\">다시 시도</button>';}" +
    "else{" +
    " $('info').innerHTML='<span class=\"chip\">중'+Q.grade+'</span> <span class=\"chip a\">'+(Q.time?Q.time+'분':'시간제한 없음')+'</span> <span class=\"chip g\">'+Q.items.length+'문항</span>'+" +
    "  '<div style=\"margin-top:11px;font-size:15px;line-height:1.6;font-weight:500\">'+esc(Q.title)+'</div>';" +
    " show('lg');" +
    " try{var l=JSON.parse(mem('g')||'{}');if(l.g){$('g').value=l.g;$('c').value=l.c;$('n').value=l.n;$('nm').value=l.nm}}catch(e){}" +
    "}" +

    "$('go').onclick=function(){var g=$('g').value,c=$('c').value.trim(),n=$('n').value.trim(),nm=$('nm').value.trim();" +
    " if(!c||!n||!nm){toast('반·번호·이름을 모두 입력하세요.',true);return}" +
    " ME={grade:g,cls:Number(c),no:Number(n),name:nm};mem('s',JSON.stringify({g:g,c:c,n:n,nm:nm}));" +
    " $('who').textContent='중'+g+' · '+c+'반 '+n+'번 · '+nm;" +
    " draw();scr(2);T0=Date.now();" +
    " if(Q.time)timer(Q.time*60);else $('tm').textContent='∞'};" +

    "function timer(sec){var end=Date.now()+sec*1000;TM=setInterval(function(){" +
    " var L=Math.max(0,Math.round((end-Date.now())/1000));" +
    " $('tm').textContent=Math.floor(L/60)+':'+('0'+(L%60)).slice(-2);" +
    " $('tm').classList.toggle('wn',L<=60);" +
    " if(L<=0){clearInterval(TM);toast('시간이 끝나 자동 제출합니다.');send(true)}},500)}" +

    "function draw(){$('qs').innerHTML=Q.items.map(function(it){" +
    " var b=it.t==='MC'?it.c.map(function(ch,i){return '<div class=\"op\" data-q=\"'+it.n+'\" data-v=\"'+(i+1)+'\"><span class=\"nm\">'+(i+1)+'</span><span>'+esc(ch)+'</span></div>'}).join('')" +
    "  :'<input class=\"sa\" data-q=\"'+it.n+'\" placeholder=\"답을 입력하세요\" maxlength=\"40\" autocomplete=\"off\">';" +
    " return '<div class=\"qc\" id=\"q'+it.n+'\"><div style=\"display:flex;gap:7px;align-items:center\"><span class=\"qn\">'+it.n+'</span>'+" +
    "  '<span class=\"chip d\">'+(it.t==='MC'?'객관식':'단답형')+'</span></div>'+" +
    "  '<div class=\"qt\">'+esc(it.q)+'</div>'+b+'</div>'}).join('');" +
    " $('qs').querySelectorAll('.op').forEach(function(el){el.onclick=function(){var q=el.dataset.q;" +
    "  $('qs').querySelectorAll('.op[data-q=\"'+q+'\"]').forEach(function(x){x.classList.remove('on')});" +
    "  el.classList.add('on');A[q]=el.dataset.v;$('q'+q).classList.add('dn');prog()}});" +
    " $('qs').querySelectorAll('input.sa').forEach(function(el){el.oninput=function(){var q=el.dataset.q;" +
    "  A[q]=el.value.trim();$('q'+q).classList.toggle('dn',!!A[q]);prog()}});prog()}" +

    "function prog(){var d=Q.items.filter(function(i){return A[i.n]}).length;$('pg').style.width=(d/Q.items.length*100)+'%'}" +

    "$('sub').onclick=function(){send(false)};" +
    "function send(auto){if(SEND)return;" +
    " var bl=Q.items.filter(function(i){return !A[i.n]}).map(function(i){return i.n});" +
    " if(!auto&&bl.length&&!confirm(bl.join(', ')+'번을 아직 안 풀었어요. 그래도 제출할까요?')){" +
    "  var el=$('q'+bl[0]);if(el)window.scrollTo({top:el.offsetTop-70,behavior:'smooth'});return}" +
    " if(!auto&&!confirm('제출하면 수정할 수 없습니다. 제출할까요?'))return;" +
    " SEND=true;if(TM)clearInterval(TM);$('sub').disabled=true;$('ld').classList.add('on');$('ldt').textContent='채점 중…';" +
    " var pl={id:ID,grade:ME.grade,cls:ME.cls,no:ME.no,name:ME.name,answers:A,sec:Math.round((Date.now()-T0)/1000)};" +
    " var tries=0;" +
    " (function go(){tries++;" +
    "  google.script.run.withSuccessHandler(function(r){$('ld').classList.remove('on');SEND=false;done(r)})" +
    "   .withFailureHandler(function(e){var m=String(e&&e.message||e);" +
    "    var fatal=/마감|찾을 수 없|올바르지/.test(m);" +
    "    if(!fatal&&tries<6){$('ldt').textContent='순서를 기다리는 중… '+tries;" +
    "     setTimeout(go,700*Math.pow(1.7,tries-1)+Math.random()*900);return}" +
    "    $('ld').classList.remove('on');$('sub').disabled=false;SEND=false;" +
    "    toast(m==='BUSY'?'접속이 몰려 있어요. [제출하기]를 한 번 더 눌러 주세요.':('제출 실패: '+m),true)})" +
    "   .submit(pl)})()}" +

    "function done(r){scr(3);$('rn').textContent=r.name+' 학생 · '+r.title;" +
    " $('rb').textContent=r.pct;$('rb').classList.toggle('lo',r.pct<60);" +
    " var C={A:'var(--li)',B:'var(--cy)',C:'var(--am)',D:'var(--vi)',E:'var(--ro)'}[r.lv];" +
    " $('rl').textContent=r.lv;$('rl').style.color=C;$('rl').style.textShadow='0 0 8px #fff,0 0 24px '+C+',0 0 52px '+C;" +
    " $('rc').innerHTML='<span class=\"chip g\">맞은 개수 '+r.score+' / '+r.total+'</span>';" +
    " $('rlist').innerHTML=r.detail.map(function(d){" +
    "  var it=Q.items[d.n-1]||{t:'SA',q:'',c:[]},mi,an;" +
    "  if(it.t==='MC'){mi=d.given?(d.given+'. '+(it.c[Number(d.given)-1]||'')):'(무응답)';an=d.a+'. '+(it.c[Number(d.a)-1]||'')}" +
    "  else{mi=d.given||'(무응답)';an=d.a}" +
    "  return '<div class=\"rs'+(d.ok?'':' x')+'\"><div class=\"t\"><span style=\"font-family:Orbitron\">'+d.n+'</span>'+" +
    "   '<span class=\"chip '+(d.ok?'g':'r')+'\">'+(d.ok?'정답':'오답')+'</span></div>'+" +
    "   '<div class=\"q\">'+esc(it.q)+'</div>'+" +
    "   '<div class=\"a\">내 답 <b class=\"mi\">'+esc(mi)+'</b>'+(d.ok?'':' → 정답 <b>'+esc(an)+'</b>')+'</div>'+" +
    "   '<div class=\"e\">'+esc(d.e)+'</div></div>'}).join('')}" +

    "window.addEventListener('beforeunload',function(e){" +
    " if(!$('s2').classList.contains('hd')&&!SEND){e.preventDefault();e.returnValue=''}});" +
    "<\/script></body></html>";
}
