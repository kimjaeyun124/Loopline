import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBrowserQaSummary, formatReadmeQaSummary } from '../public/harness-ui.js';

test('README QA summary omits records that do not contain a result', () => {
  assert.equal(formatReadmeQaSummary({}), '');
  assert.equal(formatReadmeQaSummary({ readmeQaHistory: [] }), '');
});

test('README QA summary marks an inapplicable smoke check without counting it as a pass', () => {
  const summary = formatReadmeQaSummary({
    readmeQaHistory: [{ applicable: false, skipped: true, passed: false }],
  });
  assert.match(summary, /미적용/);
  assert.match(summary, /통과로 집계하지 않음/);
  assert.doesNotMatch(summary, /QA: 통과/);
});

test('README QA summary reports a passed check count', () => {
  assert.equal(formatReadmeQaSummary({
    readmeQaHistory: [{ applicable: true, skipped: false, passed: true, round: 2, checks: [{}, {}] }],
  }), '\n\nREADME 실행 안내 QA: 통과 · 2회차 · 2개 기본 주소·자산 검사');
});

test('README QA summary distinguishes failures from applicable checks that were skipped', () => {
  assert.match(formatReadmeQaSummary({
    readmeQaHistory: [{ applicable: true, skipped: false, passed: false }],
  }), /QA: 실패/);
  assert.match(formatReadmeQaSummary({
    readmeQaHistory: [{ applicable: true, skipped: true, passed: false }],
  }), /검사 미완료 · 적용 대상이지만 실행되지 않음/);
});

test('browser QA summary describes the latest round after an earlier failure', () => {
  const summary = formatBrowserQaSummary({
    browserQaPassed: true,
    qaHistory: [
      { round: 1, passed: false, checks: [{ passed: false }] },
      { round: 3, passed: true, checks: [{ passed: true }, { passed: true }] },
    ],
  });
  assert.equal(summary, '\n\n독립 브라우저 QA: 통과 · 3회차 · 2개 검사');
});

test('browser QA summary reports failed check count and omits absent legacy metadata', () => {
  assert.equal(formatBrowserQaSummary({ qaHistory: [{
    round: 4, passed: false, checks: [{ passed: true }, { passed: false }, { passed: false }],
  }] }), '\n\n독립 브라우저 QA: 실패 · 4회차 · 2/3개 검사 실패');
  assert.equal(formatBrowserQaSummary({ qaHistory: [{ passed: true, checks: [{ passed: true }] }] }), '\n\n독립 브라우저 QA: 통과 · 1개 검사');
});

test('browser and README QA distinguish overall failures from individual check failures', () => {
  assert.equal(formatBrowserQaSummary({ qaHistory: [{
    round: 2, passed: false, checks: [{ passed: true }, { passed: true }], failures: ['브라우저 실행 종료 코드 오류'],
  }] }), '\n\n독립 브라우저 QA: 실패 · 2회차 · 추가 실패 근거 1개');
  assert.equal(formatReadmeQaSummary({ readmeQaHistory: [{
    applicable: true, skipped: false, round: 3, passed: false, checks: [{ passed: true }], failures: ['서버 종료 코드 오류'],
  }] }), '\n\nREADME 실행 안내 QA: 실패 · 3회차 · 추가 실패 근거 1개');
  assert.match(formatBrowserQaSummary({ qaHistory: [{ passed: false, checks: [{ passed: true }] }] }), /통과 근거 불충분/);
  assert.match(formatBrowserQaSummary({ qaHistory: [{ passed: false, checks: [] }] }), /검사 근거 없음/);
});
