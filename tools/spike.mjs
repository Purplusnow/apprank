// Phase 0 스파이크: GitHub Actions 러너 IP에서 스토어 차트 수집이 실제로 되는지 검증.
//
// 왜 필요한가: 로컬(가정용 KR IP)에서는 차단 신호 0건이었다. 하지만 Actions 러너는
// Azure 데이터센터 IP이고, 구글이 데이터센터 IP를 차단/스로틀할 가능성이 이 프로젝트의
// 유일한 킬러 리스크다. 규모를 올려가며 어디서 깨지는지 본다.
//
// 중요 — 판정 기준:
//   google-play-scraper는 "빈 차트"에도 파싱 에러를 던진다. 그리고 빈 차트는 흔하다:
//   러시아는 유료/매출 차트가 아예 없고(2022년 유료 판매 중단, Play 사이트에서 확인),
//   유료 차트는 원래 얇다(us/GAME_SPORTS/TOP_PAID = 6건, kr/GAME/TOP_PAID = 67건).
//   따라서 PARSE 에러는 실패가 아니라 "데이터 없음"으로 센다.
//   차단은 403/429/CAPTCHA/네트워크로 나타나고, 그건 TOP_FREE까지 같이 무너뜨린다.
//   → 진짜 신호는 **TOP_FREE 성공률 + 차단 코드 유무**다.

import gplay from 'google-play-scraper';

const g = gplay.default ?? gplay;

const COUNTRIES = ['kr','us','jp','tw','de','fr','gb','br','in','id','th','vn','ru','ca','au',
                   'es','it','mx','tr','ph','nl','se','pl','sa','ae','eg','za','ar','cl','co'];
const COLLECTIONS = [g.collection.TOP_FREE, g.collection.TOP_PAID, g.collection.GROSSING];
const CATS = ['GAME','GAME_ACTION','GAME_PUZZLE','GAME_CASUAL','GAME_STRATEGY',
              'GAME_ROLE_PLAYING','GAME_SIMULATION','GAME_SPORTS','GAME_ARCADE','GAME_BOARD'];

// 차단은 소량에서 안 걸리고 규모에서 발동한다. 단계적으로 올린다.
const STAGES = [
  { name: 'S1 소량', charts: 40 },
  { name: 'S2 중간', charts: 200 },
  { name: 'S3 대량', charts: 600 },
];
const CONC = Number(process.env.CONCURRENCY ?? 8);
const MAX_RETRY = 2;

const BLOCK_KINDS = ['BLOCKED_403', 'RATE_LIMIT_429', 'CAPTCHA', 'UNAVAILABLE_503'];

// 매트릭스를 펼친 뒤 고정 시드로 섞는다.
// 섞지 않으면 S1이 kr 한 국가만 보게 되어 대표성이 없다. 시드 고정으로 재현성은 유지.
function buildJobs() {
  const jobs = [];
  for (const country of COUNTRIES)
    for (const category of CATS)
      for (const collection of COLLECTIONS)
        jobs.push({ country, category, collection });
  let s = 20261010;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  return jobs;
}

function classify(err) {
  const m = (err?.message ?? String(err)).toLowerCase();
  if (m.includes('429') || m.includes('too many')) return 'RATE_LIMIT_429';
  if (m.includes('403') || m.includes('forbidden')) return 'BLOCKED_403';
  if (m.includes('503') || m.includes('unavailable')) return 'UNAVAILABLE_503';
  if (m.includes('captcha') || m.includes('unusual traffic')) return 'CAPTCHA';
  if (m.includes('timeout') || m.includes('etimedout') || m.includes('socket') ||
      m.includes('econnreset') || m.includes('fetch failed')) return 'NETWORK';
  // 라이브러리가 빈 차트에 던지는 파싱 에러 — 차단이 아니라 데이터 없음
  if (m.includes('fantasy-land') || m.includes('undefined')) return 'EMPTY_CHART';
  return 'OTHER';
}

async function runStage(stage, allJobs, offset) {
  const jobs = allJobs.slice(offset, offset + stage.charts);
  const st = {
    ok: 0, empty: 0, blocked: 0, other: 0, items: 0, retried: 0,
    kinds: {}, samples: [], latencies: [],
    free: { n: 0, ok: 0 },            // 차단 판정의 핵심 지표
    emptyBy: {},                      // "국가/차트종류"별 빈 차트 집계
  };
  let i = 0;

  async function worker() {
    for (;;) {
      const idx = i++;
      if (idx >= jobs.length) return;
      const j = jobs[idx];
      const isFree = j.collection === g.collection.TOP_FREE;
      if (isFree) st.free.n++;

      let lastErr = null;
      for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        if (attempt > 0) {
          st.retried++;
          await new Promise(r => setTimeout(r, 500 * 2 ** (attempt - 1)));
        }
        const t = Date.now();
        try {
          const r = await g.list({
            collection: j.collection, category: g.category[j.category],
            country: j.country, lang: 'en', num: 200,
          });
          st.ok++; st.items += r.length; st.latencies.push(Date.now() - t);
          if (isFree) st.free.ok++;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // 빈 차트는 재시도해도 계속 빈 차트다. 시간 낭비 금지.
          if (classify(e) === 'EMPTY_CHART') break;
        }
      }

      if (lastErr) {
        const kind = classify(lastErr);
        st.kinds[kind] = (st.kinds[kind] ?? 0) + 1;
        if (kind === 'EMPTY_CHART') {
          st.empty++;
          const key = `${j.country}/${j.collection}`;
          st.emptyBy[key] = (st.emptyBy[key] ?? 0) + 1;
        } else if (BLOCK_KINDS.includes(kind) || kind === 'NETWORK') {
          st.blocked++;
          if (st.samples.length < 5)
            st.samples.push(`${j.country}/${j.category}/${j.collection}: [${kind}] ${(lastErr.message ?? '').slice(0, 90)}`);
        } else {
          st.other++;
          if (st.samples.length < 5)
            st.samples.push(`${j.country}/${j.category}/${j.collection}: [${kind}] ${(lastErr.message ?? '').slice(0, 90)}`);
        }
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const secs = (Date.now() - t0) / 1000;
  const lat = st.latencies.sort((a, b) => a - b);
  return {
    ...stage, ...st, secs,
    rps: jobs.length / secs,
    dataRate: (100 * st.ok) / jobs.length,
    freeRate: st.free.n ? (100 * st.free.ok) / st.free.n : 0,
    p50: lat[Math.floor(lat.length * 0.5)] ?? 0,
    p95: lat[Math.floor(lat.length * 0.95)] ?? 0,
  };
}

async function appleProbe() {
  // 애플은 CORS가 열려 있어 최악의 경우 브라우저 직결이 가능하지만,
  // Actions에서 대량 수집할 거라면 여기서도 차단 여부를 봐야 한다.
  const targets = [];
  for (const c of COUNTRIES.slice(0, 12))
    for (const kind of ['topfreeapplications', 'topgrossingapplications'])
      targets.push({ c, kind });
  let ok = 0, fail = 0, entries = 0; const errs = [];
  const t0 = Date.now();
  for (const t of targets) {
    try {
      const res = await fetch(`https://itunes.apple.com/${t.c}/rss/${t.kind}/limit=100/genre=6014/json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const n = (await res.json())?.feed?.entry?.length ?? 0;
      if (n === 0) throw new Error('empty feed');
      ok++; entries += n;
    } catch (e) { fail++; if (errs.length < 3) errs.push(`${t.c}/${t.kind}: ${e.message}`); }
  }
  return { total: targets.length, ok, fail, entries, errs, secs: (Date.now() - t0) / 1000 };
}

// ---- 실행 ----
const egress = await fetch('https://ipinfo.io/json').then(r => r.json()).catch(() => ({}));

const lines = [];
const log = s => { console.log(s); lines.push(s); };

log(`## Phase 0 스파이크 결과\n`);
log(`- 러너 egress IP: \`${egress.ip ?? '?'}\` (${egress.org ?? '?'}, ${egress.country ?? '?'}/${egress.region ?? '?'})`);
log(`- 동시 요청 ${CONC}, 재시도 최대 ${MAX_RETRY}회`);
log(`- 판정 기준: **차단 코드(403/429/CAPTCHA/네트워크) 유무 + TOP_FREE 성공률**.`);
log(`  빈 차트는 실패가 아니다 — 러시아는 유료/매출 차트가 없고, 유료 차트는 원래 얇다.\n`);

const allJobs = buildJobs();
log(`### Google Play (매트릭스 ${allJobs.length}개 중 단계별 무작위 샘플)\n`);
log(`| 단계 | 요청 | 데이터 수신 | **TOP_FREE** | 빈 차트 | **차단** | 재시도율 | req/s | p50 | p95 |`);
log(`|---|---|---|---|---|---|---|---|---|---|`);

let offset = 0; const rows = [];
for (const stage of STAGES) {
  const r = await runStage(stage, allJobs, offset);
  offset += stage.charts;
  rows.push(r);
  log(`| ${r.name} | ${r.charts} | ${r.dataRate.toFixed(1)}% | **${r.freeRate.toFixed(1)}%** | ${r.empty} | **${r.blocked + r.other}** | ${(100 * r.retried / r.charts).toFixed(1)}% | ${r.rps.toFixed(1)} | ${r.p50}ms | ${r.p95}ms |`);
  for (const s of r.samples) console.log(`    ↳ ${s}`);
  if (r.freeRate < 80) { log(`\n> ${r.name}에서 TOP_FREE 성공률 80% 미만 → 이후 단계 중단`); break; }
}

// 빈 차트가 어디에 쏠렸는지 — 제품 스코프 판단에 쓰인다
const emptyAgg = {};
for (const r of rows) for (const [k, v] of Object.entries(r.emptyBy)) emptyAgg[k] = (emptyAgg[k] ?? 0) + v;
const topEmpty = Object.entries(emptyAgg).sort((a, b) => b[1] - a[1]).slice(0, 8);
if (topEmpty.length) {
  log(`\n빈 차트 분포 (국가/차트종류 상위): ${topEmpty.map(([k, v]) => `\`${k}\`×${v}`).join(', ')}`);
}

const ap = await appleProbe();
log(`\n### Apple (레거시 RSS, 순차 ${ap.total}요청)\n`);
log(`- 성공 ${ap.ok}/${ap.total}, 총 항목 ${ap.entries}, 소요 ${ap.secs.toFixed(1)}s`);
if (ap.errs.length) log(`- 에러: ${ap.errs.join(' / ')}`);

// ---- 판정 ----
const last = rows[rows.length - 1];
const totalBlocked = rows.reduce((a, r) => a + r.blocked + r.other, 0);
const playOk = last && last.freeRate >= 98 && totalBlocked === 0;

log(`\n### 판정\n`);
if (playOk) {
  const full = 49 * 54 * 3, rec = 49 * 20 * 3;
  log(`✅ **Play 수집 가능.** 차단 신호 0건, TOP_FREE ${last.freeRate.toFixed(1)}%.`);
  log(`- 전체 매트릭스(${full}차트) 추정: **${(full / last.rps / 60).toFixed(0)}분**`);
  log(`- 권장 범위(${rec}차트) 추정: **${(rec / last.rps / 60).toFixed(1)}분**`);
  log(`\n→ Phase 1(역색인 버킷 + Pages 배포) 진행. 수집기에 빈 차트 = \`[]\` 처리 필수.`);
} else if (last && totalBlocked > 0) {
  log(`❌ **차단 신호 ${totalBlocked}건.** 위 샘플의 에러 유형을 확인:`);
  log(`- 403/429/CAPTCHA → 데이터센터 IP 차단. Apify 종량제를 수집기로 끼우는 구조로 전환`);
  log(`- NETWORK만 → 일시적 가능성, 재실행으로 재현 여부 확인`);
  log(`\n→ Apple은 ${ap.ok >= ap.total * 0.95 ? '정상이므로 iOS 전용으로는 즉시 진행 가능' : '함께 실패 — 네트워크 전반 확인 필요'}.`);
} else {
  log(`⚠️ **판정 보류.** TOP_FREE ${last?.freeRate.toFixed(1)}% (기준 98%). 차단 코드는 없으나 데이터가 덜 들어왔다.`);
  log(`→ 재실행해서 재현되는지 확인 필요.`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
process.exit(playOk ? 0 : 1);
