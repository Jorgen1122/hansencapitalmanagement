const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const DOCS_BUCKET = 'client-documents';
let currentUser = null;
let currentClient = null;
let kpiHistory = [];
let trendChart = null;
let chartMetric = 'net_income_mtd';
let chartView = 'monthly';
let chartMonths = 13; // bars shown: current + trailing 12 (range buttons change it)

const METRIC_LABELS = {
net_income_mtd: 'Net Income',
revenue_mtd: 'Revenue',
expenses_mtd: 'Expenses',
gross_margin: 'Gross Margin',
net_margin: 'Net Margin',
cash: 'Cash Position',
};
// Flows add up across months. Ratios are recomputed from running totals. Balances never add.
const FLOW_METRICS = ['net_income_mtd', 'revenue_mtd', 'expenses_mtd'];
const RATIO_METRICS = ['gross_margin', 'net_margin'];

// period_end is a plain date (YYYY-MM-DD); format it in UTC so it never slips back a day
const fmtDate = (d, opts) => new Date(d).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts));

async function init() {
const { data: { session } } = await supabaseClient.auth.getSession();
if (!session) { window.location.href = 'login.html'; return; }
// Accounts with two-step verification must finish it before seeing anything
if (await hcmAuth.needsSecondStep(supabaseClient)) { window.location.href = 'login.html'; return; }
currentUser = session.user;

const { data: client, error: clientErr } = await supabaseClient
.from('clients').select('*').eq('user_id', currentUser.id).single();

if (clientErr || !client) {
document.getElementById('loading').textContent =
'No client profile is linked to this account yet. Contact us to finish setup.';
return;
}

currentClient = client;
document.getElementById('client-name').textContent = `Welcome, ${client.business_name}`;
document.getElementById('loading').style.display = 'none';
document.getElementById('dashboard-content').style.display = 'block';

await loadPaymentStatus();
await loadKpiHistory();
await loadDocuments();
renderPnl();
renderCashStats();
await loadReports();
await loadBilling();
await loadExtras();
showTab(location.hash.slice(1));

document.querySelectorAll('.chart-tab').forEach(tab => {
tab.addEventListener('click', () => {
document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
tab.classList.add('active');
chartMetric = tab.dataset.metric;
renderChart();
});
});
document.querySelectorAll('.view-tab').forEach(tab => {
tab.addEventListener('click', () => {
document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
tab.classList.add('active');
chartView = tab.dataset.view;
renderChart();
});
});
document.querySelectorAll('.range-tab').forEach(tab => {
tab.addEventListener('click', () => {
document.querySelectorAll('.range-tab').forEach(t => t.classList.remove('active'));
tab.classList.add('active');
chartMonths = Number(tab.dataset.range) || 13;
renderChart();
});
});
}


async function loadPaymentStatus() {
const { data, error } = await supabaseClient
.from('payments')
.select('*')
.eq('client_id', currentClient.id)
.order('period_end', { ascending: false })
.limit(1)
.single();

if (error || !data) return; // no payment record yet — box stays hidden

document.getElementById('payment-box').style.display = 'flex';
document.getElementById('payment-amount').textContent =
`$${Number(data.amount_due).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const statusWrap = document.getElementById('payment-status-wrap');
const isOverdue = data.status === 'open' && data.due_date && new Date(data.due_date) < new Date();
const badgeClass = data.status === 'paid' ? 'paid' : (isOverdue ? 'overdue' : 'open');
const badgeText = data.status === 'paid' ? 'Paid' : (isOverdue ? 'Past Due' : 'Due');
statusWrap.innerHTML = `<span class="badge ${badgeClass}">${badgeText}</span>`;

if (data.status !== 'paid' && data.hosted_invoice_url) {
const payLink = document.getElementById('pay-link');
payLink.href = data.hosted_invoice_url;
payLink.style.display = 'inline-block';
}
}

async function loadKpiHistory() {
const { data, error } = await supabaseClient
.from('kpi_snapshots')
.select('*')
.eq('client_id', currentClient.id)
.order('period_end', { ascending: false })
.limit(36); // enough history to compute year-to-date totals correctly

if (error || !data || data.length === 0) {
document.getElementById('kpi-grid').innerHTML = '';
document.getElementById('no-kpi').style.display = 'block';
document.getElementById('no-history').style.display = 'block';
return;
}

kpiHistory = data.reverse(); // chronological order for charting
addRunningTotals(kpiHistory);
const latest = kpiHistory[kpiHistory.length - 1];

document.getElementById('period-label').textContent =
`As of ${fmtDate(latest.period_end, { month: 'long', day: 'numeric', year: 'numeric' })}`;

const fmt = (n) => n == null ? '—' : `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`;

const prev = kpiHistory.length > 1 ? kpiHistory[kpiHistory.length - 2] : null;
// Change vs. the prior month: % for dollar figures, points for margins. "up" = good for the business.
const chg = (key, isPct, costLike) => {
if (!prev || latest[key] == null || prev[key] == null) return null;
const a = Number(latest[key]), b = Number(prev[key]);
let text;
if (isPct) { const d = (a - b) * 100; text = `${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`; }
else { if (!b) return null; const d = (a - b) / Math.abs(b) * 100; text = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`; }
const good = costLike ? a <= b : a >= b;
return { text: `${text} vs prior month`, cls: a === b ? 'flat' : (good ? 'up' : 'down') };
};
// Runway: cash divided by average monthly expenses over the last 3 closed months
const recent = kpiHistory.slice(-3).map(r => Number(r.expenses_mtd)).filter(v => v > 0);
const avgSpend = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : 0;
const runway = (latest.cash != null && avgSpend) ? (Number(latest.cash) / avgSpend) : null;
const spark = (key) => {
const vals = kpiHistory.slice(-12).map(r => r[key]).filter(v => v != null).map(Number);
if (vals.length < 2) return '';
const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 80).toFixed(1)},${(22 - (v - lo) / span * 20).toFixed(1)}`).join(' ');
return `<svg class="spark" viewBox="0 0 80 24" width="80" height="24" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
};

const cards = [
['Cash Balance', fmt(latest.cash), '', chg('cash'), spark('cash')],
['Revenue (MTD)', fmt(latest.revenue_mtd), `YTD ${fmt(latest.ytd_revenue)}`, chg('revenue_mtd'), spark('revenue_mtd')],
['Expenses (MTD)', fmt(latest.expenses_mtd), `YTD ${fmt(latest.ytd_expenses)}`, chg('expenses_mtd', false, true), spark('expenses_mtd')],
['Net Income (MTD)', fmt(latest.net_income_mtd), `YTD ${fmt(latest.ytd_net_income)}`, chg('net_income_mtd'), spark('net_income_mtd')],
['Gross Margin', fmtPct(latest.gross_margin), `YTD ${fmtPct(latest.ytd_gross_margin)}`, chg('gross_margin', true), spark('gross_margin')],
['Cash Runway', runway == null ? '—' : `${runway.toFixed(1)} mo`, 'Cash ÷ avg monthly expenses (3 mo)', null, ''],
];
document.getElementById('kpi-grid').innerHTML = cards.map(([label, value, sub, delta, sp]) => `
<div class="kpi-card"><div class="label">${label}</div><div class="value">${value}</div>${delta ? `<div class="delta ${delta.cls}">${delta.text}</div>` : ''}${sub ? `<div class="sub">${sub}</div>` : ''}${sp}</div>
`).join('');

const closed = fmtDate(latest.period_end, { month: 'short', day: 'numeric', year: 'numeric' });
const bs = document.getElementById('books-status');
if (bs) { bs.textContent = `Books closed through ${closed}`; bs.hidden = false; }
const rc = document.getElementById('rail-closed');
if (rc) rc.textContent = `Closed through ${closed}`;

renderChart();
}

// Running totals that restart every January. Flows (revenue, expenses, net income) simply add.
// Margins are NOT added: they are rebuilt from the running totals (profit / revenue).
// Cash is a balance, so it has no running total.
function addRunningTotals(rows) {
let year = null, rev = 0, exp = 0, ni = 0, gp = 0;
rows.forEach(row => {
const y = new Date(row.period_end).getUTCFullYear();
if (y !== year) { year = y; rev = 0; exp = 0; ni = 0; gp = 0; }
const r = Number(row.revenue_mtd) || 0;
rev += r;
exp += Number(row.expenses_mtd) || 0;
ni += Number(row.net_income_mtd) || 0;
gp += (Number(row.gross_margin) || 0) * r; // gross profit for the month = margin x revenue
row.ytd_revenue = rev;
row.ytd_expenses = exp;
row.ytd_net_income = ni;
row.ytd_gross_margin = rev ? gp / rev : null;
row.ytd_net_margin = rev ? ni / rev : null;
});
}

function chartValue(row, metric, view) {
if (view === 'ytd') {
if (metric === 'net_income_mtd') return row.ytd_net_income;
if (metric === 'revenue_mtd') return row.ytd_revenue;
if (metric === 'expenses_mtd') return row.ytd_expenses;
if (metric === 'gross_margin') return row.ytd_gross_margin;
if (metric === 'net_margin') return row.ytd_net_margin;
}
return row[metric]; // monthly view, and cash (a balance) in both views
}

function renderChart() {
const metric = chartMetric, view = chartView;
const rows = kpiHistory.slice(-chartMonths);
if (rows.length < 1) return;
const isPct = RATIO_METRICS.includes(metric);
const isYtd = view === 'ytd' && metric !== 'cash';
// Monthly view: everything is a bar chart.
// Year-to-Date view: running totals and cash are lines; the two margins stay bars.
const useLine = view === 'ytd' && !RATIO_METRICS.includes(metric);
const labels = rows.map(row => fmtDate(row.period_end, { month: 'short', year: '2-digit' }));
const values = rows.map(row => {
const v = chartValue(row, metric, view);
return v == null ? null : (isPct ? Number(v) * 100 : Number(v));
});

const note = document.getElementById('chart-note');
if (metric === 'cash') note.textContent = 'Cash is a balance at each month-end, so it does not add up across months; the two views show the same values.';
else if (view === 'monthly') note.textContent = 'Each bar is one month.';
else if (isPct) note.textContent = 'Year-to-date margin = running profit ÷ running revenue since January. Margins are recalculated, never added together.';
else note.textContent = 'Each point adds that month to the months before it, restarting every January.';

const fmtAxis = (v) => isPct ? `${Number(v).toFixed(0)}%` : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString()}`;
const fmtTip = (v) => isPct ? `${Number(v).toFixed(1)}%` : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const label = (isYtd ? 'YTD ' : '') + METRIC_LABELS[metric];
// one gold series; only negative values turn red
const barColors = values.map(v => (v != null && v < 0) ? '#E07A5F' : '#D4AF37');

Chart.defaults.font.family = "Inter, 'Helvetica Neue', Arial, sans-serif";
if (trendChart) trendChart.destroy();
const ctx = document.getElementById('trend-chart').getContext('2d');
const dataset = useLine ? {
label,
data: values,
borderColor: '#D4AF37',
backgroundColor: 'rgba(212, 175, 55, 0.12)',
tension: 0.25,
fill: true,
pointBackgroundColor: '#D4AF37',
pointRadius: 4,
} : {
label,
data: values,
backgroundColor: barColors,
borderColor: barColors,
borderWidth: 1,
maxBarThickness: 56,
};
trendChart = new Chart(ctx, {
type: useLine ? 'line' : 'bar',
data: { labels, datasets: [dataset] },
options: {
responsive: true,
maintainAspectRatio: false,
plugins: {
legend: { display: false },
tooltip: { callbacks: { label: (c) => `${label}: ${fmtTip(c.parsed.y)}` } }
},
scales: {
x: { ticks: { color: '#A9B3C2' }, grid: useLine ? { color: 'rgba(244,240,230,0.06)' } : { display: false } },
y: {
ticks: { color: '#A9B3C2', callback: fmtAxis },
grid: { color: (c) => c.tick && c.tick.value === 0 ? 'rgba(244,240,230,0.45)' : 'rgba(244,240,230,0.06)' }
}
}
}
});
}

async function loadDocuments() {
const { data, error } = await supabaseClient
.from('documents')
.select('*')
.eq('client_id', currentClient.id)
.order('uploaded_at', { ascending: false });

document.getElementById('client-doc-rows').innerHTML = '';
document.getElementById('firm-doc-rows').innerHTML = '';
if (error || !data) {
document.getElementById('no-client-docs').textContent = 'We couldn\u2019t load your documents. Refresh the page to try again.';
document.getElementById('no-client-docs').style.display = 'block';
return;
}

const clientDocs = data.filter(d => d.direction !== 'firm_deliverable');
const firmDocs = data.filter(d => d.direction === 'firm_deliverable');

const clientRows = document.getElementById('client-doc-rows');
if (clientDocs.length === 0) {
document.getElementById('no-client-docs').style.display = 'block';
} else {
clientDocs.forEach(d => {
const tr = document.createElement('tr');
[d.filename, new Date(d.uploaded_at).toLocaleDateString(), d.status].forEach(v => {
const td = document.createElement('td');
td.textContent = v == null ? '' : String(v);
tr.appendChild(td);
});
clientRows.appendChild(tr);
});
}

const firmRows = document.getElementById('firm-doc-rows');
if (firmDocs.length === 0) {
document.getElementById('no-firm-docs').style.display = 'block';
} else {
firmDocs.forEach(d => {
const tr = document.createElement('tr');
const nameTd = document.createElement('td');
nameTd.textContent = d.filename || '';
const catTd = document.createElement('td');
const tag = document.createElement('span');
tag.className = 'category-tag';
tag.textContent = d.category || 'Document';
catTd.appendChild(tag);
const dateTd = document.createElement('td');
dateTd.textContent = new Date(d.uploaded_at).toLocaleDateString();
const linkTd = document.createElement('td');
const link = document.createElement('a');
link.href = '#';
link.className = 'doc-download-link';
link.textContent = 'Download';
link.dataset.path = d.storage_path || '';
linkTd.appendChild(link);
tr.append(nameTd, catTd, dateTd, linkTd);
firmRows.appendChild(tr);
});

document.querySelectorAll('.doc-download-link').forEach(link => {
link.addEventListener('click', async (e) => {
e.preventDefault();
const path = (link.dataset.path || '').trim();
link.textContent = 'Loading…';
const { data, error } = await supabaseClient.storage
.from(DOCS_BUCKET)
.createSignedUrl(path, 60); // link valid for 60 seconds
if (error || !data) {
link.textContent = 'Error — try again';
console.error(error);
return;
}
window.open(data.signedUrl, '_blank', 'noopener');
link.textContent = 'Download';
});
});
}
}

const ALLOWED_TYPES = [
'application/pdf', 'image/jpeg', 'image/png', 'image/heic',
'application/vnd.ms-excel',
'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
'text/csv',
];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function sanitizeFilename(name) {
return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
}

document.getElementById('upload-btn').addEventListener('click', async () => {
const input = document.getElementById('file-input');
const files = input.files;
const statusEl = document.getElementById('status-msg');

if (!files || files.length === 0) {
statusEl.textContent = 'Choose at least one file first.';
statusEl.className = 'error';
return;
}
for (const file of files) {
if (!ALLOWED_TYPES.includes(file.type)) {
statusEl.textContent = `"${file.name}" isn't an accepted file type.`;
statusEl.className = 'error';
return;
}
if (file.size > MAX_FILE_BYTES) {
statusEl.textContent = `"${file.name}" is over the 25 MB limit.`;
statusEl.className = 'error';
return;
}
}

const btn = document.getElementById('upload-btn');
btn.disabled = true;
statusEl.textContent = 'Uploading…';
statusEl.className = '';
btn.setAttribute('aria-busy', 'true');

try {
let uploadIndex = 0;
for (const file of files) {
uploadIndex += 1;
statusEl.textContent = files.length > 1 ? `Uploading ${uploadIndex} of ${files.length}…` : 'Uploading…';
const safeName = sanitizeFilename(file.name);
const path = `${currentClient.id}/${Date.now()}_${safeName}`;
const { error: uploadErr } = await supabaseClient.storage.from(DOCS_BUCKET).upload(path, file);
if (uploadErr) throw uploadErr;

const { error: dbErr } = await supabaseClient.from('documents').insert({
client_id: currentClient.id,
filename: file.name,
storage_path: path,
status: 'pending',
direction: 'client_upload',
});
if (dbErr) throw dbErr;
}
statusEl.textContent = 'Uploaded successfully.';
statusEl.className = 'success';
input.value = '';
await loadDocuments();
} catch (err) {
statusEl.textContent = err.message || 'Upload failed.';
statusEl.className = 'error';
} finally {
btn.disabled = false;
btn.removeAttribute('aria-busy');
}
});

document.getElementById('logout-btn').addEventListener('click', async () => {
const lb = document.getElementById('logout-btn');
lb.disabled = true;
lb.textContent = 'Signing out…';
await supabaseClient.auth.signOut();
window.location.href = 'login.html';
});

// ---------- Account security: two-step verification ----------
let pendingFactorId = null;
let disableArmed = false;
const mfaEls = () => ({
status: document.getElementById('mfa-status'),
enable: document.getElementById('mfa-enable-btn'),
enroll: document.getElementById('mfa-enroll'),
disable: document.getElementById('mfa-disable-btn'),
});
function mfaMsg(text, cls) { setAlert('mfa-msg', text, cls); }

async function refreshMfa() {
const el = mfaEls();
el.enroll.hidden = true;
const factor = await hcmAuth.verifiedFactor(supabaseClient).catch(() => null);
const pill = document.getElementById('sec-pill');
if (pill) { pill.hidden = false; pill.textContent = factor ? '2-step on' : '2-step off'; pill.className = 'sec-pill ' + (factor ? 'on' : 'off'); }
if (factor) {
el.status.textContent = 'Two-step verification is ON. You’ll enter a code from your authenticator app each time you sign in.';
el.enable.hidden = true;
el.disable.hidden = false;
} else {
el.status.textContent = 'Two-step verification is OFF. Turn it on so a stolen password alone can’t open your account.';
el.enable.hidden = false;
el.disable.hidden = true;
}
}

document.getElementById('mfa-enable-btn').addEventListener('click', async () => {
const el = mfaEls();
const btn = el.enable;
mfaMsg('');
setBusy(btn, true, 'Preparing…');
try {
// clear any half-finished setup from an earlier attempt
const { data: list } = await supabaseClient.auth.mfa.listFactors();
for (const f of ((list && list.all) || []).filter(x => x.status !== 'verified')) {
await supabaseClient.auth.mfa.unenroll({ factorId: f.id });
}
const { data, error } = await supabaseClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator app' });
if (error) throw error;
pendingFactorId = data.id;
document.getElementById('mfa-qr').src = data.totp.qr_code;
document.getElementById('mfa-secret').textContent = data.totp.secret;
el.enroll.hidden = false;
btn.hidden = true;
document.getElementById('mfa-enroll-code').focus();
} catch (err) {
mfaMsg(friendlyError(err), 'error');
}
setBusy(btn, false, 'Turn On Two-Step Verification');
});

document.getElementById('mfa-verify-btn').addEventListener('click', async () => {
const btn = document.getElementById('mfa-verify-btn');
const code = document.getElementById('mfa-enroll-code').value.replace(/\s/g, '');
mfaMsg('');
if (!/^\d{6}$/.test(code)) { fieldError('mfa-enroll-code', 'Enter the 6-digit code shown in your app.'); return; }
fieldError('mfa-enroll-code', '');
setBusy(btn, true, 'Verifying…');
try {
const { error } = await supabaseClient.auth.mfa.challengeAndVerify({ factorId: pendingFactorId, code });
if (error) throw error;
pendingFactorId = null;
document.getElementById('mfa-enroll-code').value = '';
await refreshMfa();
mfaMsg('Two-step verification is now on.', 'success');
} catch (err) {
mfaMsg(friendlyError(err), 'error');
}
setBusy(btn, false, 'Verify and Turn On');
});

document.getElementById('mfa-cancel-btn').addEventListener('click', async () => {
if (pendingFactorId) { await supabaseClient.auth.mfa.unenroll({ factorId: pendingFactorId }); pendingFactorId = null; }
mfaMsg('');
await refreshMfa();
});

document.getElementById('mfa-disable-btn').addEventListener('click', async () => {
const btn = document.getElementById('mfa-disable-btn');
if (!disableArmed) {
disableArmed = true;
btn.textContent = 'Click again to confirm turning it off';
setTimeout(() => { disableArmed = false; if (!btn.disabled) btn.textContent = 'Turn Off Two-Step Verification'; }, 6000);
return;
}
disableArmed = false;
setBusy(btn, true, 'Turning off…');
try {
const factor = await hcmAuth.verifiedFactor(supabaseClient);
if (factor) {
const { error } = await supabaseClient.auth.mfa.unenroll({ factorId: factor.id });
if (error) throw error;
}
await refreshMfa();
mfaMsg('Two-step verification is off.', 'success');
} catch (err) {
mfaMsg(friendlyError(err), 'error');
}
setBusy(btn, false, 'Turn Off Two-Step Verification');
});

init().then(() => { if (currentClient) refreshMfa(); });

// =====================================================================
// Tabs: Overview / P&L / Cash / Reports / Billing / Documents / Security
// Everything below renders with DOM methods and textContent only.
// =====================================================================
const TABS = ['overview', 'pnl', 'cash', 'reports', 'billing', 'documents', 'security'];
function showTab(name) {
if (name && !TABS.includes(name)) return; // e.g. the skip link
if (!name) name = 'overview';
document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.dataset.tab !== name; });
document.querySelectorAll('.portal-nav a').forEach(a => {
const on = a.getAttribute('href') === '#' + name;
a.classList.toggle('active', on);
if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
});
if (name === 'cash') renderCashChart();
}
window.addEventListener('hashchange', () => { showTab(location.hash.slice(1)); window.scrollTo(0, 0); });

const money = (n, opts) => {
if (n == null || isNaN(n)) return '—';
const v = Number(n), neg = v < 0, abs = Math.abs(v);
const s = '$' + abs.toLocaleString(undefined, { minimumFractionDigits: (opts && opts.cents) ? 2 : 0, maximumFractionDigits: (opts && opts.cents) ? 2 : 0 });
return neg ? `(${s})` : s;
};
const pctTxt = (n) => (n == null || isNaN(n)) ? '—' : `${(Number(n) * 100).toFixed(1)}%`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : null;

function statCards(containerId, cards) {
const box = document.getElementById(containerId);
box.textContent = '';
cards.forEach(([label, value, sub]) => {
const c = el('div', 'kpi-card');
c.append(el('div', 'label', label), el('div', 'value', value));
if (sub) c.append(el('div', 'sub', sub));
box.appendChild(c);
});
}

// ---------- P&L ----------
let pnlMonths = 6;
function pnlLine(rows) {
let rev = 0, exp = 0, ni = 0, gp = 0, gpKnown = true;
rows.forEach(r => {
const rv = Number(r.revenue_mtd) || 0;
rev += rv; exp += Number(r.expenses_mtd) || 0; ni += Number(r.net_income_mtd) || 0;
if (r.gross_margin == null) gpKnown = false; else gp += Number(r.gross_margin) * rv;
});
const cogs = gpKnown ? rev - gp : null;
return { rev, cogs, gp: gpKnown ? gp : null, opex: gpKnown ? exp - cogs : null, ni, gm: (gpKnown && rev) ? gp / rev : null, nm: rev ? ni / rev : null };
}
function renderPnl() {
const table = document.getElementById('pnl-table'), empty = document.getElementById('pnl-empty');
table.textContent = '';
if (!kpiHistory.length) { table.hidden = true; empty.hidden = false; return; }
const months = kpiHistory.slice(-pnlMonths);
const latest = kpiHistory[kpiHistory.length - 1];
const yr = new Date(latest.period_end).getUTCFullYear();
const ytd = kpiHistory.filter(r => new Date(r.period_end).getUTCFullYear() === yr);
const cols = months.map(r => ({ label: fmtDate(r.period_end, { month: 'short', year: '2-digit' }), v: pnlLine([r]) }));
cols.push({ label: `YTD ${yr}`, v: pnlLine(ytd), ytd: true });
const spec = [
['Revenue', 'rev', ''], ['Cost of sales', 'cogs', 'cost'], ['Gross profit', 'gp', 'sub'],
['Operating expenses', 'opex', 'cost'], ['Net income', 'ni', 'total'],
['Gross margin', 'gm', 'pct'], ['Net margin', 'nm', 'pct'],
];
const thead = el('thead'), hr = el('tr');
hr.appendChild(el('th', null, ''));
cols.forEach(c => { const th = el('th', c.ytd ? 'ytd' : null, c.label); th.scope = 'col'; hr.appendChild(th); });
thead.appendChild(hr);
const tbody = el('tbody');
spec.forEach(([label, key, kind]) => {
const tr = el('tr', kind ? 'row-' + kind : null);
const th = el('th', null, label); th.scope = 'row'; tr.appendChild(th);
cols.forEach(c => {
const raw = c.v[key];
const val = kind === 'pct' ? pctTxt(raw) : money(kind === 'cost' && raw != null ? -raw : raw);
const td = el('td', (c.ytd ? 'ytd ' : '') + ((raw != null && kind !== 'cost' && raw < 0) ? 'neg' : ''), val);
tr.appendChild(td);
});
tbody.appendChild(tr);
});
table.append(thead, tbody);
table.hidden = false; empty.hidden = true;
}
document.querySelectorAll('.pnl-range').forEach(b => b.addEventListener('click', () => {
document.querySelectorAll('.pnl-range').forEach(x => x.classList.remove('active'));
b.classList.add('active'); pnlMonths = Number(b.dataset.months) || 6; renderPnl();
}));

// ---------- Cash ----------
let cashChart = null;
function renderCashStats() {
const empty = document.getElementById('cash-empty'), table = document.getElementById('cash-table');
table.textContent = '';
if (!kpiHistory.length) { statCards('cash-stats', []); empty.hidden = false; return; }
const latest = kpiHistory[kpiHistory.length - 1];
const recent = kpiHistory.slice(-3).map(r => Number(r.expenses_mtd)).filter(v => v > 0);
const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
const cash = latest.cash == null ? null : Number(latest.cash);
const ar = latest.accounts_receivable == null ? null : Number(latest.accounts_receivable);
const ap = latest.accounts_payable == null ? null : Number(latest.accounts_payable);
const wc = (cash != null && ar != null && ap != null) ? cash + ar - ap : null;
statCards('cash-stats', [
['Cash', money(cash, { cents: true }), `As of ${fmtDate(latest.period_end, { month: 'short', day: 'numeric', year: 'numeric' })}`],
['Accounts receivable', money(ar, { cents: true }), 'Owed to you'],
['Accounts payable', money(ap, { cents: true }), 'You owe'],
['Working capital', money(wc, { cents: true }), 'Cash + receivables − payables'],
['Cash runway', (cash != null && avg) ? `${(cash / avg).toFixed(1)} mo` : '—', 'At avg monthly expenses (3 mo)'],
]);
const rows = kpiHistory.slice(-12);
const thead = el('thead'), hr = el('tr');
['Month', 'Cash', 'Change', 'Net income', 'Receivables', 'Payables'].forEach((h, i) => { const th = el('th', null, h); th.scope = 'col'; hr.appendChild(th); });
thead.appendChild(hr);
const tbody = el('tbody');
rows.slice().reverse().forEach(r => {
const idx = kpiHistory.indexOf(r), prev = idx > 0 ? kpiHistory[idx - 1] : null;
const chg = (prev && r.cash != null && prev.cash != null) ? Number(r.cash) - Number(prev.cash) : null;
const tr = el('tr');
const th = el('th', null, fmtDate(r.period_end, { month: 'short', year: 'numeric' })); th.scope = 'row'; tr.appendChild(th);
[[r.cash], [chg, true], [r.net_income_mtd, true], [r.accounts_receivable], [r.accounts_payable]].forEach(([v, signed]) => {
const n = v == null ? null : Number(v);
tr.appendChild(el('td', (signed && n != null) ? (n < 0 ? 'neg' : 'pos') : null, (signed && n != null && n > 0 ? '+' : '') + money(n)));
});
tbody.appendChild(tr);
});
table.append(thead, tbody);
empty.hidden = true;
}
function renderCashChart() {
const rows = kpiHistory.slice(-13);
if (rows.length < 1 || !window.Chart) return;
const labels = rows.map(r => fmtDate(r.period_end, { month: 'short', year: '2-digit' }));
const cash = rows.map(r => r.cash == null ? null : Number(r.cash));
const change = rows.map((r, i) => {
const idx = kpiHistory.indexOf(r), prev = idx > 0 ? kpiHistory[idx - 1] : null;
return (prev && r.cash != null && prev.cash != null) ? Number(r.cash) - Number(prev.cash) : null;
});
if (cashChart) cashChart.destroy();
const fmtAxis = (v) => `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString()}`;
cashChart = new Chart(document.getElementById('cash-chart').getContext('2d'), {
data: { labels, datasets: [
{ type: 'line', label: 'Cash balance', data: cash, borderColor: '#D4AF37', backgroundColor: 'rgba(212,175,55,0.12)', fill: true, tension: 0.25, pointRadius: 3, pointBackgroundColor: '#D4AF37', order: 1 },
{ type: 'bar', label: 'Change in cash', data: change, backgroundColor: change.map(v => (v != null && v < 0) ? 'rgba(224,122,95,0.75)' : 'rgba(111,211,164,0.6)'), maxBarThickness: 36, order: 2 },
] },
options: {
responsive: true, maintainAspectRatio: false,
plugins: { legend: { labels: { color: '#A9B3C2', boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y, { cents: true })}` } } },
scales: {
x: { ticks: { color: '#A9B3C2' }, grid: { display: false } },
y: { ticks: { color: '#A9B3C2', callback: fmtAxis }, grid: { color: (c) => c.tick && c.tick.value === 0 ? 'rgba(244,240,230,0.45)' : 'rgba(244,240,230,0.06)' } },
},
},
});
}

// ---------- Reports (deliverables we've shared) ----------
async function signedOpen(path, link) {
const label = link.textContent;
link.textContent = 'Opening…';
const { data, error } = await supabaseClient.storage.from(DOCS_BUCKET).createSignedUrl(String(path).trim(), 60);
link.textContent = label;
if (error || !data) { link.textContent = 'Error — try again'; console.error(error); return; }
window.open(data.signedUrl, '_blank', 'noopener');
}
async function loadReports() {
const box = document.getElementById('report-list');
const { data, error } = await supabaseClient
.from('documents').select('*')
.eq('client_id', currentClient.id).eq('direction', 'firm_deliverable')
.order('uploaded_at', { ascending: false });
box.textContent = '';
if (error || !data || !data.length) { box.appendChild(el('p', 'empty-note panel-empty', 'No reports shared yet. Your monthly statements and analysis will appear here.')); return; }
const groups = {};
data.forEach(d => { const k = (d.category || 'Other').trim() || 'Other'; (groups[k] = groups[k] || []).push(d); });
Object.keys(groups).forEach(cat => {
const sec = el('div', 'report-group');
sec.appendChild(el('h3', 'report-cat', cat.replace(/\b\w/g, ch => ch.toUpperCase())));
const list = el('div', 'report-rows');
groups[cat].forEach(d => {
const row = el('div', 'report-row');
const meta = el('div', 'report-meta');
meta.append(el('span', 'report-name', d.filename || 'Document'), el('span', 'report-date', new Date(d.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })));
const btn = el('a', 'btn-plain report-dl', 'Download'); btn.href = '#';
btn.addEventListener('click', (e) => { e.preventDefault(); if (d.storage_path) signedOpen(d.storage_path, btn); });
row.append(meta, btn);
list.appendChild(row);
});
sec.appendChild(list);
box.appendChild(sec);
});
}

// ---------- Billing ----------
async function loadBilling() {
const table = document.getElementById('billing-table'), empty = document.getElementById('billing-empty');
const { data, error } = await supabaseClient
.from('payments').select('*')
.eq('client_id', currentClient.id)
.order('period_end', { ascending: false });
table.textContent = '';
if (error || !data || !data.length) { statCards('billing-stats', []); empty.hidden = false; return; }
const now = new Date();
const open = data.filter(p => p.status === 'open');
const openBal = open.reduce((a, p) => a + (Number(p.amount_due) || 0) - (Number(p.amount_paid) || 0), 0);
const yr = now.getFullYear();
const paidYtd = data.filter(p => p.status === 'paid' && new Date(p.period_end || p.created_at).getFullYear() === yr)
.reduce((a, p) => a + (Number(p.amount_paid) || Number(p.amount_due) || 0), 0);
const nextDue = open.map(p => p.due_date).filter(Boolean).sort()[0];
statCards('billing-stats', [
['Open balance', money(openBal, { cents: true }), open.length ? `${open.length} open invoice${open.length > 1 ? 's' : ''}` : 'All paid'],
['Next due', nextDue ? fmtDate(nextDue, { month: 'short', day: 'numeric', year: 'numeric' }) : '—', ''],
[`Paid in ${yr}`, money(paidYtd, { cents: true }), ''],
]);
const thead = el('thead'), hr = el('tr');
['Period', 'Amount', 'Paid', 'Due', 'Status', ''].forEach(h => { const th = el('th', null, h); th.scope = 'col'; hr.appendChild(th); });
thead.appendChild(hr);
const tbody = el('tbody');
data.forEach(p => {
const tr = el('tr');
const period = p.period_start && p.period_end
? `${fmtDate(p.period_start, { month: 'short', day: 'numeric' })} – ${fmtDate(p.period_end, { month: 'short', day: 'numeric', year: 'numeric' })}`
: fmtDate(p.created_at, { month: 'short', day: 'numeric', year: 'numeric' });
const th = el('th', null, period); th.scope = 'row'; tr.appendChild(th);
tr.appendChild(el('td', null, money(p.amount_due, { cents: true })));
tr.appendChild(el('td', null, money(p.amount_paid, { cents: true })));
tr.appendChild(el('td', null, p.due_date ? fmtDate(p.due_date, { month: 'short', day: 'numeric' }) : '—'));
const overdue = p.status === 'open' && p.due_date && new Date(p.due_date) < now;
const stTd = el('td');
stTd.appendChild(el('span', 'badge ' + (p.status === 'paid' ? 'paid' : (overdue ? 'overdue' : 'open')), p.status === 'paid' ? 'Paid' : (overdue ? 'Past Due' : (p.status === 'open' ? 'Due' : String(p.status || '')))));
tr.appendChild(stTd);
const act = el('td', 'bill-actions');
const pay = safeUrl(p.hosted_invoice_url), pdf = safeUrl(p.invoice_pdf_url);
if (p.status === 'open' && pay) { const a = el('a', 'btn bill-pay', 'Pay'); a.href = pay; a.target = '_blank'; a.rel = 'noopener'; act.appendChild(a); }
if (pdf) { const a = el('a', 'bill-pdf', 'PDF'); a.href = pdf; a.target = '_blank'; a.rel = 'noopener'; act.appendChild(a); }
tr.appendChild(act);
tbody.appendChild(tr);
});
table.append(thead, tbody);
empty.hidden = true;
}

// ---------- Analyst note, month-end checklist, deadlines ----------
// Rows are written by HCM in Supabase; clients can only read their own (RLS). Rendered with textContent only.
async function loadExtras() {
const cid = currentClient.id;
const [noteRes, checkRes, dueRes] = await Promise.all([
supabaseClient.from('analyst_notes').select('period_end, note').eq('client_id', cid).order('period_end', { ascending: false }).order('created_at', { ascending: false }).limit(1),
supabaseClient.from('close_checklist').select('period_end, item, done, needs_client, sort_order').eq('client_id', cid).order('period_end', { ascending: false }).order('sort_order', { ascending: true }).limit(40),
supabaseClient.from('client_deadlines').select('title, due_date, detail, done').eq('client_id', cid).eq('done', false).order('due_date', { ascending: true }).limit(6),
]);

const note = !noteRes.error && noteRes.data && noteRes.data[0];
if (note && note.note) {
document.getElementById('note-period').textContent = fmtDate(note.period_end, { month: 'long', year: 'numeric' });
document.getElementById('note-body').textContent = note.note;
document.getElementById('note-panel').hidden = false;
}

const items = (!checkRes.error && checkRes.data) || [];
if (items.length) {
const period = items[0].period_end;
const cur = items.filter(i => i.period_end === period);
const done = cur.filter(i => i.done).length;
document.getElementById('close-title').textContent = `${fmtDate(period, { month: 'long' })} close`;
document.getElementById('close-fill').style.width = `${Math.round(done / cur.length * 100)}%`;
document.getElementById('close-count').textContent = `${done} of ${cur.length} complete`;
const list = document.getElementById('close-list');
list.textContent = '';
cur.forEach(i => {
const li = el('li', i.done ? 'done' : (i.needs_client ? 'needs-you' : 'pending'));
li.appendChild(el('span', 'ck', i.done ? '✓' : (i.needs_client ? '!' : '○')));
li.appendChild(el('span', null, i.item));
if (!i.done && i.needs_client) li.appendChild(el('span', 'ck-tag', 'Needs you'));
list.appendChild(li);
});
document.getElementById('close-card').hidden = false;
}

const dues = (!dueRes.error && dueRes.data) || [];
if (dues.length) {
const list = document.getElementById('deadline-list');
list.textContent = '';
const today = new Date(); today.setHours(0, 0, 0, 0);
dues.forEach(d => {
const li = el('li', null);
const due = new Date(d.due_date + 'T00:00:00');
const days = Math.round((due - today) / 86400000);
const when = el('span', 'dl-date ' + (days < 0 ? 'late' : (days <= 14 ? 'soon' : '')), fmtDate(d.due_date, { month: 'short', day: 'numeric' }));
const what = el('span', 'dl-what');
what.appendChild(el('span', 'dl-title', d.title));
if (d.detail) what.appendChild(el('span', 'dl-detail', d.detail));
what.appendChild(el('span', 'dl-days', days < 0 ? `${-days} day${days === -1 ? '' : 's'} past due` : (days === 0 ? 'Today' : `In ${days} day${days === 1 ? '' : 's'}`)));
li.append(when, what);
list.appendChild(li);
});
document.getElementById('deadline-card').hidden = false;
}
}
