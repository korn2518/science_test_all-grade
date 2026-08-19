/*************************************************************
 * NEON 형성평가 시스템 v2 — JSON API 서버
 * 2022 개정 교육과정 중학교 과학 · 두레자연중학교
 *
 * v1 대비 변경 (동시 접속 성능)
 *  1) 학생 화면은 GitHub Pages(정적 CDN)에서 로드 → Apps Script는 데이터만 응답
 *  2) CacheService로 문항 캐싱 → 두 번째 학생부터 시트를 읽지 않음
 *  3) 잠금(Lock) 구간을 시트 쓰기 1회로 축소 → 대기 시간 1/5 수준
 *  4) '문항응답' 시트 제거 → 제출 1건당 시트 쓰기 1회 (기존 2회)
 *     문항별 정답률은 대시보드에서 응답JSON으로 계산
 *************************************************************/

const SHEET_BANK = '문제은행';
const SHEET_RESP = '응답';
const AUTO_MODEL = '(자동 선택)';   // 비워 두면 사용 가능한 최신 flash 모델을 자동으로 고릅니다
const CACHE_SEC = 21600; // 6시간

const BANK_HEADERS = ['퀴즈ID', '생성일시', '학년', '영역', '성취기준코드', '성취기준', '수업주제', '제한시간(분)', '상태', '문항JSON', '출제자'];
const RESP_HEADERS = ['제출일시', '퀴즈ID', '수업주제', '성취기준코드', '학년', '반', '번호', '이름', '점수', '만점', '백분율', '성취수준', '객관식점수', '단답점수', '소요(초)', '오답문항', '응답JSON'];

/* ═══════════════════ 라우팅 ═══════════════════ */

function doGet(e) {
  const p = (e && e.parameter) || {};

  // ── JSON API ──
  if (p.api) {
    try {
      if (p.api === 'ping') return json_({ ok: true, t: Date.now() });
      if (p.api === 'quiz') return json_({ ok: true, quiz: getQuizForStudent(p.id) });
      if (p.api === 'submit') return json_({ ok: true, result: submitAnswers(decodePayload_(p.p)) });
      if (p.api === 'dash') { requirePin_(p.pin); return json_({ ok: true, data: getDashboard(p.id || '') }); }
      if (p.api === 'quizzes') { requirePin_(p.pin); return json_({ ok: true, quizzes: listQuizzes() }); }
      return json_({ ok: false, error: '알 수 없는 요청입니다.' });
    } catch (err) {
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  // ── 교사 출제실 (Apps Script에서 그대로 제공, 사용자 1명이라 부하 없음) ──
  const t = HtmlService.createTemplateFromFile('Teacher');
  t.webAppUrl = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle('형성평가 출제실')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 학생 제출 창구.
 * 브라우저 프리플라이트(OPTIONS)를 피하려고 클라이언트는
 * Content-Type: text/plain 으로 JSON 문자열을 보냅니다.
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'submit') return json_({ ok: true, result: submitAnswers(body) });
    if (body.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: '알 수 없는 요청입니다.' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function decodePayload_(b64) {
  const bytes = Utilities.base64DecodeWebSafe(String(b64 || ''));
  return JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ═══════════════════ 설정 ═══════════════════ */

function props_() { return PropertiesService.getScriptProperties(); }

function setApiKey(key) { props_().setProperty('GEMINI_API_KEY', String(key || '').trim()); return true; }
function setModel(m) {
  m = String(m || '').trim();
  if (!m || m.charAt(0) === '(') m = '';   // '(자동 선택)' 이면 비워 두고 자동 판단
  props_().setProperty('GEMINI_MODEL', m);
  return true;
}
function setPin(pin) { props_().setProperty('TEACHER_PIN', String(pin || '').trim()); return true; }

function requirePin_(pin) {
  const real = props_().getProperty('TEACHER_PIN') || '';
  if (!real) throw new Error('교사 PIN이 아직 설정되지 않았습니다. 출제실 → 설정에서 지정하세요.');
  if (String(pin || '') !== real) throw new Error('PIN이 올바르지 않습니다.');
}

function getConfig() {
  const k = props_().getProperty('GEMINI_API_KEY') || '';
  return {
    hasKey: !!k,
    keyTail: k ? '••••' + k.slice(-4) : '',
    model: props_().getProperty('GEMINI_MODEL') || AUTO_MODEL,
    hasPin: !!(props_().getProperty('TEACHER_PIN') || ''),
    pagesUrl: props_().getProperty('PAGES_URL') || '',
    webAppUrl: ScriptApp.getService().getUrl(),
    sheetUrl: ss_().getUrl()
  };
}

function setPagesUrl(url) {
  props_().setProperty('PAGES_URL', String(url || '').trim().replace(/\/+$/, ''));
  return true;
}

/** UI용 — 모델 목록. 추천 모델이 맨 앞에 옵니다. */
function listGeminiModels() {
  const key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('API 키를 먼저 저장하세요.');
  const all = listGeminiModels_(key);
  let best = '';
  try { best = pickBestModel_(key); } catch (e) { }
  if (best) return [best].concat(all.filter(function (n) { return n !== best; }));
  return all;
}

/** 설정 탭 [자동 선택] 버튼용 */
function autoPickModel() {
  const key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('API 키를 먼저 저장하세요.');
  const m = pickBestModel_(key);
  props_().setProperty('GEMINI_MODEL', m);
  return m;
}

/* ═══════════════════ 스프레드시트 ═══════════════════ */

function ss_() {
  const id = props_().getProperty('SS_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (err) { } }
  const s = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('두레자연중 과학 형성평가 데이터');
  props_().setProperty('SS_ID', s.getId());
  return s;
}

function sheet_(name, headers) {
  const s = ss_();
  let sh = s.getSheetByName(name);
  if (!sh) {
    sh = s.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0f172a').setFontColor('#67e8f9');
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, headers.length, 130);
  }
  return sh;
}

function bankSheet_() { return sheet_(SHEET_BANK, BANK_HEADERS); }
function respSheet_() { return sheet_(SHEET_RESP, RESP_HEADERS); }

/** 최초 1회 실행 */
function setup() {
  bankSheet_(); respSheet_();
  const old = ss_().getSheetByName('문항응답');
  if (old) ss_().deleteSheet(old); // v1 잔재 정리 (더 이상 쓰지 않음)
  return ss_().getUrl();
}

/* ═══════════════════ 성취기준 (UI용) ═══════════════════ */

function fetchAreas() { return getAreas(); }
function fetchStandards(areaNo) { return getStandardsByArea(areaNo); }

/* ═══════════════════ 문항 생성 (Gemini) ═══════════════════ */

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          no: { type: 'INTEGER' },
          type: { type: 'STRING', enum: ['MC', 'SA'] },
          level: { type: 'STRING', enum: ['하', '중', '상'] },
          stem: { type: 'STRING' },
          choices: { type: 'ARRAY', items: { type: 'STRING' } },
          answer: { type: 'STRING' },
          accept: { type: 'ARRAY', items: { type: 'STRING' } },
          explain: { type: 'STRING' }
        },
        required: ['no', 'type', 'level', 'stem', 'answer', 'explain']
      }
    }
  },
  required: ['items']
};

function buildPrompt_(cfg) {
  const std = findStandard(cfg.code);
  if (!std) throw new Error('성취기준을 찾을 수 없습니다: ' + cfg.code);
  return [
    '당신은 대한민국 중학교 과학 교사이자 평가 문항 개발 전문가입니다.',
    '2022 개정 교육과정 중학교 과학 성취기준에 근거하여, 수업 직후 5~10분 안에 푸는 형성평가 10문항을 만드세요.',
    '',
    '## 평가 근거',
    '- 대상: 중학교 ' + cfg.grade + '학년',
    '- 영역: ' + std.a,
    '- 성취기준 ' + std.c + ': ' + std.s,
    '- A수준(상) 기술: ' + (std.A || '-'),
    '- C수준(중) 기술: ' + (std.C || '-'),
    '- 오늘 수업 주제: ' + cfg.topic,
    cfg.note ? '- 교사 추가 요청: ' + cfg.note : '',
    '',
    '## 문항 구성 (반드시 준수)',
    '- 총 10문항. 1~8번은 5지선다 객관식(type "MC"), 9~10번은 단답형(type "SA").',
    '- 난이도(level) 배분: 하 3문항, 중 5문항, 상 2문항. 1번부터 대체로 쉬운 순서로 배열.',
    '- MC 문항: choices에 정확히 5개의 선택지를 넣고, answer에는 정답 선택지의 번호("1"~"5")만 씁니다.',
    '- SA 문항: choices는 빈 배열. answer에는 가장 표준적인 정답 한 개(핵심 용어/짧은 어구, 15자 이내).',
    '  accept에는 자동채점에서 정답으로 인정할 표기 변형을 3~6개 넣습니다(띄어쓰기·동의어·한자어/우리말·단위 표기 등).',
    '- 계산 문항은 최대 1개, 암산 가능한 수치만 사용합니다.',
    '- explain: 학생이 제출 직후 읽을 1~2문장 해설. 왜 그 답인지 + 흔한 오개념 짚기.',
    '',
    '## 언어·표현 규칙',
    '- 모든 문장은 한국어. 중학생이 읽을 수 있는 문장 길이(한 문항 stem은 2문장 이내).',
    '- 교과서 용어를 사용하고, 상위 학년 개념(고등학교 수준)은 쓰지 않습니다.',
    '- "다음 중 옳지 않은 것은?" 유형은 최대 2문항까지만.',
    '- 그림·표·그래프가 반드시 있어야 풀 수 있는 문항은 만들지 않습니다. 필요한 정보는 글로 모두 제시합니다.',
    '- 선택지는 길이를 비슷하게 맞추고, 정답 번호가 한쪽에 몰리지 않게 고르게 분포시킵니다.',
    '',
    'JSON만 출력하세요.'
  ].filter(String).join('\n');
}

/**
 * 사용 가능한 모델 중 가장 좋은 flash 계열을 고른다.
 * 구글이 모델 이름을 바꿔도(gemini-3.7-flash 등) 알아서 따라갑니다.
 */
function pickBestModel_(key) {
  const names = listGeminiModels_(key);
  let best = '', bestScore = -1;
  names.forEach(function (n) {
    if (!/flash/i.test(n)) return;
    if (/embedding|tts|image|imagen|veo|live|omni|robotics|learnlm|aqa|audio|native/i.test(n)) return;
    let s = 0;
    const m = n.match(/gemini-(\d+(?:\.\d+)?)-flash/);
    if (m) s += parseFloat(m[1]) * 100;
    if (/latest/.test(n)) s += 5;
    if (/lite/.test(n)) s -= 30;
    if (/preview|exp/.test(n)) s -= 60;
    if (/thinking/.test(n)) s -= 20;
    if (/-\d{3,}$/.test(n)) s -= 10;          // 날짜 스냅샷
    if (s > bestScore) { bestScore = s; best = n; }
  });
  if (!best && names.length) best = names[0];
  if (!best) throw new Error('사용 가능한 모델을 찾지 못했습니다. API 키를 확인하세요.');
  return best;
}

function listGeminiModels_(key) {
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('모델 목록 조회 실패 (' + res.getResponseCode() + ') — API 키가 올바른지 확인하세요.');
  }
  return (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
    .map(function (m) { return m.name.replace('models/', ''); })
    .filter(function (n) { return !/embedding|aqa|imagen|veo|tts/i.test(n); })
    .sort();
}

/**
 * Gemini 호출.
 * 모델 세대마다 지원하는 옵션이 달라서 세 가지 조합을 순서대로 시도합니다.
 *  ① JSON 스키마 지정  ② JSON 형식만 지정  ③ 옵션 없음
 * Gemini 3.x 부터 temperature 가 제거되었으므로 아예 보내지 않습니다.
 */
function callGemini_(key, model, prompt) {
  const variants = [
    { responseMimeType: 'application/json', responseSchema: ITEM_SCHEMA },
    { responseMimeType: 'application/json' },
    null
  ];
  let last = { code: 0, text: '' };

  for (var v = 0; v < variants.length; v++) {
    const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    if (variants[v]) payload.generationConfig = variants[v];

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

    for (var i = 0; i < 3; i++) {
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code === 200) return { ok: true, code: 200, text: res.getContentText() };

      last = { code: code, text: res.getContentText().slice(0, 500) };
      if (code === 404 || code === 403) return { ok: false, code: code, text: last.text };  // 재시도 무의미
      if (code === 400) break;                                                              // 옵션 문제 → 다음 조합
      Utilities.sleep(1200 * (i + 1));                                                      // 429/500 → 잠깐 쉬고 재시도
    }
  }
  return { ok: false, code: last.code, text: last.text };
}

function geminiErrorMsg_(r, model) {
  if (r.code === 404) {
    return '모델 "' + model + '" 을(를) 찾을 수 없습니다.\n' +
      '구글이 모델 이름을 바꾼 것 같습니다. 설정 탭 → [모델 목록 불러오기] 를 눌러 목록에서 고른 뒤 저장하세요.';
  }
  if (r.code === 403) return 'API 키가 거부되었습니다. 키가 만료되었거나 권한이 없습니다. 새 키를 발급받아 저장하세요.';
  if (r.code === 429) return '무료 사용 한도를 넘었습니다. 1~2분 뒤에 다시 시도하세요.';
  if (r.code === 400) return 'Gemini가 요청을 거부했습니다.\n' + r.text.slice(0, 250);
  if (r.code === 0) return '네트워크 오류로 Gemini에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.';
  return 'Gemini 호출 실패 (' + r.code + ')\n' + r.text.slice(0, 250);
}

function generateQuiz(cfg) {
  const key = props_().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini API 키가 없습니다.\n설정 탭에서 키를 저장한 뒤 다시 시도하세요.');

  let model = props_().getProperty('GEMINI_MODEL') || '';
  // 다시 생성할 때마다 다른 문항이 나오도록 하는 표식 (temperature 대체)
  const prompt = buildPrompt_(cfg) + '\n\n(문항 세트 식별자: ' + Utilities.getUuid().slice(0, 8) + ')';

  // 모델이 없으면 지금 사용 가능한 것 중 가장 좋은 것을 자동 선택
  if (!model) {
    model = pickBestModel_(key);
    props_().setProperty('GEMINI_MODEL', model);
  }

  let r = callGemini_(key, model, prompt);

  // 모델명이 바뀌어 404가 나면 자동으로 최신 모델로 갈아타고 재시도
  if (!r.ok && r.code === 404) {
    let better = '';
    try { better = pickBestModel_(key); } catch (e) { }
    if (better && better !== model) {
      model = better;
      props_().setProperty('GEMINI_MODEL', model);
      r = callGemini_(key, model, prompt);
    }
  }
  if (!r.ok) throw new Error(geminiErrorMsg_(r, model));

  const body = JSON.parse(r.text);
  const cand = body.candidates && body.candidates[0];
  if (cand && cand.finishReason === 'SAFETY') {
    throw new Error('안전 필터에 걸렸습니다. 수업 주제 표현을 바꿔 다시 시도하세요.');
  }
  let text = cand && cand.content && cand.content.parts &&
    cand.content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('응답이 비었습니다. 수업 주제를 조금 더 구체적으로 적고 다시 시도하세요.');

  // ```json ... ``` 로 감싸 오는 경우 정리
  text = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s > 0 || e < text.length - 1) text = text.slice(Math.max(0, s), e + 1);

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { throw new Error('문항 형식을 읽지 못했습니다. [다시 생성]을 한 번 더 눌러 주세요.'); }

  const items = normalizeItems_(parsed.items || []);
  if (items.length !== 10) {
    throw new Error('문항이 ' + items.length + '개만 만들어졌습니다. [다시 생성]을 눌러 주세요.');
  }

  const std = findStandard(cfg.code);
  return {
    grade: cfg.grade, area: std.a, code: std.c, standard: std.s,
    topic: cfg.topic, timeLimit: cfg.timeLimit || 0, items: items
  };
}

function normalizeItems_(raw) {
  return raw.slice(0, 10).map(function (it, i) {
    const type = (it.type === 'SA' || i >= 8) ? (it.type || 'SA') : 'MC';
    const o = {
      no: i + 1, type: type, level: it.level || '중',
      stem: String(it.stem || '').trim(),
      choices: type === 'MC' ? (it.choices || []).slice(0, 5).map(function (c) { return String(c).trim(); }) : [],
      answer: String(it.answer || '').trim(),
      accept: type === 'SA' ? (it.accept || []).map(function (a) { return String(a).trim(); }) : [],
      explain: String(it.explain || '').trim()
    };
    if (o.type === 'MC') {
      if (!/^[1-5]$/.test(o.answer)) {
        const idx = o.choices.indexOf(o.answer);
        o.answer = idx >= 0 ? String(idx + 1) : '1';
      }
    } else if (o.accept.indexOf(o.answer) < 0) {
      o.accept.unshift(o.answer);
    }
    return o;
  });
}

/* ═══════════════════ 퀴즈 저장 / 목록 ═══════════════════ */

function studentUrl_(id) {
  const pages = props_().getProperty('PAGES_URL') || '';
  return pages ? pages + '/?id=' + id : ScriptApp.getService().getUrl() + '?api=quiz&id=' + id;
}

function saveQuiz(quiz) {
  const id = 'Q' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd-HHmmss') +
    '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  let author = '';
  try { author = Session.getActiveUser().getEmail() || ''; } catch (err) { }

  bankSheet_().appendRow([
    id, new Date(), quiz.grade, quiz.area, quiz.code, quiz.standard,
    quiz.topic, quiz.timeLimit || 0, '공개', JSON.stringify(quiz.items), author
  ]);
  cacheQuiz_(id); // 첫 학생이 기다리지 않도록 미리 데워 둔다
  return { quizId: id, url: studentUrl_(id) };
}

function listQuizzes() {
  const sh = bankSheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  const vals = sh.getRange(2, 1, n, BANK_HEADERS.length).getValues();

  const resp = respSheet_();
  const rn = resp.getLastRow() - 1;
  const counts = {};
  if (rn > 0) {
    resp.getRange(2, 2, rn, 1).getValues().forEach(function (r) { counts[r[0]] = (counts[r[0]] || 0) + 1; });
  }
  return vals.map(function (v) {
    return {
      quizId: v[0],
      created: Utilities.formatDate(new Date(v[1]), 'Asia/Seoul', 'MM/dd HH:mm'),
      grade: v[2], area: v[3], code: v[4], topic: v[6],
      timeLimit: v[7], status: v[8], count: counts[v[0]] || 0,
      url: studentUrl_(v[0])
    };
  }).reverse();
}

function toggleQuizStatus(quizId) {
  const sh = bankSheet_();
  const n = sh.getLastRow() - 1;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (var i = 0; i < n; i++) {
    if (ids[i][0] === quizId) {
      const cur = sh.getRange(i + 2, 9).getValue();
      const next = cur === '공개' ? '마감' : '공개';
      sh.getRange(i + 2, 9).setValue(next);
      CacheService.getScriptCache().remove('Q_' + quizId);
      return next;
    }
  }
  throw new Error('퀴즈를 찾을 수 없습니다.');
}

/** 시트에서 문항JSON을 직접 고친 뒤 누르는 버튼 */
function clearQuizCache(quizId) {
  const c = CacheService.getScriptCache();
  if (quizId) c.remove('Q_' + quizId);
  else {
    const sh = bankSheet_();
    const n = sh.getLastRow() - 1;
    if (n > 0) {
      c.removeAll(sh.getRange(2, 1, n, 1).getValues().map(function (r) { return 'Q_' + r[0]; }));
    }
  }
  return true;
}

/* ═══════════════════ 캐시 (동시 접속 핵심) ═══════════════════ */

/**
 * 문항을 캐시에 올린다.
 * 30명이 동시에 들어와도 시트를 읽는 건 사실상 첫 1명뿐.
 */
function cacheQuiz_(quizId) {
  const sh = bankSheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) throw new Error('평가가 아직 없습니다.');
  const vals = sh.getRange(2, 1, n, BANK_HEADERS.length).getValues();
  for (var i = n - 1; i >= 0; i--) { // 최근 것부터 — 방금 만든 평가를 빨리 찾음
    if (vals[i][0] === quizId) {
      const rec = {
        quizId: quizId, grade: vals[i][2], area: vals[i][3], code: vals[i][4],
        topic: vals[i][6], timeLimit: Number(vals[i][7]) || 0,
        status: vals[i][8], items: JSON.parse(vals[i][9])
      };
      try {
        CacheService.getScriptCache().put('Q_' + quizId, JSON.stringify(rec), CACHE_SEC);
      } catch (err) { /* 100KB 초과 시 캐시 없이 진행 */ }
      return rec;
    }
  }
  throw new Error('평가를 찾을 수 없습니다. 링크를 다시 확인하세요.');
}

function loadQuiz_(quizId) {
  if (!quizId) throw new Error('평가 주소가 올바르지 않습니다.');
  const hit = CacheService.getScriptCache().get('Q_' + quizId);
  if (hit) { try { return JSON.parse(hit); } catch (err) { } }
  return cacheQuiz_(quizId);
}

/* ═══════════════════ 학생 응시 ═══════════════════ */

/** 정답은 빼고 보낸다 */
function getQuizForStudent(quizId) {
  const q = loadQuiz_(quizId);
  if (q.status === '마감') throw new Error('이 형성평가는 마감되었습니다. 선생님께 문의하세요.');
  return {
    quizId: q.quizId, grade: q.grade, area: q.area, code: q.code,
    topic: q.topic, timeLimit: q.timeLimit,
    items: q.items.map(function (it) {
      return { no: it.no, type: it.type, level: it.level, stem: it.stem, choices: it.choices };
    })
  };
}

function norm_(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s·.,'"“”‘’()\[\]/\-_]/g, '')
    .replace(/입니다$|이다$|요$/, '');
}

function gradeOne_(it, given) {
  if (it.type === 'MC') return String(given).trim() === String(it.answer);
  const g = norm_(given);
  return !!g && (it.accept || [it.answer]).some(function (a) {
    const na = norm_(a);
    return na && (g === na || (na.length >= 2 && g.indexOf(na) >= 0));
  });
}

function levelOf_(pct) {
  return pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'E';
}

/**
 * 채점 + 저장.
 * 채점은 캐시에서 하므로 시트를 읽지 않고, 잠금은 append 1회에만 건다.
 */
function submitAnswers(payload) {
  const q = loadQuiz_(payload.quizId);
  if (q.status === '마감') throw new Error('이 형성평가는 마감되었습니다.');

  const answers = payload.answers || {};
  const now = new Date();
  let score = 0, mc = 0, sa = 0;
  const wrong = [], detail = [];

  q.items.forEach(function (it) {
    const given = String(answers[it.no] == null ? '' : answers[it.no]).trim();
    const ok = gradeOne_(it, given);
    if (ok) { score++; if (it.type === 'MC') mc++; else sa++; } else wrong.push(it.no);
    detail.push({
      no: it.no, type: it.type, level: it.level, given: given,
      answer: it.answer, correct: ok, explain: it.explain,
      choices: it.choices, stem: it.stem
    });
  });

  const pct = Math.round(score / q.items.length * 100);
  const row = [
    now, q.quizId, q.topic, q.code, payload.grade, payload.classNo, payload.studentNo,
    payload.name, score, q.items.length, pct, levelOf_(pct), mc, sa,
    payload.elapsed || '', wrong.join(','), JSON.stringify(answers)
  ];

  // ── 잠금 구간: 시트 쓰기 1회만 (약 0.3~0.6초) ──
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(28000)) throw new Error('지금 접속이 몰려 있습니다. 잠시 뒤 다시 제출해 주세요.');
  try {
    respSheet_().appendRow(row);
  } finally {
    lock.releaseLock();
  }

  return {
    score: score, total: q.items.length, pct: pct, level: levelOf_(pct),
    mcScore: mc, saScore: sa, detail: detail, topic: q.topic, name: payload.name
  };
}

/* ═══════════════════ 대시보드 ═══════════════════ */

function getDashboard(quizId) {
  const resp = respSheet_();
  const rn = resp.getLastRow() - 1;
  const quizzes = listQuizzes();
  if (rn <= 0) return { quizzes: quizzes, rows: [], stats: null };

  const all = resp.getRange(2, 1, rn, RESP_HEADERS.length).getValues();
  const picked = all.filter(function (r) { return !quizId || r[1] === quizId; });
  const rows = picked.map(function (r) {
    return {
      time: Utilities.formatDate(new Date(r[0]), 'Asia/Seoul', 'MM/dd HH:mm'),
      quizId: r[1], topic: r[2], code: r[3], grade: r[4], classNo: r[5],
      studentNo: r[6], name: r[7], score: r[8], total: r[9], pct: r[10],
      level: r[11], wrong: String(r[15] || '')
    };
  }).reverse();

  if (!rows.length) return { quizzes: quizzes, rows: [], stats: null };

  const pcts = rows.map(function (r) { return r.pct; });
  const avg = Math.round(pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length);
  const sorted = pcts.slice().sort(function (a, b) { return a - b; });

  const levelDist = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  rows.forEach(function (r) { levelDist[r.level]++; });

  const byClass = {};
  rows.forEach(function (r) { (byClass[r.grade + '-' + r.classNo] = byClass[r.grade + '-' + r.classNo] || []).push(r.pct); });
  const classStats = Object.keys(byClass).sort().map(function (k) {
    const v = byClass[k];
    return { name: k + '반', n: v.length, avg: Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length) };
  });

  // 문항별 정답률 — 응답JSON + 정답키로 계산 (별도 시트 불필요)
  let itemStats = [];
  if (quizId) {
    try {
      const q = loadQuiz_(quizId);
      const agg = q.items.map(function (it) {
        return { no: it.no, type: it.type === 'MC' ? '객관식' : '단답형', level: it.level, o: 0, n: 0, w: {} };
      });
      picked.forEach(function (r) {
        let ans = {};
        try { ans = JSON.parse(r[16] || '{}'); } catch (err) { }
        q.items.forEach(function (it, i) {
          const given = String(ans[it.no] == null ? '' : ans[it.no]).trim();
          agg[i].n++;
          if (gradeOne_(it, given)) agg[i].o++;
          else {
            let label = given || '(무응답)';
            if (it.type === 'MC' && /^[1-5]$/.test(given)) label = given + '번';
            agg[i].w[label] = (agg[i].w[label] || 0) + 1;
          }
        });
      });
      itemStats = agg.map(function (a) {
        const top = Object.keys(a.w).sort(function (x, y) { return a.w[y] - a.w[x]; })[0];
        return {
          no: a.no, type: a.type, level: a.level,
          rate: a.n ? Math.round(a.o / a.n * 100) : 0,
          topWrong: top ? top + ' (' + a.w[top] + '명)' : '-'
        };
      });
    } catch (err) { itemStats = []; }
  }

  return {
    quizzes: quizzes, rows: rows,
    stats: {
      n: rows.length, avg: avg, median: sorted[Math.floor(sorted.length / 2)],
      max: Math.max.apply(null, pcts), min: Math.min.apply(null, pcts),
      levelDist: levelDist, classStats: classStats, itemStats: itemStats
    }
  };
}

function deleteResponse(quizId, name, studentNo) {
  const sh = respSheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return 0;
  const vals = sh.getRange(2, 1, n, RESP_HEADERS.length).getValues();
  let removed = 0;
  for (var i = n - 1; i >= 0; i--) {
    if (vals[i][1] === quizId && vals[i][7] === name && String(vals[i][6]) === String(studentNo)) {
      sh.deleteRow(i + 2); removed++;
    }
  }
  return removed;
}
