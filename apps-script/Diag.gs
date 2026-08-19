/*************************************************************
 * 자가진단 — 무엇이 빠졌는지 찾아 줍니다.
 *
 * 사용법 (재배포 필요 없음)
 *  1) Apps Script 편집기 상단 함수 선택창에서  진단  선택
 *  2) ▶ 실행
 *  3) 아래 [실행 로그] 창에 나오는 내용을 그대로 복사해서 보내주세요
 *************************************************************/

function 진단() {
  const L = [];
  const ok = function (m) { L.push('✅ ' + m); };
  const no = function (m) { L.push('❌ ' + m); };
  const warn = function (m) { L.push('⚠️  ' + m); };
  const info = function (m) { L.push('   ' + m); };

  L.push('════════ 형성평가 시스템 자가진단 ════════');
  L.push('실행 시각: ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'));
  L.push('');

  /* ── 1. 파일 설치 확인 ── */
  L.push('── 1. 파일 설치 ──');

  var standardsOK = false;
  try {
    if (typeof STANDARDS === 'undefined') throw new Error('없음');
    if (typeof getAreas !== 'function') throw new Error('함수 없음');
    var areas = getAreas();
    ok('Standards.gs 정상 — 영역 ' + areas.length + '개 / 성취기준 ' + STANDARDS.length + '개');
    if (areas.length !== 23 || STANDARDS.length !== 87) {
      warn('숫자가 다릅니다. 정상은 영역 23개 / 성취기준 87개입니다. 붙여넣기가 잘렸을 수 있습니다.');
    }
    standardsOK = true;
  } catch (e) {
    no('Standards.gs 를 찾을 수 없습니다.  ← 가장 흔한 원인');
    info('· 파일이 아예 없거나');
    info('· HTML 파일로 잘못 추가했거나 (반드시 [스크립트]로 추가)');
    info('· 파일 이름이 Standards 가 아니거나');
    info('· 내용이 중간에서 잘려 붙여넣어진 경우입니다.');
    info('→ 2_Standards.gs.txt 를 전체 선택(Ctrl+A/⌘A) 후 다시 붙여넣으세요.');
  }

  try {
    HtmlService.createHtmlOutputFromFile('Teacher');
    ok('Teacher.html 정상');
  } catch (e) {
    no('Teacher 라는 HTML 파일이 없습니다.');
    info('→ + → HTML → 이름 "Teacher" (점html 붙이지 말 것)');
  }

  try {
    if (typeof doGet !== 'function') throw new Error('x');
    if (typeof submitAnswers !== 'function') throw new Error('x');
    if (typeof generateQuiz !== 'function') throw new Error('x');
    ok('Code.gs 정상');
  } catch (e) {
    no('Code.gs 내용이 불완전합니다. 1_Code.gs.txt 를 다시 통째로 붙여넣으세요.');
  }
  L.push('');

  /* ── 2. 스프레드시트 ── */
  L.push('── 2. 스프레드시트 ──');
  var s = null;
  try {
    s = ss_();
    ok('연결됨: ' + s.getName());
    info('주소: ' + s.getUrl());
    var names = s.getSheets().map(function (x) { return x.getName(); });
    info('시트 목록: ' + names.join(', '));
    if (names.indexOf('문제은행') < 0 || names.indexOf('응답') < 0) {
      warn('문제은행 / 응답 시트가 없습니다 → 함수 setup 을 한 번 실행하세요.');
    } else {
      ok('필요한 시트 모두 있음');
      var bank = s.getSheetByName('문제은행');
      var resp = s.getSheetByName('응답');
      info('저장된 평가: ' + Math.max(0, bank.getLastRow() - 1) + '개');
      info('누적 응답: ' + Math.max(0, resp.getLastRow() - 1) + '건');
    }
  } catch (e) {
    no('스프레드시트 연결 실패: ' + e.message);
    info('→ 함수 setup 을 한 번 실행하세요.');
  }
  L.push('');

  /* ── 3. 설정값 ── */
  L.push('── 3. 설정값 ──');
  var P = PropertiesService.getScriptProperties();
  var key = P.getProperty('GEMINI_API_KEY') || '';
  var model = P.getProperty('GEMINI_MODEL') || '';
  var pin = P.getProperty('TEACHER_PIN') || '';
  var pages = P.getProperty('PAGES_URL') || '';

  if (key) ok('Gemini API 키: ••••' + key.slice(-4) + ' (길이 ' + key.length + ')');
  else { no('Gemini API 키 미설정  ← 문항 생성이 안 되는 원인'); info('→ 출제실 → 설정 탭에서 저장하세요.'); }

  if (model) ok('모델: ' + model);
  else info('모델 미설정 — 사용 가능한 최신 flash 모델을 자동 선택합니다 (정상)');

  if (pin) ok('교사 PIN 설정됨');
  else warn('교사 PIN 미설정 — 대시보드를 열 수 없습니다.');

  if (pages) {
    ok('GitHub Pages 주소: ' + pages);
    if (/\/$/.test(pages)) warn('끝에 / 가 붙어 있습니다. 빼는 것이 좋습니다.');
    if (pages.indexOf('github.io') < 0) warn('github.io 주소가 아닌 것 같습니다. 확인해 보세요.');
  } else {
    warn('GitHub Pages 주소 미설정 — 학생 링크가 발급되지 않습니다.');
  }
  L.push('');

  /* ── 4. 웹앱 배포 ── */
  L.push('── 4. 웹앱 배포 ──');
  try {
    var url = ScriptApp.getService().getUrl();
    if (url) {
      ok('웹앱 주소: ' + url);
      if (url.indexOf('/exec') < 0) warn('주소가 /exec 로 끝나지 않습니다. 테스트 배포일 수 있습니다.');
    } else {
      no('아직 웹 앱으로 배포되지 않았습니다.');
      info('→ 배포 → 새 배포 → 웹 앱 → 액세스: 모든 사용자');
    }
  } catch (e) {
    no('배포 정보를 읽을 수 없습니다: ' + e.message);
  }
  L.push('');

  /* ── 5. Gemini 실제 호출 ── */
  L.push('── 5. Gemini 실제 호출 테스트 ──');
  if (!key) {
    info('API 키가 없어 건너뜁니다.');
  } else {
    var m = model;
    if (!m) {
      try { m = pickBestModel_(key); info('자동 선택된 모델: ' + m); }
      catch (e) { m = 'gemini-3.7-flash'; warn('자동 선택 실패 — ' + e.message); }
    }
    try {
      var res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) +
        ':generateContent?key=' + encodeURIComponent(key),
        {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '1+1은? 숫자만 답하세요.' }] }] })
        });
      var code = res.getResponseCode();
      if (code === 200) {
        ok('Gemini 호출 성공 (' + m + ')');
      } else {
        no('Gemini 호출 실패 — HTTP ' + code);
        info(res.getContentText().slice(0, 400));
        if (code === 404) info('→ 모델 이름이 틀렸습니다. 아래 사용 가능 모델 목록에서 고르세요.');
        if (code === 400) info('→ API 키 형식이 잘못되었을 수 있습니다.');
        if (code === 403) info('→ API 키 권한 문제이거나 키가 비활성 상태입니다.');
        if (code === 429) info('→ 무료 한도 초과입니다. 잠시 뒤 다시 시도하세요.');
      }
    } catch (e) {
      no('Gemini 호출 중 오류: ' + e.message);
    }

    /* 사용 가능 모델 목록 */
    try {
      var lr = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key),
        { muteHttpExceptions: true });
      if (lr.getResponseCode() === 200) {
        var ms = (JSON.parse(lr.getContentText()).models || [])
          .filter(function (x) { return (x.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
          .map(function (x) { return x.name.replace('models/', ''); })
          .filter(function (n) { return /flash/i.test(n) && !/embedding|tts|image|live|thinking/i.test(n); });
        info('');
        info('사용 가능한 flash 계열 모델 (' + ms.length + '개):');
        ms.slice(0, 15).forEach(function (n) { info('  · ' + n); });
      } else {
        warn('모델 목록 조회 실패 — HTTP ' + lr.getResponseCode());
      }
    } catch (e) {
      warn('모델 목록 조회 오류: ' + e.message);
    }
  }
  L.push('');

  /* ── 6. 문항 생성 실전 테스트 ── */
  L.push('── 6. 문항 생성 실전 테스트 ──');
  if (!key || !standardsOK) {
    info('앞 단계가 해결되어야 실행됩니다.');
  } else {
    try {
      var q = generateQuiz({ grade: '2', code: '9과04-04', topic: '상태 변화와 열에너지 출입', note: '', timeLimit: 10 });
      ok('문항 ' + q.items.length + '개 생성 성공');
      info('1번 문항: ' + String(q.items[0].stem).slice(0, 60) + '...');
      info('9번 단답: ' + q.items[8].answer + ' (인정표기 ' + (q.items[8].accept || []).length + '개)');
    } catch (e) {
      no('문항 생성 실패: ' + e.message);
    }
  }

  L.push('');
  L.push('════════ 진단 끝 ════════');
  L.push('위 내용을 전부 복사해서 보내주세요.');

  var out = L.join('\n');
  Logger.log(out);
  return out;
}
