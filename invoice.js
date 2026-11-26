// Customer view of one invoice or estimate (no login). The link carries a random token; the database
// stores only its hash and returns just this document (sales_public_doc). Rendered with textContent only.
(function () {
'use strict';
const sheet = document.getElementById('sheet');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const usd = (n) => { const v = Number(n || 0); const s = '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v < 0 ? `(${s})` : s; };
const day = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : '');
const TERMS = { due_on_receipt: 'Due on receipt', net_7: 'Net 7', net_10: 'Net 10', net_15: 'Net 15', net_30: 'Net 30', net_45: 'Net 45', net_60: 'Net 60' };
const pct = (r) => (Number(r) * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';
const fail = (text) => { sheet.textContent = ''; sheet.appendChild(el('p', 'center', text)); };

const token = new URLSearchParams(location.search).get('t') || '';
if (!/^[0-9a-f]{48}$/.test(token)) { fail('This link isn’t complete. Check that you copied the whole link, or ask the business to send it again.'); return; }

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
client.rpc('sales_public_doc', { p_token: token }).then(({ data, error }) => {
  if (error) { fail('This invoice couldn’t load right now. Try again in a minute.'); return; }
  if (!data) { fail('This link is no longer active. The business may have sent a newer one, or the invoice was cancelled.'); return; }
  render(data);
}).catch(() => fail('This invoice couldn’t load. Check your connection and try again.'));

function render(d) {
  const inv = d.kind === 'invoice';
  document.title = `${inv ? 'Invoice' : 'Estimate'} ${d.number} from ${d.business}`;
  sheet.textContent = '';
  const top = el('div', 'top');
  const left = el('div'); left.appendChild(el('p', 'biz', d.business)); if (d.reply_email) left.appendChild(el('p', 'sub', d.reply_email));
  const right = el('div', 'doc'); right.append(el('h1', '', inv ? 'Invoice' : 'Estimate'), el('p', 'num', d.number));
  const dl = el('dl'); const add = (k, v) => dl.append(el('dt', '', k), el('dd', '', v));
  add('Date', day(d.issue_date)); if (inv) { add('Terms', TERMS[d.terms] || d.terms); add('Due', day(d.due_date)); }
  right.appendChild(dl); top.append(left, right); sheet.appendChild(top);

  if (inv) {
    const paid = Number(d.balance) <= 0;
    const box = el('div', 'due-box' + (paid ? ' paid' : ''));
    const l = el('div'); l.append(el('div', 'label', paid ? 'Paid in full' : 'Amount due'), el('div', 'amt', usd(paid ? d.total : d.balance)));
    if (!paid && d.due_date) l.appendChild(el('p', 'note', 'Due ' + day(d.due_date)));
    const actions = el('div', 'actions no-print');
    if (!paid) {
      const pay = el('button', 'btn primary', 'Pay online'); pay.type = 'button';
      if (d.can_pay) { pay.addEventListener('click', () => { pay.disabled = true; pay.textContent = 'Opening secure payment…'; startPay(pay); }); }
      else { pay.disabled = true; pay.title = 'Online payment isn’t set up for this business yet.'; }
      actions.appendChild(pay);
    }
    const pr = el('button', 'btn', 'Print or save PDF'); pr.type = 'button'; pr.addEventListener('click', () => window.print());
    actions.appendChild(pr);
    box.append(l, actions); sheet.appendChild(box);
    if (!paid && !d.can_pay) sheet.appendChild(el('p', 'note no-print', 'To pay, use the payment details below or contact the business.'));
  } else {
    const actions = el('div', 'actions no-print'); actions.style.margin = '20px 0';
    const pr = el('button', 'btn', 'Print or save PDF'); pr.type = 'button'; pr.addEventListener('click', () => window.print());
    actions.appendChild(pr); sheet.appendChild(actions);
  }

  const to = el('div', 'to'); const c = d.customer || {};
  to.append(el('h2', '', inv ? 'Bill to' : 'Prepared for'), el('p', '', [c.name, c.company, c.address].filter(Boolean).join('\n')));
  sheet.appendChild(to);

  const t = el('table'); const th = el('thead'); const hr = el('tr');
  [['Description', ''], ['Qty', 'r'], ['Rate', 'r'], ['Amount', 'r']].forEach(([h, c2]) => hr.appendChild(el('th', c2, h)));
  th.appendChild(hr); t.appendChild(th); const tb = el('tbody');
  (d.lines || []).forEach((l) => {
    const tr = el('tr'); const dc = el('td'); dc.appendChild(document.createTextNode(l.description || '')); if (l.service_date) dc.appendChild(el('div', 'sd', day(l.service_date)));
    tr.append(dc, el('td', 'r', String(Number(l.qty))), el('td', 'r', usd(l.rate)), el('td', 'r', usd(l.amount))); tb.appendChild(tr);
  });
  t.appendChild(tb); sheet.appendChild(t);
  const tot = el('table', 'tot'); const tbody = el('tbody');
  const row = (k, v, strong) => { const tr = el('tr', strong ? 'strong' : ''); tr.append(el('td', '', k), el('td', 'r', v)); tbody.appendChild(tr); };
  row('Subtotal', usd(d.subtotal)); if (Number(d.tax_total)) row(`Sales tax (${pct(d.tax_rate)})`, usd(d.tax_total));
  row('Total', usd(d.total), !inv);
  if (inv && Number(d.amount_paid)) row('Paid', '(' + usd(d.amount_paid) + ')');
  if (inv) row('Balance due', usd(d.balance), true);
  tot.appendChild(tbody); sheet.appendChild(tot);
  if (inv && d.status === 'paid') { const s = el('p'); s.appendChild(el('span', 'stamp', 'Paid')); sheet.appendChild(s); }
  if (d.message) sheet.appendChild(el('div', 'msg', d.message));
  sheet.appendChild(el('div', 'foot', (d.footer ? d.footer + '\n' : '') + 'Thank you for your business.'));
}

// Online payment (Stripe Checkout on the business's own Stripe account) is switched on in a later step.
function startPay(btnEl) { btnEl.textContent = 'Online payment is coming soon'; }
})();
