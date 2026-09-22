'use strict';

const cents = value => Math.round((Number(value) || 0) * 100);
const money = value => Math.round(value) / 100;
const iso = value => value ? String(value).slice(0, 10) : '';

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('Monat muss YYYY-MM sein');
  const [year, mon] = month.split('-').map(Number);
  if (mon < 1 || mon > 12) throw new Error('Ungültiger Monat');
  const endDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(endDay).padStart(2, '0')}` };
}

function subscriptionIsActive(item, month) {
  const { start, end } = monthBounds(month);
  const begins = iso(item.start_date);
  const cancel = iso(item.cancel_date);
  const resume = iso(item.resume_date);
  if (begins && begins > end) return false;
  if (!cancel || cancel > end) return true;
  return !!resume && resume <= end;
}

function loanIsActive(item, month) {
  const { end } = monthBounds(month);
  return cents(item.balance) > 0 && cents(item.rate) > 0 && (!iso(item.start_date) || iso(item.start_date) <= end);
}

function loanChargeCents(item, month) {
  if (!loanIsActive(item, month)) return 0;
  return Math.min(cents(item.balance), cents(item.rate));
}

function applyRegularInstallment(item) {
  const balance = cents(item.balance);
  const rate = cents(item.rate);
  if (balance <= 0) throw new Error('Kredit ist bereits vollständig getilgt');
  if (rate <= 0) throw new Error('Kreditrate ist ungültig');
  const paid = Math.min(balance, rate);
  return { paid: money(paid), balance: money(balance - paid), paidMonths: (Number(item.paid_months) || 0) + 1 };
}

function subscriptionChargeCents(item, month) {
  if (!subscriptionIsActive(item, month)) return 0;
  const price = cents(item.price);
  return item.cycle === 'jährlich' ? Math.round(price / 12) : price;
}

function goalChargeCents(item, month) {
  if (!item.auto_save || cents(item.rate) <= 0 || cents(item.target) <= cents(item.saved)) return 0;
  const { start, end } = monthBounds(month);
  if (iso(item.start_date) && iso(item.start_date) > end) return 0;
  if (iso(item.target_date) && iso(item.target_date) < start) return 0;
  return cents(item.rate);
}

function getMonthlyFinancialObligations({ subscriptions = [], loans = [], goals = [], month }) {
  const subscriptionCents = subscriptions.reduce((sum, item) => sum + subscriptionChargeCents(item, month), 0);
  const loanCents = loans.reduce((sum, item) => sum + loanChargeCents(item, month), 0);
  const savingsCents = goals.reduce((sum, item) => sum + goalChargeCents(item, month), 0);
  return {
    month,
    subscriptions: money(subscriptionCents),
    loans: money(loanCents),
    savings: money(savingsCents),
    total: money(subscriptionCents + loanCents + savingsCents)
  };
}

function getCurrentMonthExpenses({ transactions = [], month }) {
  // Gebuchte Transaktionen sind die einzige Quelle für tatsächliche Ausgaben.
  // Kredit- und Vertragsstammdaten werden hier nie nochmals addiert.
  const spentCents = transactions
    .filter(t => iso(t.date).slice(0, 7) === month && cents(t.amount) < 0)
    .reduce((sum, t) => sum - cents(t.amount), 0);
  return money(spentCents);
}

module.exports = { cents, monthBounds, loanChargeCents, applyRegularInstallment, getMonthlyFinancialObligations, getCurrentMonthExpenses };
