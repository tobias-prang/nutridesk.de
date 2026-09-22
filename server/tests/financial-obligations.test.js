'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRegularInstallment, getMonthlyFinancialObligations, getCurrentMonthExpenses } = require('../lib/financial-obligations');

const month = '2026-09';
const loans = [8.50, 90.50, 22.01, 146.39, 27.12, 79.89].map((rate, id) => ({ id, balance: 1000, rate }));

test('sechs aktive Kredite ergeben centgenau 374,41 Euro', () => {
  assert.equal(getMonthlyFinancialObligations({ loans, month }).loans, 374.41);
});

test('vollständig getilgter Kredit fällt aus der Belastung', () => {
  const paid = loans.map((l, i) => i === 0 ? { ...l, balance: 0 } : l);
  assert.equal(getMonthlyFinancialObligations({ loans: paid, month }).loans, 365.91);
});

test('Schlussrate ist höchstens die Restschuld', () => {
  assert.equal(getMonthlyFinancialObligations({ loans: [{ balance: 10, rate: 30 }], month }).loans, 10);
});

test('zukünftiger Kredit zählt erst ab Startmonat', () => {
  const future = [{ balance: 100, rate: 20, start_date: '2026-10-01' }];
  assert.equal(getMonthlyFinancialObligations({ loans: future, month }).loans, 0);
  assert.equal(getMonthlyFinancialObligations({ loans: future, month: '2026-10' }).loans, 20);
});

test('gebuchte Kreditrate wird in tatsächlichen Ausgaben genau einmal gezählt', () => {
  const transactions = [{ date: '2026-09-19', amount: -146.39, tag: 'Kreditrate', loan_id: 7 }];
  assert.equal(getCurrentMonthExpenses({ transactions, loans: [{ id: 7, balance: 3366.97, rate: 146.39 }], month }), 146.39);
});

test('Verträge und Kredite ergeben die reguläre Monatsbelastung', () => {
  const subscriptions = [{ price: 25, cycle: 'monatlich' }];
  assert.deepEqual(getMonthlyFinancialObligations({ subscriptions, loans, month }), { month, subscriptions: 25, loans: 374.41, savings: 0, total: 399.41 });
});

test('automatisches Sparziel zählt nur im aktiven Zeitraum und bis zum Ziel', () => {
  const goals = [{ auto_save: 1, saved: 0, target: 500, rate: 50, start_date: '2026-09-10', target_date: '2026-12-31' }];
  assert.equal(getMonthlyFinancialObligations({ goals, month: '2026-08' }).savings, 0);
  assert.equal(getMonthlyFinancialObligations({ goals, month: '2026-09' }).savings, 50);
  assert.equal(getMonthlyFinancialObligations({ goals, month: '2027-01' }).savings, 0);
});

test('+1 Rate reduziert Restschuld und erhöht den Ratenzähler', () => {
  assert.deepEqual(applyRegularInstallment({ balance: 3366.97, rate: 146.39, paid_months: 1 }), { paid: 146.39, balance: 3220.58, paidMonths: 2 });
});

test('+1 Rate verwendet bei der letzten Rate nur die Restschuld', () => {
  assert.deepEqual(applyRegularInstallment({ balance: 10, rate: 30, paid_months: 4 }), { paid: 10, balance: 0, paidMonths: 5 });
});
