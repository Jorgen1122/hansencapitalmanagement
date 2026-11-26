// =====================================================================
// Sales (portal): invoices, estimates, payments received, who owes you,
// recurring invoices, products & services. Same records HCM works in the
// Workspace; every write goes through the database's sales_* functions,
// which post to the books. Needs dashboard.js (supabaseClient, currentClient,
// STAFF_VIEW, el, money, fmtDate). DOM methods and textContent only.
// =====================================================================
(function () {
'use strict';
const S = { data: null, view: 'invoices', open: null, form: null, busy: false };
const $ = (id) => document.getElementById(id);
const usd = (n) => money(n, { cents: true });
const day = (d) => (d ? fmtDate(d + (String(d).length === 10 ? 'T00:00:00Z' : ''), { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const addDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const num = (s) => { const v = parseFloat(String(s == null ? '' : s).replace(/[$,\s]/g, '')); return Number.isFinite(v) ? v : NaN; };
const r2 = (v) => Math.round(v * 100) / 100;
const bal = (d) => r2(Number(d.total) - Number(d.amount_paid));
const TERMS = [['due_on_receipt', 'Due on receipt'], ['net_7', 'Net 7'], ['net_10', 'Net 10'], ['net_15', 'Net 15'], ['net_30', 'Net 30'], ['net_45', 'Net 45'], ['net_60', 'Net 60']];
const TERMS_LABEL = Object.fromEntries(TERMS);
const termsDays = (t) => ({ net_7: 7, net_10: 10, net_15: 15, net_30: 30, net_45: 45, net_60: 60 })[t] || 0;
const METHODS = [['check', 'Check'], ['cash', 'Cash'], ['zelle', 'Zelle'], ['venmo', 'Venmo'], ['ach', 'ACH / bank transfer'], ['card', 'Card (other processor)'], ['bank_transfer', 'Wire'], ['other', 'Other']];
const METHOD_LABEL = Object.fromEntries([...METHODS, ['stripe', 'Online (Stripe)']]);
const FREQS = [['weekly', 'Weekly'], ['every_2_weeks', 'Every 2 weeks'], ['every_4_weeks', 'Every 4 weeks'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
const FREQ_LABEL = Object.fromEntries(FREQS);
const STATUS = { draft: ['muted', 'Draft'], open: ['open', 'Unpaid'], partial: ['open', 'Partly paid'], paid: ['paid', 'Paid'], void: ['muted', 'Void'],
  sent: ['open', 'Sent'], accepted: ['paid', 'Accepted'], declined: ['overdue', 'Declined'], expired: ['muted', 'Expired'], converted: ['paid', 'Invoiced'] };
const overdue = (d) => (d.status === 'open' || d.status === 'partial') && d.due_date && d.due_date < todayISO();
const must = (r) => { if (r.error) throw r.error; return r.data; };
const errText = (e) => {
  const m = (e && e.message) || '';
  if (/failed to fetch|network/i.test(m)) return 'Could not reach the server. Check your connection.';
  if (/not allowed/i.test(m)) return 'You don’t have access to do that.';
  return m || 'Something went wrong. Try again.';
};
const rateOf = (loc) => (loc ? (Number(loc.rate) >= 1 ? Number(loc.rate) / 100 : Number(loc.rate)) : 0);
const pctTxt2 = (r) => (r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';

function badge(d) {
  if (overdue(d)) return el('span', 'badge overdue', 'Overdue');
  const [tone, label] = STATUS[d.status] || ['muted', d.status];
  return el('span', 'badge ' + tone, label);
}
function btn(text, cls, onClick, title) { const b = el('button', cls || 'btn-plain btn-sm-plain', text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', onClick); return b; }
function field(label, input, cls) { const l = el('label', cls || ''); l.append(document.createTextNode(label), input); return l; }
function input(type, value, attrs) { const i = el('input'); i.type = type; if (value != null) i.value = value; Object.assign(i, attrs || {}); return i; }
function select(options, value, attrs) {
  const s = el('select'); Object.assign(s, attrs || {});
  options.forEach(([v, l]) => { const o = el('option', null, l); o.value = v; s.appendChild(o); });
  s.value = value == null ? '' : value; return s;
}
function msg(text, ok) { const m = $('sl-msg'); m.textContent = text || ''; m.className = 'form-alert' + (text ? (ok ? ' success' : ' error') : ''); }
function twice(b, label, fn) {
  if (b.dataset.armed) { fn(); return; }
  const orig = b.textContent; b.dataset.armed = '1'; b.textContent = label;
  setTimeout(() => { delete b.dataset.armed; b.textContent = orig; }, 4000);
}
async function run(fn, done) {
  if (S.busy) return false;
  S.busy = true; msg('');
  try { await fn(); await load(); if (done) msg(done, true); return true; } catch (e) { msg(errText(e)); return false; } finally { S.busy = false; }
}

// ---------- data ----------
async function load() {
  const c = currentClient.id;
  const settings = must(await supabaseClient.rpc('sales_settings_get', { p_client: c }));
  const [cu, it, dc, pm, rc, tl, jb] = await Promise.all([
    supabaseClient.from('client_customers').select('id, name, company, email, cc_emails, phone, address, terms, active').eq('client_id', c).order('name'),
    supabaseClient.from('sales_items').select('*').eq('client_id', c).order('name'),
    supabaseClient.from('sales_docs').select('*').eq('client_id', c).order('issue_date', { ascending: false }).order('number', { ascending: false }).limit(2000),
    supabaseClient.from('sales_payments').select('*, sales_payment_apps(doc_id, amount)').eq('client_id', c).order('payment_date', { ascending: false }).limit(2000),
    supabaseClient.from('sales_recurring').select('*').eq('client_id', c).order('next_date'),
    supabaseClient.from('sales_tax_locations').select('id, name, rate').eq('client_id', c).order('name'),
    supabaseClient.from('jobs').select('id, name, customer_id, start_date').eq('client_id', c).order('start_date', { ascending: false }).limit(300),
  ]);
  S.data = { settings, customers: must(cu) || [], items: must(it) || [], docs: must(dc) || [], payments: must(pm) || [], recurring: must(rc) || [], taxLocs: must(tl) || [], jobs: must(jb) || [] };
  render();
}
const custName = (id) => (S.data.customers.find((c) => c.id === id) || {}).name || '—';

// ---------- shell ----------
function render() {
  const d = S.data; if (!d) return;
  const inv = d.docs.filter((x) => x.kind === 'invoice');
  const open = inv.filter((x) => x.status === 'open' || x.status === 'partial');
  const od = open.filter(overdue);
  const since = addDays(todayISO(), -30);
  const got = d.payments.filter((p) => p.payment_date >= since && p.status !== 'failed').reduce((s, p) => s + Number(p.amount), 0);
  statCards('sl-stats', [
    ['Unpaid invoices', usd(open.reduce((s, x) => s + bal(x), 0)), `${open.length} open`],
    ['Overdue', usd(od.reduce((s, x) => s + bal(x), 0)), od.length ? `${od.length} past due` : 'Nothing overdue'],
    ['Received, last 30 days', usd(got), `${d.payments.filter((p) => p.payment_date >= since).length} payments`],
  ]);
  document.querySelectorAll('[data-sales]').forEach((b) => b.classList.toggle('active', b.dataset.sales === S.view));
  const body = $('sl-body'); body.textContent = '';
  if (S.form) body.appendChild(S.form.kind === 'payment' ? paymentForm(S.form) : S.form.kind === 'recurring' ? recurringForm(S.form) : S.form.kind === 'item' ? itemForm(S.form) : docForm(S.form));
  else if (S.open) { const doc = d.docs.find((x) => x.id === S.open); if (doc) body.appendChild(docView(doc)); else S.open = null; }
  const list = { invoices: () => docList('invoice'), estimates: () => docList('estimate'), payments: paymentList, owed: agingView, recurring: recurringList, items: itemList, settings: settingsView }[S.view];
  body.appendChild(list());
}

// ---------- lists ----------
function table(headers, rows) {
  const wrap = el('div', 'table-scroll'); const t = el('table', 'fin-table led-table sl-table');
  const th = el('thead'); const tr = el('tr');
  headers.forEach((h) => { const c = el('th', /^(Total|Balance|Amount|Rate|Fee|Current|1–30|31–60|61–90|Over 90)$/.test(h) ? 'r' : '', h); tr.appendChild(c); });
  th.appendChild(tr); t.appendChild(th);
  const tb = el('tbody'); rows.forEach((r) => tb.appendChild(r)); t.appendChild(tb); wrap.appendChild(t); return wrap;
}
function td(text, cls) { return el('td', cls || '', text); }
function empty(text) { return el('p', 'empty-note panel-empty', text); }

function docList(kind) {
  const box = el('div', 'sl-section');
  const docs = S.data.docs.filter((x) => x.kind === kind);
  const bar = el('div', 'sl-filter');
  const filters = kind === 'invoice' ? [['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['draft', 'Drafts'], ['all', 'All']] : [['all', 'All'], ['draft', 'Drafts'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['converted', 'Invoiced']];
  if (!S.filter || !filters.some(([v]) => v === S.filter)) S.filter = filters[0][0];
  const f = select(filters, S.filter, { 'aria-label': 'Filter' }); f.addEventListener('change', () => { S.filter = f.value; render(); });
  const q = input('search', S.q || '', { placeholder: 'Search number or customer', 'aria-label': 'Search' });
  q.addEventListener('input', () => { S.q = q.value; const pos = q.selectionStart; render(); const nq = document.querySelector('.sl-filter input'); if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); } });
  bar.append(f, q); box.appendChild(bar);
  const rows = docs.filter((x) => (S.filter === 'all' || (S.filter === 'unpaid' ? ['open', 'partial'].includes(x.status) : S.filter === 'overdue' ? overdue(x) : x.status === S.filter))
    && (!S.q || `${x.number} ${custName(x.customer_id)}`.toLowerCase().includes(S.q.toLowerCase())));
  if (!rows.length) { box.appendChild(empty(docs.length ? 'Nothing matches.' : kind === 'invoice' ? 'No invoices yet. Create one with “+ Invoice”.' : 'No estimates yet.')); return box; }
  box.appendChild(table(['Number', 'Date', 'Customer', kind === 'invoice' ? 'Due' : 'Status', 'Total', kind === 'invoice' ? 'Balance' : '', kind === 'invoice' ? 'Status' : ''], rows.map((x) => {
    const tr = el('tr', x.status === 'void' ? 'row-dim' : '');
    const a = btn(x.number, 'link-btn', () => { S.open = x.id; S.form = null; render(); window.scrollTo({ top: $('sl-body').offsetTop - 90, behavior: 'smooth' }); });
    const c1 = el('td'); c1.appendChild(a);
    tr.append(c1, td(day(x.issue_date)), td(custName(x.customer_id)));
    if (kind === 'invoice') {
      const due = td(day(x.due_date)); if (overdue(x)) due.className = 'neg'; tr.appendChild(due);
      tr.append(td(usd(x.total), 'r'), td(['draft', 'void'].includes(x.status) ? '—' : usd(bal(x)), 'r'));
      const s = el('td'); s.appendChild(badge(x)); tr.appendChild(s);
    } else { const s = el('td'); s.appendChild(badge(x)); tr.append(s, td(usd(x.total), 'r'), td(''), td('')); }
    return tr;
  })));
  return box;
}

function paymentList() {
  const box = el('div', 'sl-section');
  if (!S.data.payments.length) { box.appendChild(empty('No payments recorded yet. Use “+ Payment” when a customer pays by check, cash, Zelle or Venmo.')); return box; }
  const num2 = (id) => (S.data.docs.find((d) => d.id === id) || {}).number || '—';
  box.appendChild(table(['Date', 'Customer', 'Method', 'Invoices', 'Amount', ''], S.data.payments.map((p) => {
    const tr = el('tr', ['failed', 'refunded'].includes(p.status) ? 'row-dim' : '');
    const inv = el('td', '', (p.sales_payment_apps || []).map((a) => num2(a.doc_id)).join(', '));
    const act = el('td', 'r');
    if (!STAFF_VIEW && p.method !== 'stripe') {
      const b = btn('Delete', 'led-btn danger', () => twice(b, 'Click again', () => run(async () => must(await supabaseClient.rpc('sales_payment_delete', { p_payment: p.id })), 'Payment deleted. The invoice is open again.')));
      act.appendChild(b);
    }
    tr.append(td(day(p.payment_date)), td(custName(p.customer_id)), td(`${METHOD_LABEL[p.method] || p.method}${p.reference ? ' ' + p.reference : ''}${p.status === 'pending' ? ' · pending' : ''}`), inv, td(usd(p.amount), 'r'), act);
    return tr;
  })));
  return box;
}

function agingView() {
  const box = el('div', 'sl-section');
  const note = el('p', 'panel-note', 'Who owes you, by how late. “Current” is not due yet.'); box.appendChild(note);
  const holder = el('div'); holder.appendChild(empty('Loading…')); box.appendChild(holder);
  supabaseClient.rpc('sales_ar_aging', { p_client: currentClient.id, p_as_of: todayISO() }).then(({ data, error }) => {
    holder.textContent = '';
    if (error) { holder.appendChild(empty(errText(error))); return; }
    if (!data || !data.length) { holder.appendChild(empty('No one owes you anything right now.')); return; }
    const rows = data.map((a) => { const tr = el('tr'); tr.append(td(a.customer), td(usd(a.current_due || 0), 'r'), td(usd(a.d1_30 || 0), 'r'), td(usd(a.d31_60 || 0), 'r'), td(usd(a.d61_90 || 0), 'r'), td(usd(a.over_90 || 0), 'r' + (Number(a.over_90) ? ' neg' : '')), td(usd(a.total), 'r')); return tr; });
    const sum = (k) => data.reduce((s, a) => s + Number(a[k] || 0), 0);
    const tot = el('tr', 'total-row'); tot.append(td('Total'), td(usd(sum('current_due')), 'r'), td(usd(sum('d1_30')), 'r'), td(usd(sum('d31_60')), 'r'), td(usd(sum('d61_90')), 'r'), td(usd(sum('over_90')), 'r'), td(usd(sum('total')), 'r'));
    rows.push(tot);
    holder.appendChild(table(['Customer', 'Current', '1–30', '31–60', '61–90', 'Over 90', 'Total'], rows));
  });
  return box;
}

function recurringList() {
  const box = el('div', 'sl-section');
  if (!S.data.recurring.length) { box.appendChild(empty('No recurring invoices. Set one up for a regular customer and it’s created automatically on schedule.')); return box; }
  box.appendChild(table(['Customer', 'Name', 'How often', 'Next', 'Amount', ''], S.data.recurring.map((r) => {
    const tr = el('tr', r.active ? '' : 'row-dim');
    const amt = (r.lines || []).reduce((s, l) => s + r2(Number(l.qty == null ? 1 : l.qty) * Number(l.rate || 0)), 0);
    const act = el('td', 'r');
    if (!STAFF_VIEW) {
      act.append(btn('Edit', 'led-btn', () => { S.form = recurringDraft(r); render(); }),
        btn('Make next now', 'led-btn', () => run(async () => { const id = must(await supabaseClient.rpc('sales_recurring_run_now', { p_id: r.id })); S.view = 'invoices'; S.open = id; }, 'Invoice created. The schedule moved to the next date.')));
      const del = btn('Delete', 'led-btn danger', () => twice(del, 'Click again', () => run(async () => must(await supabaseClient.rpc('sales_recurring_delete', { p_id: r.id })), 'Recurring invoice deleted. Invoices already made stay.')));
      act.appendChild(del);
    }
    tr.append(td(custName(r.customer_id)), td(r.name || '—'), td(FREQ_LABEL[r.frequency] + (r.end_date ? ` until ${day(r.end_date)}` : '')), td(r.active ? day(r.next_date) : 'Paused'), td(usd(amt), 'r'), act);
    return tr;
  })));
  return box;
}

function itemList() {
  const box = el('div', 'sl-section');
  if (!STAFF_VIEW) { const bar = el('div', 'sl-filter'); bar.appendChild(btn('+ Product or service', 'btn btn-sm', () => { S.form = itemDraft(); render(); })); box.appendChild(bar); }
  if (!S.data.items.length) { box.appendChild(empty('Add what you sell. Picking one on an invoice fills in the description, price and tax.')); return box; }
  box.appendChild(table(['Name', 'Description', 'Rate', 'Tax', ''], S.data.items.map((i) => {
    const tr = el('tr', i.active ? '' : 'row-dim'); const act = el('td', 'r');
    if (!STAFF_VIEW) {
      act.appendChild(btn('Edit', 'led-btn', () => { S.form = itemDraft(i); render(); }));
      const del = btn('Delete', 'led-btn danger', () => twice(del, 'Click again', () => run(async () => must(await supabaseClient.from('sales_items').delete().eq('id', i.id)), 'Deleted. Invoices that used it keep their lines.')));
      act.appendChild(del);
    }
    tr.append(td(i.name), td(i.description && i.description !== i.name ? i.description : ''), td(i.rate == null ? '—' : usd(i.rate) + (i.unit ? ' / ' + i.unit : ''), 'r'), td(i.taxable ? 'Taxable' : ''), act);
    return tr;
  })));
  return box;
}

function settingsView() {
  const s = S.data.settings; const box = el('div', 'sl-section');
  const f = el('form', 'led-form sl-form'); f.noValidate = true;
  const g = el('div', 'led-grid');
  const reply = input('email', s.reply_email || '', { maxLength: 254 });
  const terms = select(TERMS, s.default_terms);
  const msgIn = el('textarea'); msgIn.rows = 2; msgIn.maxLength = 1000; msgIn.value = s.invoice_message || '';
  const foot = el('textarea'); foot.rows = 2; foot.maxLength = 1000; foot.value = s.footer || '';
  g.append(field('Reply-to email on invoices', reply), field('Default terms', terms),
    field('Message on every invoice', msgIn, 'span-2'), field('Footer (address, license #, how to pay by check)', foot, 'span-2'));
  f.appendChild(g);
  const p = el('p', 'led-sub', `Invoices are numbered ${s.invoice_prefix}${s.next_invoice_no} next. Online payment: ${s.stripe_status === 'enabled' ? 'connected' : 'coming soon. You’ll connect your own Stripe account here so customers can pay by card or bank.'}`);
  f.appendChild(p);
  if (!STAFF_VIEW) {
    const a = el('div', 'led-actions'); const save = el('button', 'btn btn-sm', 'Save settings'); save.type = 'submit'; a.appendChild(save); f.appendChild(a);
    f.addEventListener('submit', (e) => { e.preventDefault(); run(async () => must(await supabaseClient.rpc('sales_settings_save', { p_client: currentClient.id, p: { reply_email: reply.value, default_terms: terms.value, invoice_message: msgIn.value, footer: foot.value } })), 'Settings saved.'); });
  } else f.querySelectorAll('input, select, textarea').forEach((x) => { x.disabled = true; });
  box.appendChild(f); return box;
}

// ---------- one invoice / estimate ----------
function docView(d) {
  const inv = d.kind === 'invoice';
  const panel = el('div', 'sl-doc');
  const head = el('div', 'sl-doc-head');
  const h = el('h3', 'sl-doc-title', `${inv ? 'Invoice' : 'Estimate'} ${d.number} `); h.appendChild(badge(d));
  const acts = el('div', 'led-actions');
  const linesBox = el('div'); linesBox.appendChild(empty('Loading…'));
  let lines = null;
  if (!STAFF_VIEW) {
    if (d.status === 'draft') acts.appendChild(btn(inv ? 'Finalize' : 'Mark sent', 'btn btn-sm', () => run(async () => must(await supabaseClient.rpc('sales_doc_finalize', { p_doc: d.id })), inv ? `${d.number} is final and on your books.` : `${d.number} marked sent.`), inv ? 'Locks in the number and adds it to your books' : ''));
    if (inv && ['open', 'partial'].includes(d.status)) acts.appendChild(btn('Record payment', 'btn btn-sm', () => { S.form = paymentDraft(d.customer_id, d); S.open = null; render(); }));
    if (!inv && ['draft', 'sent', 'accepted', 'expired'].includes(d.status)) acts.appendChild(btn('Turn into invoice', 'btn btn-sm', () => run(async () => { S.open = must(await supabaseClient.rpc('sales_estimate_to_invoice', { p_doc: d.id })); S.view = 'invoices'; }, 'Draft invoice created from the estimate.')));
    if (!['void', 'converted', 'paid'].includes(d.status)) acts.appendChild(btn('Edit', 'led-btn', async () => { const ls = lines || await loadLines(d.id); S.form = docDraft(d.kind, d, ls); S.open = null; render(); }));
  }
  if (!STAFF_VIEW && !['void', 'converted'].includes(d.status)) {
    acts.appendChild(btn(d.status === 'draft' ? 'Finalize & email' : d.sent_at ? 'Email again' : 'Email to customer', 'btn btn-sm', () => {
      if (panel.querySelector('.sl-mail')) return;
      panel.insertBefore(mailForm(d), panel.children[1]);
    }));
  }
  acts.appendChild(btn('Print / PDF', 'led-btn', () => { if (lines) printDoc(d, lines); }));
  if (!STAFF_VIEW && !['draft', 'void'].includes(d.status)) {
    acts.appendChild(btn('Copy customer link', 'led-btn', async () => {
      try { const t = must(await supabaseClient.rpc('sales_doc_share_link', { p_doc: d.id })); const url = `${location.origin}/invoice.html?t=${t}`;
        try { await navigator.clipboard.writeText(url); msg('Customer link copied. Paste it in a text or email. (It replaces any link sent before.)', true); } catch { msg('Customer link: ' + url, true); } }
      catch (e) { msg(errText(e)); }
    }, 'A page your customer opens without logging in'));
    acts.appendChild(btn('Mark sent', 'led-btn', () => run(async () => must(await supabaseClient.rpc('sales_doc_mark_sent', { p_doc: d.id })), 'Marked as sent.')));
  }
  acts.appendChild(btn('Close', 'led-btn', () => { S.open = null; render(); }));
  head.append(h, acts); panel.appendChild(head);
  const meta = el('dl', 'sl-meta');
  const add = (k, v, cls) => { meta.append(el('dt', '', k), el('dd', cls || '', v)); };
  add('Customer', custName(d.customer_id)); add('Date', day(d.issue_date));
  if (inv) add('Terms · due', `${TERMS_LABEL[d.terms] || d.terms} · ${day(d.due_date)}`, overdue(d) ? 'neg' : '');
  if (d.job_id) add('Job', (S.data.jobs.find((j) => j.id === d.job_id) || {}).name || '—');
  if (d.sent_at) add('Sent', day(d.sent_at.slice(0, 10)) + (d.viewed_at ? ` · customer viewed ${day(d.viewed_at.slice(0, 10))}` : ''));
  panel.append(meta, linesBox);
  loadLines(d.id).then((ls) => {
    lines = ls; linesBox.textContent = '';
    const rows = ls.map((l) => { const tr = el('tr'); tr.append(td(l.description + (l.service_date ? ` (${day(l.service_date)})` : '')), td(String(Number(l.qty)), 'r'), td(usd(l.rate), 'r'), td(usd(l.amount) + (l.taxable && Number(d.tax_rate) > 0 ? ' T' : ''), 'r')); return tr; });
    const tot = (label, v, strong) => { const tr = el('tr', strong ? 'total-row' : ''); tr.append(td(''), td(''), td(label, 'r'), td(v, 'r')); return tr; };
    rows.push(tot('Subtotal', usd(d.subtotal)));
    if (Number(d.tax_total)) rows.push(tot(`Sales tax ${pctTxt2(Number(d.tax_rate))}`, usd(d.tax_total)));
    rows.push(tot('Total', usd(d.total), true));
    if (inv && Number(d.amount_paid)) rows.push(tot('Paid', '(' + usd(d.amount_paid) + ')'));
    if (inv && !['draft', 'void'].includes(d.status)) rows.push(tot('Balance due', usd(bal(d)), true));
    linesBox.appendChild(table(['Description', 'Qty', 'Rate', 'Amount'], rows));
    if (d.message) linesBox.appendChild(el('p', 'panel-note', 'Message: ' + d.message));
  }).catch(() => { linesBox.textContent = ''; linesBox.appendChild(empty('Could not load the lines.')); });
  // danger zone
  if (!STAFF_VIEW) {
    const z = el('div', 'led-actions sl-danger');
    const paid = S.data.payments.some((p) => (p.sales_payment_apps || []).some((a) => a.doc_id === d.id));
    if (inv && ['open', 'partial'].includes(d.status) && !paid) { const b = btn('Void', 'led-btn danger', () => twice(b, 'Click again to void', () => run(async () => must(await supabaseClient.rpc('sales_doc_void', { p_doc: d.id })), `${d.number} voided and taken off your books.`))); z.appendChild(b); }
    if (!inv || ['draft', 'void'].includes(d.status)) { const b = btn('Delete', 'led-btn danger', () => twice(b, 'Click again to delete for good', () => run(async () => { must(await supabaseClient.rpc('sales_doc_delete', { p_doc: d.id })); S.open = null; }, `${d.number} deleted.`))); z.appendChild(b); }
    if (!inv && ['sent', 'draft'].includes(d.status)) {
      z.append(btn('Customer accepted', 'led-btn', () => run(async () => must(await supabaseClient.rpc('sales_estimate_status', { p_doc: d.id, p_status: 'accepted' })), 'Marked accepted.')),
        btn('Customer declined', 'led-btn', () => run(async () => must(await supabaseClient.rpc('sales_estimate_status', { p_doc: d.id, p_status: 'declined' })), 'Marked declined.')));
    }
    if (paid && inv && d.status !== 'void') z.appendChild(el('span', 'led-sub', 'To void it, delete its payments first (Payments).'));
    if (z.childNodes.length) panel.appendChild(z);
  }
  return panel;
}
function mailForm(d) {
  const c = S.data.customers.find((x) => x.id === d.customer_id) || {};
  const f = el('form', 'led-form sl-mail'); f.noValidate = true;
  const g = el('div', 'led-grid');
  const to = input('email', c.email || '', { maxLength: 254 }); const cc = input('text', c.cc_emails || '', { maxLength: 600, placeholder: 'Optional, comma separated' });
  g.append(field('Send to', to, 'span-2'), field('CC', cc, 'span-2'));
  const note = el('p', 'led-sub', `It comes from HCM’s mailbox as “${currentClient.business_name} via HCM”, and replies go to ${S.data.settings.reply_email || 'your email'} (Sales → Settings).${d.status === 'draft' ? ' The draft is finalized and added to your books first.' : ''} Each email has a fresh link; older links stop working.`);
  const err = el('div', 'form-alert'); const a = el('div', 'led-actions');
  const send = el('button', 'btn btn-sm', 'Send email'); send.type = 'submit';
  a.append(send, btn('Cancel', 'btn-plain btn-sm-plain', () => f.remove()));
  f.append(g, note, a, err);
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; err.className = 'form-alert';
    if (!to.value.trim()) { err.textContent = 'Enter your customer’s email address.'; err.className = 'form-alert error'; return; }
    send.disabled = true; send.textContent = 'Sending…';
    try {
      const { data, error } = await supabaseClient.functions.invoke('sales-send', { body: { action: 'send', doc_id: d.id, to: to.value.trim(), cc: cc.value.trim() || null } });
      if (error) { let m = error.message; try { const j = await error.context.json(); if (j && j.error) m = j.error; } catch (x) { /* keep */ } throw new Error(m); }
      if (data && data.error) throw new Error(data.error);
      await run(async () => undefined, `Emailed ${data.number} to ${data.to}.`);
    } catch (x) { err.textContent = errText(x); err.className = 'form-alert error'; send.disabled = false; send.textContent = 'Send email'; }
  });
  setTimeout(() => to.focus(), 0);
  return f;
}
async function loadLines(id) { return must(await supabaseClient.from('sales_doc_lines').select('*').eq('doc_id', id).order('line_no')) || []; }

// ---------- forms ----------
function lineDraft(l) { return { item_id: (l && l.item_id) || '', description: (l && l.description) || '', service_date: (l && l.service_date) || '', qty: l && l.qty != null ? String(Number(l.qty)) : '1', rate: l && l.rate != null ? String(l.rate) : '', taxable: !!(l && l.taxable), income_account_id: (l && l.income_account_id) || null, job_id: (l && l.job_id) || null }; }
function docDraft(kind, d, lines) {
  const s = S.data.settings; const t = todayISO();
  if (d) return { kind, id: d.id, status: d.status, customer_id: d.customer_id, job_id: d.job_id || '', issue_date: d.issue_date, terms: d.terms, due_date: d.due_date || '', tax_location_id: d.tax_location_id || '', message: d.message || '', lines: lines.map(lineDraft) };
  return { kind, status: 'draft', customer_id: '', job_id: '', issue_date: t, terms: kind === 'invoice' ? s.default_terms : 'due_on_receipt', due_date: addDays(t, termsDays(kind === 'invoice' ? s.default_terms : '')), tax_location_id: null, message: kind === 'invoice' ? (s.invoice_message || '') : '', lines: [lineDraft()] };
}
function linesEditor(f, rate, onTotals) {
  const wrap = el('div', 'span-all sl-lines');
  const t = el('table', 'fin-table sl-line-table'); const th = el('thead'); const hr = el('tr');
  ['Product / service', 'Description', 'Qty', 'Rate', 'Amount', 'Tax', ''].forEach((h, i) => hr.appendChild(el('th', [2, 3, 4].includes(i) ? 'r' : '', h)));
  th.appendChild(hr); t.appendChild(th); const tb = el('tbody'); t.appendChild(tb);
  const foot = el('div', 'sl-totals');
  const totals = () => {
    const sub = f.lines.reduce((s, l) => s + r2((num(l.qty) || 0) * (num(l.rate) || 0)), 0);
    const tx = r2(f.lines.filter((l) => l.taxable).reduce((s, l) => s + r2((num(l.qty) || 0) * (num(l.rate) || 0)), 0) * rate());
    foot.textContent = `Subtotal ${usd(sub)}${tx ? ` · Sales tax ${usd(tx)}` : ''} · Total ${usd(sub + tx)}`;
    if (onTotals) onTotals(sub, tx);
  };
  const draw = () => {
    tb.textContent = '';
    f.lines.forEach((l, i) => {
      const tr = el('tr');
      const it = select([['', '—'], ...S.data.items.filter((x) => x.active || x.id === l.item_id).map((x) => [x.id, x.name])], l.item_id, { 'aria-label': 'Product or service' });
      const desc = input('text', l.description, { maxLength: 1000, 'aria-label': 'Description' });
      const qty = input('text', l.qty, { inputMode: 'decimal', className: 'num', 'aria-label': 'Quantity' });
      const rt = input('text', l.rate, { inputMode: 'decimal', className: 'num', 'aria-label': 'Rate' });
      const amt = td(usd(r2((num(l.qty) || 0) * (num(l.rate) || 0))), 'r');
      const tax = input('checkbox', null, { checked: l.taxable, 'aria-label': 'Taxable' });
      const rm = btn('✕', 'led-btn', () => { f.lines.splice(i, 1); if (!f.lines.length) f.lines.push(lineDraft()); draw(); totals(); }, 'Remove line');
      it.addEventListener('change', () => { const x = S.data.items.find((y) => y.id === it.value); Object.assign(l, x ? { item_id: x.id, description: x.description || x.name, rate: x.rate == null ? '' : String(x.rate), taxable: x.taxable, income_account_id: x.income_account_id || null } : { item_id: '' }); draw(); totals(); });
      desc.addEventListener('input', () => { l.description = desc.value; });
      const upd = () => { l.qty = qty.value; l.rate = rt.value; amt.textContent = usd(r2((num(l.qty) || 0) * (num(l.rate) || 0))); totals(); };
      qty.addEventListener('input', upd); rt.addEventListener('input', upd);
      tax.addEventListener('change', () => { l.taxable = tax.checked; totals(); });
      const c = (n) => { const x = el('td'); x.appendChild(n); return x; };
      tr.append(c(it), c(desc), c(qty), c(rt), amt, c(tax), c(rm)); tb.appendChild(tr);
    });
  };
  draw(); totals();
  const add = btn('+ Line', 'led-btn', () => { f.lines.push(lineDraft()); draw(); totals(); });
  const sc = el('div', 'table-scroll'); sc.appendChild(t);
  const row = el('div', 'sl-lines-foot'); row.append(add, foot);
  wrap.append(sc, row); wrap._totals = totals; return wrap;
}
function payloadLines(ls) {
  return ls.filter((l) => (l.description || '').trim() || l.item_id || l.rate).map((l) => ({ item_id: l.item_id || null, description: l.description, service_date: l.service_date || null,
    qty: num(l.qty) || 0, rate: num(l.rate) || 0, taxable: l.taxable, income_account_id: l.income_account_id || null, job_id: l.job_id || null }));
}
function customerQuick(onAdded) {
  const box = el('div', 'span-all sl-quick');
  const g = el('div', 'led-grid');
  const n = input('text', '', { maxLength: 120 }); const em = input('email', '', { maxLength: 254 }); const co = input('text', '', { maxLength: 120 });
  const ad = input('text', '', { maxLength: 300 }); const tm = select([['', 'Your default'], ...TERMS], '');
  g.append(field('Customer name', n), field('Email', em), field('Company (optional)', co), field('Terms', tm), field('Billing address', ad, 'span-2'));
  const err = el('div', 'form-alert');
  const save = btn('Add customer', 'btn btn-sm', async () => {
    if (!n.value.trim()) { err.textContent = 'Enter the customer’s name.'; err.className = 'form-alert error'; return; }
    const { data, error } = await supabaseClient.from('client_customers').insert({ client_id: currentClient.id, name: n.value.trim(), email: em.value.trim() || null, company: co.value.trim() || null, address: ad.value.trim() || null, terms: tm.value || null, frequency: 'as_needed' }).select('id, name, company, email, cc_emails, phone, address, terms, active').single();
    if (error) { err.textContent = /duplicate|unique/i.test(error.message) ? 'You already have a customer with that name.' : errText(error); err.className = 'form-alert error'; return; }
    S.data.customers.push(data); S.data.customers.sort((a, b) => a.name.localeCompare(b.name)); onAdded(data);
  });
  const cancel = btn('Cancel', 'btn-plain btn-sm-plain', () => box.remove());
  const a = el('div', 'led-actions'); a.append(save, cancel);
  box.append(g, a, err); setTimeout(() => n.focus(), 0); return box;
}
function docForm(f) {
  const inv = f.kind === 'invoice';
  const form = el('form', 'led-form sl-form'); form.noValidate = true;
  form.appendChild(el('h3', 'sl-form-title', `${f.id ? 'Edit' : 'New'} ${inv ? 'invoice' : 'estimate'}`));
  const g = el('div', 'led-grid');
  const custSel = select([['', 'Pick a customer'], ...S.data.customers.filter((c) => c.active || c.id === f.customer_id).map((c) => [c.id, c.name + (c.company ? ' · ' + c.company : '')])], f.customer_id);
  const newC = btn('+ New customer', 'led-btn', () => { if (!form.querySelector('.sl-quick')) g.insertBefore(customerQuick((c) => { const o = el('option', null, c.name); o.value = c.id; custSel.appendChild(o); custSel.value = c.id; custSel.dispatchEvent(new Event('change')); form.querySelector('.sl-quick').remove(); }), g.children[1]); });
  const cWrap = el('label', 'span-2'); cWrap.append(document.createTextNode('Customer')); const cRow = el('span', 'sl-row'); cRow.append(custSel, newC); cWrap.appendChild(cRow);
  const issue = input('date', f.issue_date); const terms = select(TERMS, f.terms); const due = input('date', f.due_date);
  // New documents: "Customer's usual rate" leaves the choice to the books (the customer's sales-tax location, or none).
  const auto = !f.id && f.tax_location_id == null;
  const taxSel = select([...(auto ? [['auto', 'Customer’s usual rate']] : []), ['', 'No sales tax'], ...S.data.taxLocs.map((t) => [t.id, `${t.name} · ${pctTxt2(rateOf(t))}`])], auto ? 'auto' : (f.tax_location_id || ''));
  const jobSel = select([['', '—'], ...S.data.jobs.slice(0, 200).map((j) => [j.id, j.name])], f.job_id);
  custSel.addEventListener('change', () => {
    f.customer_id = custSel.value; const c = S.data.customers.find((x) => x.id === custSel.value);
    if (inv && c && c.terms) { terms.value = c.terms; f.terms = c.terms; due.value = addDays(issue.value || todayISO(), termsDays(c.terms)); f.due_date = due.value; }
  });
  issue.addEventListener('change', () => { f.issue_date = issue.value; if (inv) { due.value = addDays(issue.value || todayISO(), termsDays(terms.value)); f.due_date = due.value; } });
  terms.addEventListener('change', () => { f.terms = terms.value; due.value = addDays(issue.value || todayISO(), termsDays(terms.value)); f.due_date = due.value; });
  due.addEventListener('change', () => { f.due_date = due.value; });
  jobSel.addEventListener('change', () => { f.job_id = jobSel.value; });
  g.append(cWrap, field(inv ? 'Invoice date' : 'Estimate date', issue));
  if (inv) g.append(field('Terms', terms), field('Due date', due));
  g.append(field('Sales tax', taxSel), field('Job (optional)', jobSel));
  const rate = () => rateOf(S.data.taxLocs.find((t) => t.id === taxSel.value));
  const lines = linesEditor(f, rate);
  if (S.data.taxLocs.length === 0) taxSel.closest('label').hidden = true;
  taxSel.addEventListener('change', () => { f.tax_location_id = taxSel.value; lines._totals(); });
  g.appendChild(lines);
  const m = el('textarea'); m.rows = 2; m.maxLength = 2000; m.value = f.message; m.addEventListener('input', () => { f.message = m.value; });
  g.appendChild(field('Message to your customer', m, 'span-2'));
  form.appendChild(g);
  const err = el('div', 'form-alert');
  const a = el('div', 'led-actions');
  const submit = async (finalize) => {
    err.textContent = ''; err.className = 'form-alert';
    const ls = payloadLines(f.lines);
    if (!f.customer_id) { err.textContent = 'Pick a customer.'; err.className = 'form-alert error'; return; }
    if (!ls.length) { err.textContent = 'Add at least one line.'; err.className = 'form-alert error'; return; }
    const p = { client_id: currentClient.id, kind: f.kind, customer_id: f.customer_id, job_id: f.job_id || null, issue_date: f.issue_date, terms: f.terms, due_date: inv ? (f.due_date || null) : null, message: f.message, lines: ls };
    if (taxSel.value !== 'auto') p.tax_location_id = taxSel.value || null;
    if (f.id) p.id = f.id;
    const ok = await run(async () => {
      const id = must(await supabaseClient.rpc('sales_doc_save', { p }));
      if (finalize) must(await supabaseClient.rpc('sales_doc_finalize', { p_doc: id }));
      S.form = null; S.open = id; S.view = inv ? 'invoices' : 'estimates';
    }, finalize ? (inv ? 'Invoice saved and added to your books.' : 'Estimate saved and marked sent.') : 'Saved.');
    if (!ok) { err.textContent = $('sl-msg').textContent; err.className = 'form-alert error'; }
  };
  if (f.status === 'draft') { const fin = btn(inv ? 'Save and finalize' : 'Save and mark sent', 'btn btn-sm', () => submit(true)); a.appendChild(fin); }
  const sv = el('button', f.status === 'draft' ? 'btn-plain btn-sm-plain' : 'btn btn-sm', f.status === 'draft' ? 'Save draft' : 'Save'); sv.type = 'submit'; a.appendChild(sv);
  a.appendChild(btn('Cancel', 'btn-plain btn-sm-plain', () => { S.form = null; render(); }));
  if (inv && f.status === 'draft') a.appendChild(el('span', 'led-sub', 'A draft stays off your books until you finalize it.'));
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
  form.append(a, err);
  return form;
}

function paymentDraft(customer_id, doc) { return { kind: 'payment', customer_id: customer_id || '', doc_id: doc ? doc.id : null }; }
function paymentForm(f) {
  const form = el('form', 'led-form sl-form'); form.noValidate = true;
  form.appendChild(el('h3', 'sl-form-title', 'Record a payment you received'));
  const g = el('div', 'led-grid');
  const cust = select([['', 'Pick a customer'], ...S.data.customers.map((c) => [c.id, c.name])], f.customer_id);
  const date = input('date', todayISO()); const amount = input('text', '', { inputMode: 'decimal', placeholder: '0.00' });
  const method = select(METHODS, 'check'); const ref = input('text', '', { maxLength: 120 });
  const refLabel = field('Check number', ref);
  method.addEventListener('change', () => { refLabel.firstChild.textContent = method.value === 'check' ? 'Check number' : 'Reference (optional)'; });
  g.append(field('Customer', cust, 'span-2'), field('Date received', date), field('Amount', amount), field('How they paid', method), refLabel);
  const applyBox = el('div', 'span-all');
  g.appendChild(applyBox); form.appendChild(g);
  let apply = {};
  const openDocs = () => S.data.docs.filter((d) => d.kind === 'invoice' && d.customer_id === cust.value && ['open', 'partial'].includes(d.status)).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const drawApply = () => {
    applyBox.textContent = '';
    if (!cust.value) { applyBox.appendChild(empty('Pick the customer who paid to see their open invoices.')); return; }
    const docs = openDocs();
    if (!docs.length) { applyBox.appendChild(empty('This customer has no open invoices. Create the invoice first, then record the payment on it.')); return; }
    const rows = docs.map((d) => { const tr = el('tr'); const i = input('text', apply[d.id] || '', { inputMode: 'decimal', className: 'num', 'aria-label': 'Apply to ' + d.number });
      i.addEventListener('input', () => { apply[d.id] = i.value; sumRow.textContent = 'Applied ' + usd(applied()); });
      const c = el('td', 'r'); c.appendChild(i); tr.append(td(d.number), td(day(d.due_date)), td(usd(bal(d)), 'r'), c); return tr; });
    applyBox.appendChild(table(['Invoice', 'Due', 'Balance', 'Apply'], rows));
    const sumRow = el('p', 'led-sub', 'Applied ' + usd(applied())); applyBox.appendChild(sumRow);
  };
  const applied = () => r2(Object.values(apply).reduce((s, v) => s + (num(v) || 0), 0));
  const autoApply = () => { let left = num(amount.value); apply = {}; if (Number.isFinite(left)) for (const d of openDocs()) { if (left <= 0) break; const x = Math.min(left, bal(d)); apply[d.id] = x.toFixed(2); left = r2(left - x); } drawApply(); };
  cust.addEventListener('change', () => { apply = {}; amount.value = ''; drawApply(); });
  amount.addEventListener('input', autoApply);
  if (f.doc_id) { const d = S.data.docs.find((x) => x.id === f.doc_id); if (d) { amount.value = bal(d).toFixed(2); apply = { [d.id]: bal(d).toFixed(2) }; } }
  drawApply();
  const err = el('div', 'form-alert'); const a = el('div', 'led-actions');
  const sv = el('button', 'btn btn-sm', 'Save payment'); sv.type = 'submit';
  a.append(sv, btn('Cancel', 'btn-plain btn-sm-plain', () => { S.form = null; render(); }), el('span', 'led-sub', 'Cash and checks wait in “Undeposited Funds” until the deposit shows in your bank feed.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; err.className = 'form-alert';
    const amt = num(amount.value);
    const fail = (t) => { err.textContent = t; err.className = 'form-alert error'; };
    if (!cust.value) return fail('Pick the customer who paid.');
    if (!Number.isFinite(amt) || amt <= 0) return fail('Enter the amount you received.');
    if (applied() !== r2(amt)) return fail(`Apply the whole payment to invoices: ${usd(applied())} of ${usd(amt)} applied.`);
    const ok = await run(async () => {
      must(await supabaseClient.rpc('sales_payment_record', { p: { client_id: currentClient.id, customer_id: cust.value, payment_date: date.value || todayISO(), amount: amt, method: method.value, reference: ref.value,
        apply: Object.entries(apply).filter(([, v]) => num(v) > 0).map(([doc_id, v]) => ({ doc_id, amount: num(v) })) } }));
      S.form = null; S.view = 'payments';
    }, 'Payment recorded.');
    if (!ok) fail($('sl-msg').textContent);
  });
  form.append(a, err); return form;
}

function recurringDraft(r) {
  const s = S.data.settings;
  return r ? { kind: 'recurring', id: r.id, customer_id: r.customer_id, name: r.name || '', frequency: r.frequency, next_date: r.next_date, end_date: r.end_date || '', terms: r.terms, tax_location_id: r.tax_location_id || '', message: r.message || '', auto_send: r.auto_send, active: r.active, lines: (r.lines || []).map(lineDraft) }
    : { kind: 'recurring', customer_id: '', name: '', frequency: 'monthly', next_date: todayISO(), end_date: '', terms: s.default_terms, tax_location_id: '', message: s.invoice_message || '', auto_send: true, active: true, lines: [lineDraft()] };
}
function recurringForm(f) {
  const form = el('form', 'led-form sl-form'); form.noValidate = true;
  form.appendChild(el('h3', 'sl-form-title', f.id ? 'Edit recurring invoice' : 'New recurring invoice'));
  const g = el('div', 'led-grid');
  const cust = select([['', 'Pick a customer'], ...S.data.customers.filter((c) => c.active || c.id === f.customer_id).map((c) => [c.id, c.name])], f.customer_id);
  const name = input('text', f.name, { maxLength: 120, placeholder: 'e.g. Biweekly cleaning' });
  const freq = select(FREQS, f.frequency); const next = input('date', f.next_date); const end = input('date', f.end_date);
  const terms = select(TERMS, f.terms);
  const taxSel = select([['', 'No sales tax'], ...S.data.taxLocs.map((t) => [t.id, `${t.name} · ${pctTxt2(rateOf(t))}`])], f.tax_location_id);
  const active = input('checkbox', null, { checked: f.active });
  g.append(field('Customer', cust, 'span-2'), field('Name (optional)', name), field('How often', freq), field('Next invoice date', next), field('End date (optional)', end), field('Terms', terms), field('Sales tax', taxSel));
  const lines = linesEditor(f, () => rateOf(S.data.taxLocs.find((t) => t.id === taxSel.value)));
  taxSel.addEventListener('change', () => lines._totals());
  g.appendChild(lines);
  const m = el('textarea'); m.rows = 2; m.maxLength = 1000; m.value = f.message;
  g.appendChild(field('Message to your customer', m, 'span-2'));
  const ac = el('label', 'check-row'); ac.append(active, document.createTextNode(' Active'));
  g.appendChild(ac);
  form.appendChild(g);
  const err = el('div', 'form-alert'); const a = el('div', 'led-actions');
  const sv = el('button', 'btn btn-sm', 'Save'); sv.type = 'submit';
  a.append(sv, btn('Cancel', 'btn-plain btn-sm-plain', () => { S.form = null; render(); }), el('span', 'led-sub', 'Each morning, invoices that are due are created and added to your books.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); const ls = payloadLines(f.lines);
    if (!cust.value) { err.textContent = 'Pick a customer.'; err.className = 'form-alert error'; return; }
    if (!ls.length) { err.textContent = 'Add at least one line.'; err.className = 'form-alert error'; return; }
    await run(async () => {
      must(await supabaseClient.rpc('sales_recurring_save', { p: { id: f.id || null, client_id: currentClient.id, customer_id: cust.value, name: name.value, frequency: freq.value, next_date: next.value || todayISO(), end_date: end.value || null,
        terms: terms.value, tax_location_id: taxSel.value || null, message: m.value, auto_send: f.auto_send, active: active.checked, lines: ls } }));
      S.form = null; S.view = 'recurring';
    }, 'Recurring invoice saved.');
  });
  form.append(a, err); return form;
}

function itemDraft(i) { return i ? { kind: 'item', id: i.id, name: i.name, description: i.description || '', rate: i.rate == null ? '' : String(i.rate), unit: i.unit || '', taxable: i.taxable, active: i.active } : { kind: 'item', name: '', description: '', rate: '', unit: '', taxable: false, active: true }; }
function itemForm(f) {
  const form = el('form', 'led-form sl-form'); form.noValidate = true;
  form.appendChild(el('h3', 'sl-form-title', f.id ? 'Edit product or service' : 'New product or service'));
  const g = el('div', 'led-grid');
  const n = input('text', f.name, { maxLength: 120 }); const r = input('text', f.rate, { inputMode: 'decimal' }); const u = input('text', f.unit, { maxLength: 20, placeholder: 'hour, visit, sq ft' });
  const d = input('text', f.description, { maxLength: 1000 }); const t = input('checkbox', null, { checked: f.taxable }); const a1 = input('checkbox', null, { checked: f.active });
  const tl = el('label', 'check-row'); tl.append(t, document.createTextNode(' Charge sales tax'));
  const al = el('label', 'check-row'); al.append(a1, document.createTextNode(' Active'));
  g.append(field('Name', n, 'span-2'), field('Price', r), field('Unit (optional)', u), field('Description on invoices', d, 'span-2'), tl, al);
  form.appendChild(g);
  const err = el('div', 'form-alert'); const a = el('div', 'led-actions'); const sv = el('button', 'btn btn-sm', 'Save'); sv.type = 'submit';
  a.append(sv, btn('Cancel', 'btn-plain btn-sm-plain', () => { S.form = null; render(); }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); const rate = r.value.trim() === '' ? null : num(r.value);
    if (!n.value.trim()) { err.textContent = 'Enter a name.'; err.className = 'form-alert error'; return; }
    if (rate != null && (!Number.isFinite(rate) || rate < 0)) { err.textContent = 'Enter a valid price.'; err.className = 'form-alert error'; return; }
    const rec = { client_id: currentClient.id, name: n.value.trim(), description: d.value.trim() || null, rate, unit: u.value.trim() || null, taxable: t.checked, active: a1.checked };
    await run(async () => {
      const res = f.id ? await supabaseClient.from('sales_items').update(rec).eq('id', f.id) : await supabaseClient.from('sales_items').insert(rec);
      if (res.error && /duplicate|unique/i.test(res.error.message)) throw new Error('You already have a product or service with that name.');
      must(res); S.form = null; S.view = 'items';
    }, 'Saved.');
  });
  form.append(a, err); return form;
}

// ---------- print ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function printDoc(d, lines) {
  const s = S.data.settings; const c = S.data.customers.find((x) => x.id === d.customer_id) || {}; const inv = d.kind === 'invoice';
  const rows = lines.map((l) => `<tr><td>${esc(l.description)}${l.service_date ? `<div class="sd">${esc(day(l.service_date))}</div>` : ''}</td><td class="r">${esc(Number(l.qty))}</td><td class="r">${esc(usd(l.rate))}</td><td class="r">${esc(usd(l.amount))}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(currentClient.business_name)} – ${inv ? 'Invoice' : 'Estimate'} ${esc(d.number)}</title><style>
  @page{size:letter portrait;margin:.6in}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;color:#1A2233;font:10.5pt/1.45 'Helvetica Neue',Arial,sans-serif;font-variant-numeric:tabular-nums}
  .top{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:16px;border-bottom:2px solid #071428}
  .biz{font:600 18pt/1.2 Georgia,serif;color:#071428;margin:0}.sub{color:#5B6474;font-size:9.5pt;margin:4px 0 0}
  .doc{text-align:right}.doc h1{margin:0;font-size:9pt;letter-spacing:.18em;text-transform:uppercase;color:#8A6D1E}.num{font:600 16pt/1.2 Georgia,serif;color:#071428;margin:2px 0 6px}
  dl{display:grid;grid-template-columns:auto auto;gap:1px 12px;margin:0;font-size:9.5pt;justify-content:end}dt{color:#5B6474}dd{margin:0;text-align:right}
  .to{margin:20px 0 16px}.to h2{font-size:7.5pt;letter-spacing:.14em;text-transform:uppercase;color:#8A93A3;margin:0 0 4px}.to p{margin:0;white-space:pre-line}
  table{width:100%;border-collapse:collapse}th{font-size:7.5pt;letter-spacing:.12em;text-transform:uppercase;color:#8A93A3;text-align:left;padding:8px 6px 6px;border-bottom:1px solid #071428}
  td{padding:7px 6px;border-bottom:1px solid #ECEAE3;vertical-align:top}.r{text-align:right;white-space:nowrap}.sd{color:#8A93A3;font-size:8.5pt}
  .tot{margin-left:auto;width:46%;margin-top:10px}.tot td{border:0;padding:4px 6px}.tot .due td{border-top:2px solid #071428;font-weight:700;font-size:12pt;color:#071428;padding-top:8px}
  .msg{margin-top:22px;padding:12px 14px;background:#F7F4EC;border-left:3px solid #D4AF37;white-space:pre-line}footer{margin-top:28px;padding-top:10px;border-top:1px solid #E4E0D5;font-size:8pt;color:#6B7280;white-space:pre-line}
  .paid{display:inline-block;margin-top:10px;padding:3px 10px;border:2px solid #2F7A55;color:#2F7A55;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:9pt}
  </style></head><body>
  <div class="top"><div><p class="biz">${esc(currentClient.business_name)}</p>${s.reply_email ? `<p class="sub">${esc(s.reply_email)}</p>` : ''}</div>
  <div class="doc"><h1>${inv ? 'Invoice' : 'Estimate'}</h1><p class="num">${esc(d.number)}</p><dl><dt>Date</dt><dd>${esc(day(d.issue_date))}</dd>${inv ? `<dt>Terms</dt><dd>${esc(TERMS_LABEL[d.terms] || d.terms)}</dd><dt>Due</dt><dd>${esc(day(d.due_date))}</dd>` : ''}</dl></div></div>
  <div class="to"><h2>${inv ? 'Bill to' : 'Prepared for'}</h2><p>${esc(c.name || '')}${c.company ? '\n' + esc(c.company) : ''}${c.address ? '\n' + esc(c.address) : ''}${c.email ? '\n' + esc(c.email) : ''}</p></div>
  <table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="tot"><tbody><tr><td>Subtotal</td><td class="r">${esc(usd(d.subtotal))}</td></tr>${Number(d.tax_total) ? `<tr><td>Sales tax (${esc(pctTxt2(Number(d.tax_rate)))})</td><td class="r">${esc(usd(d.tax_total))}</td></tr>` : ''}
  <tr><td>Total</td><td class="r">${esc(usd(d.total))}</td></tr>${inv && Number(d.amount_paid) ? `<tr><td>Paid</td><td class="r">(${esc(usd(d.amount_paid))})</td></tr>` : ''}${inv ? `<tr class="due"><td>Balance due</td><td class="r">${esc(usd(bal(d)))}</td></tr>` : ''}</tbody></table>
  ${inv && d.status === 'paid' ? '<div class="paid">Paid</div>' : ''}${d.message ? `<div class="msg">${esc(d.message)}</div>` : ''}
  <footer>${s.footer ? esc(s.footer) + '\n' : ''}Thank you for your business.</footer></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { msg('Allow pop-ups for this site to print or save the PDF.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* stays open to print by hand */ } }, 300);
}

// ---------- wiring ----------
document.querySelectorAll('[data-sales]').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.sales; S.open = null; S.form = null; S.q = ''; msg(''); render(); }));
const newDoc = (kind) => { S.form = docDraft(kind); S.open = null; msg(''); render(); window.scrollTo({ top: $('sl-body').offsetTop - 90, behavior: 'smooth' }); };
$('sl-new-invoice').addEventListener('click', () => newDoc('invoice'));
$('sl-new-estimate').addEventListener('click', () => newDoc('estimate'));
$('sl-new-payment').addEventListener('click', () => { S.form = paymentDraft(); S.open = null; msg(''); render(); });
$('sl-new-recurring').addEventListener('click', () => { S.form = recurringDraft(); S.open = null; msg(''); render(); });
window.loadSales = () => load().catch((e) => { const b = $('sl-body'); b.textContent = ''; b.appendChild(empty('Sales couldn’t load: ' + errText(e))); });
})();
