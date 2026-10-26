const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { experimental: { passkey: true } } }); // passkeys (Face ID) are an opt-in Supabase feature
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
await loadFlows();
await loadLedgers();
await loadOnboarding();
showTab(location.hash.slice(1) || ((onb && onb.approved_at) || currentClient.engagement_status !== 'onboarding' ? '' : 'start'));

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
if (typeof syncTwoStepItem === 'function') syncTwoStepItem(!!factor);
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

init().then(() => { if (currentClient) { refreshMfa(); loadNotifPrefs(); loadPasskeys(); maybeAutoTour(); } });

// =====================================================================
// Tabs: Overview / P&L / Cash / Reports / Billing / Documents / Security
// Everything below renders with DOM methods and textContent only.
// =====================================================================
const TABS = ['start', 'overview', 'pnl', 'cash', 'ledgers', 'reports', 'billing', 'documents', 'security'];
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

// ---------- Cash-flow Sankey (Cash tab) ----------
// Rows come from public.cash_flow_lines: direction 'in' | 'out', category, optional subcategory, amount (>= 0).
let flowRows = [];
const FLOW_IN = '#6FA8C9', FLOW_CASH = '#D4AF37', FLOW_KEEP = '#6FD3A4', FLOW_DRAW = '#EE9273';
const FLOW_OUT = ['#E6C55A', '#8FB3E0', '#B79CE6', '#E0A16F', '#7FC7C0', '#C9B06B', '#D98FA8', '#9FB86A', '#A9B3C2'];

async function loadFlows() {
const { data, error } = await supabaseClient
.from('cash_flow_lines').select('period_end, direction, category, subcategory, amount, sort_order')
.eq('client_id', currentClient.id).order('period_end', { ascending: false }).order('sort_order', { ascending: true }).limit(2000);
if (error || !data || !data.length) return; // panel stays hidden
flowRows = data;
const periods = [...new Set(data.map(r => r.period_end))];
const sel = document.getElementById('flow-month');
sel.textContent = '';
periods.forEach(p => { const o = el('option', null, fmtDate(p, { month: 'long', year: 'numeric' })); o.value = p; sel.appendChild(o); });
sel.addEventListener('change', () => renderFlow(sel.value));
document.getElementById('flow-panel').hidden = false;
renderFlow(periods[0]);
}

function renderFlow(period) {
const rows = flowRows.filter(r => r.period_end === period && Number(r.amount) > 0);
const box = document.getElementById('flow-chart');
box.textContent = '';
const sum = (arr) => arr.reduce((a, r) => a + Number(r.amount), 0);
const group = (arr, key) => { const m = new Map(); arr.forEach(r => { const k = (r[key] || '').trim(); if (!k) return; m.set(k, (m.get(k) || 0) + Number(r.amount)); }); return [...m].map(([name, value]) => ({ name, value })); };

const ins = group(rows.filter(r => r.direction === 'in'), 'category').sort((a, b) => b.value - a.value);
const outs = group(rows.filter(r => r.direction === 'out'), 'category').sort((a, b) => b.value - a.value);
const totIn = sum(rows.filter(r => r.direction === 'in')), totOut = sum(rows.filter(r => r.direction === 'out'));
if (totOut > totIn + 0.005) ins.push({ name: 'From cash on hand', value: totOut - totIn, draw: true });
if (totIn > totOut + 0.005) outs.push({ name: 'Added to cash', value: totIn - totOut, keep: true });
const total = Math.max(totIn, totOut);
if (!total) { box.appendChild(el('p', 'empty-note panel-empty', 'No cash activity recorded for this month.')); return; }

// Optional 4th column: subcategories of each outflow category
const subs = [];
outs.forEach((o, i) => {
o.color = o.keep ? FLOW_KEEP : FLOW_OUT[i % FLOW_OUT.length];
if (o.keep) return;
const parts = group(rows.filter(r => r.direction === 'out' && (r.category || '').trim() === o.name), 'subcategory');
if (parts.length) {
const covered = parts.reduce((a, p) => a + p.value, 0);
if (o.value - covered > 0.005) parts.push({ name: 'Other', value: o.value - covered });
parts.sort((a, b) => b.value - a.value).forEach(p => subs.push({ ...p, parent: o, color: o.color }));
}
});
const cols = subs.length ? 4 : 3;

// Layout (viewBox units)
const W = 1000, PAD_T = 10, NODE_W = 14, GAP = 14, SLOT = 42; // SLOT: room for a two-line label
const xs = cols === 4 ? [0, 300, 590, 986] : [0, 430, 986];
const k = 300 / total; // the busiest column is ~300 units of flow; small items get label room via SLOT
const place = (nodes, x) => { let y = 0; nodes.forEach(n => { n.x = x; n.h = Math.max(2, n.value * k); n.y = y; y += Math.max(n.h, SLOT) + GAP; }); return y - GAP; };
const hIn = place(ins, xs[0]), hOut = place(outs, xs[2]), hSub = subs.length ? place(subs, xs[3]) : 0;
const cash = { name: 'Cash in', value: total, x: xs[1], h: total * k };
const H = Math.max(hIn, hOut, hSub, cash.h) + PAD_T * 2;
const centre = (nodes, h) => { const off = (H - h) / 2; nodes.forEach(n => n.y += off); };
centre(ins, hIn); centre(outs, hOut); if (subs.length) centre(subs, hSub);
cash.y = (H - cash.h) / 2;

const NS = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(NS, 'svg');
svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
svg.setAttribute('aria-hidden', 'true');
const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([a, v]) => e.setAttribute(a, String(v))); return e; };
const link = (x0, y0, x1, y1, h, color) => {
const xm = (x0 + x1) / 2;
const d = `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + h} C${xm},${y1 + h} ${xm},${y0 + h} ${x0},${y0 + h} Z`;
svg.appendChild(mk('path', { d, fill: color, 'fill-opacity': 0.28 }));
};
// links: inflows -> cash
let cy = cash.y;
ins.forEach(n => { const c = n.draw ? FLOW_DRAW : FLOW_IN; link(n.x + NODE_W, n.y, cash.x, cy, n.h, c); cy += n.h; });
// cash -> outflows
cy = cash.y;
outs.forEach(n => { link(cash.x + NODE_W, cy, n.x, n.y, n.h, n.color); cy += n.h; });
// outflow category -> subcategories
const offs = new Map();
subs.forEach(sn => { const p = sn.parent; const o = offs.get(p) || 0; link(p.x + NODE_W, p.y + o, sn.x, sn.y, sn.h, sn.color); offs.set(p, o + sn.h); });

// nodes + labels
const label = (n, side, color) => {
svg.appendChild(mk('rect', { x: n.x, y: n.y, width: NODE_W, height: n.h, rx: 2, fill: color }));
const tx = side === 'left' ? n.x - 10 : n.x + NODE_W + 10;
const anchor = side === 'left' ? 'end' : 'start';
const mid = n.y + n.h / 2;
const t1 = mk('text', { x: tx, y: mid - 3, 'text-anchor': anchor, class: 'flow-name' }); t1.textContent = n.name;
const t2 = mk('text', { x: tx, y: mid + 15, 'text-anchor': anchor, class: 'flow-amt' }); t2.textContent = money(n.value, { cents: true });
svg.append(t1, t2);
};
ins.forEach(n => label(n, 'right', n.draw ? FLOW_DRAW : FLOW_IN));
label(cash, 'right', FLOW_CASH);
outs.forEach(n => label(n, 'left', n.color));
subs.forEach(n => label(n, 'left', n.color));
box.appendChild(svg);

// accessible text summary
const top = outs.filter(o => !o.keep).slice(0, 3).map(o => `${o.name} ${money(o.value)}`).join(', ');
const net = totIn - totOut;
document.getElementById('flow-summary').textContent =
`${fmtDate(period, { month: 'long', year: 'numeric' })}: ${money(totIn)} came in and ${money(totOut)} went out` +
(top ? ` (largest: ${top})` : '') + `. Cash ${net >= 0 ? 'grew' : 'fell'} by ${money(Math.abs(net))}.`;
}

// =====================================================================
// Ledgers: Job Costing, Cash In, Cash Out, Checks In, Checks Out
// Clients submit; HCM posts. RLS blocks clients from posting, editing posted rows,
// writing HCM notes, or touching another client's data. Rendering uses textContent only.
// =====================================================================
const LED_KINDS = {
cash_in: { title: 'Cash In', party: 'Received from', check: false, dir: 'in' },
cash_out: { title: 'Cash Out', party: 'Paid to', check: false, dir: 'out' },
check_in: { title: 'Checks In', party: 'Received from', check: true, dir: 'in' },
check_out: { title: 'Checks Out', party: 'Paid to', check: true, dir: 'out' },
};
const CATS_IN = ['Customer payment', 'Deposit / retainer', 'Owner contribution', 'Loan', 'Refund', 'Other'];
const CATS_OUT = ['Materials & supplies', 'Subcontract labor', 'Wages / helpers', 'Fuel & vehicle', 'Equipment & tools', 'Rent & utilities', 'Insurance', 'Software & subscriptions', 'Taxes', 'Owner draw', 'Other'];
const LABOR_CATS = ['Subcontract labor', 'Wages / helpers'];
const MATERIAL_CATS = ['Materials & supplies'];
const MILE_RATE = 0.725; // IRS 2026 business standard mileage rate
let ledJobs = [], ledEntries = [], ledTime = [], ledView = 'jobs', ledEditId = null, jobEditId = null, openJobId = null;

const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const num = (v) => { const n = Number(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : NaN; };
const ledDate = (d) => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
const jobName = (id) => { const j = ledJobs.find(x => x.id === id); return j ? j.name : ''; };
const dirOf = (kind) => LED_KINDS[kind].dir;
function statusBadge(st) {
const map = { submitted: ['open', 'Submitted'], needs_info: ['overdue', 'Needs info'], posted: ['paid', 'Posted'] };
const [c, t] = map[st] || ['open', st];
return el('span', 'badge ' + c, t);
}
function th(row, labels) { labels.forEach(([t, cls]) => { const h = el('th', cls || null, t); h.scope = 'col'; row.appendChild(h); }); }

async function loadLedgers() {
const cid = currentClient.id;
const [j, e, t] = await Promise.all([
supabaseClient.from('jobs').select('*').eq('client_id', cid).order('start_date', { ascending: false }).limit(500),
supabaseClient.from('ledger_entries').select('*').eq('client_id', cid).order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(3000),
supabaseClient.from('job_time').select('*').eq('client_id', cid).order('work_date', { ascending: false }).limit(5000),
]);
ledJobs = (!j.error && j.data) || []; ledEntries = (!e.error && e.data) || []; ledTime = (!t.error && t.data) || [];
renderLedgers();
}

function renderLedgers() {
document.querySelectorAll('.led-tab').forEach(b => b.classList.toggle('active', b.dataset.led === ledView));
document.getElementById('jobs-view').hidden = ledView !== 'jobs';
document.getElementById('led-view').hidden = ledView === 'jobs';
if (ledView === 'jobs') renderJobs(); else renderLedger(ledView);
}
document.querySelectorAll('.led-tab').forEach(b => b.addEventListener('click', () => {
ledView = b.dataset.led; closeLedForm(); renderLedgers();
}));

// ---------- one ledger (cash/check in/out) ----------
function renderLedger(kind) {
const meta = LED_KINDS[kind];
document.getElementById('led-title').textContent = meta.title;
const rows = ledEntries.filter(r => r.kind === kind);
const now = new Date(); const ym = todayISO().slice(0, 7); const yr = String(now.getFullYear());
const sumIf = (fn) => rows.filter(fn).reduce((a, r) => a + Number(r.amount), 0);
statCards('led-stats', [
['This month', money(sumIf(r => r.entry_date.slice(0, 7) === ym), { cents: true }), (n => `${n} ${n === 1 ? 'entry' : 'entries'}`)(rows.filter(r => r.entry_date.slice(0, 7) === ym).length)],
[`${yr} to date`, money(sumIf(r => r.entry_date.slice(0, 4) === yr), { cents: true }), ''],
['Waiting on review', String(rows.filter(r => r.status === 'submitted').length), rows.some(r => r.status === 'needs_info') ? `${rows.filter(r => r.status === 'needs_info').length} need info from you` : ''],
]);
const table = document.getElementById('led-table'), empty = document.getElementById('led-empty');
table.textContent = '';
if (!rows.length) { empty.hidden = false; return; }
empty.hidden = true;
const thead = el('thead'), hr = el('tr');
th(hr, [['Date'], [meta.party], ['Category'], ['Job'], ['Memo'], ['Amount', 'r'], ['Receipt'], ['Status'], ['']]);
thead.appendChild(hr);
const tbody = el('tbody');
rows.forEach(r => {
const tr = el('tr', r.status === 'needs_info' ? 'row-flag' : null);
tr.appendChild(el('td', null, ledDate(r.entry_date)));
const party = el('td', null, r.party || '—');
if (r.check_number) party.appendChild(el('span', 'led-sub', ` #${r.check_number}`));
tr.appendChild(party);
tr.appendChild(el('td', null, r.category || '—'));
tr.appendChild(el('td', null, jobName(r.job_id) || '—'));
const memo = el('td', 'led-memo', r.memo || '');
if (r.status === 'needs_info' && r.hcm_note) memo.appendChild(el('span', 'led-note', `HCM: ${r.hcm_note}`));
tr.appendChild(memo);
tr.appendChild(el('td', 'r', money(r.amount, { cents: true })));
const rc = el('td');
if (r.receipt_path) { const a = el('a', 'led-link', 'View'); a.href = '#'; a.addEventListener('click', (e) => { e.preventDefault(); signedOpen(r.receipt_path, a); }); rc.appendChild(a); } else rc.textContent = '—';
tr.appendChild(rc);
const st = el('td'); st.appendChild(statusBadge(r.status)); tr.appendChild(st);
const act = el('td', 'led-act');
if (r.status !== 'posted') {
const eb = el('button', 'led-btn', 'Edit'); eb.type = 'button'; eb.addEventListener('click', () => openLedForm(kind, r));
const db = el('button', 'led-btn danger', 'Delete'); db.type = 'button'; db.addEventListener('click', () => deleteEntry(r, db));
act.append(eb, db);
}
tr.appendChild(act);
tbody.appendChild(tr);
});
table.append(thead, tbody);
}

function fillSelect(sel, options, value, blankLabel) {
sel.textContent = '';
if (blankLabel != null) { const o = el('option', null, blankLabel); o.value = ''; sel.appendChild(o); }
options.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; sel.appendChild(o); });
sel.value = value || '';
}
function openLedForm(kind, row) {
const meta = LED_KINDS[kind];
ledEditId = row ? row.id : null;
document.getElementById('lf-party-label').textContent = meta.party;
document.getElementById('lf-check-row').hidden = !meta.check;
fillSelect(document.getElementById('lf-category'), (meta.dir === 'in' ? CATS_IN : CATS_OUT).map(c => [c, c]), row ? row.category : '', 'Choose…');
fillSelect(document.getElementById('lf-job'), ledJobs.filter(j => j.status !== 'cancelled' || (row && row.job_id === j.id)).map(j => [j.id, j.name]), row ? row.job_id : '', 'No job');
document.getElementById('lf-date').value = row ? row.entry_date : todayISO();
document.getElementById('lf-amount').value = row ? Number(row.amount).toFixed(2) : '';
document.getElementById('lf-party').value = row ? (row.party || '') : '';
document.getElementById('lf-check').value = row ? (row.check_number || '') : '';
document.getElementById('lf-memo').value = row ? (row.memo || '') : '';
document.getElementById('lf-file').value = '';
document.getElementById('lf-save').textContent = row ? 'Save changes' : 'Submit';
setAlert('lf-msg', '');
document.getElementById('led-form').hidden = false;
document.getElementById('lf-amount').focus();
}
function closeLedForm() { ledEditId = null; const f = document.getElementById('led-form'); if (f) f.hidden = true; }
document.getElementById('led-new-btn').addEventListener('click', () => openLedForm(ledView, null));
document.getElementById('lf-cancel').addEventListener('click', closeLedForm);

async function uploadReceipt(file) {
if (!ALLOWED_TYPES.includes(file.type)) throw new Error('That file type isn’t accepted. Use a photo (JPG, PNG, HEIC) or a PDF.');
if (file.size > MAX_FILE_BYTES) throw new Error('That file is over the 25 MB limit.');
const path = `${currentClient.id}/receipts/${Date.now()}_${sanitizeFilename(file.name)}`;
const { error } = await supabaseClient.storage.from(DOCS_BUCKET).upload(path, file);
if (error) throw error;
return path;
}

document.getElementById('led-form').addEventListener('submit', async (e) => {
e.preventDefault();
const kind = ledView, meta = LED_KINDS[kind];
const amount = num(document.getElementById('lf-amount').value);
const date = document.getElementById('lf-date').value;
const btn = document.getElementById('lf-save');
setAlert('lf-msg', '');
if (!date) { setAlert('lf-msg', 'Enter the date.', 'error'); return; }
if (!(amount > 0)) { setAlert('lf-msg', 'Enter an amount greater than zero.', 'error'); return; }
const rec = {
kind, entry_date: date, amount: Math.round(amount * 100) / 100,
party: document.getElementById('lf-party').value.trim() || null,
check_number: meta.check ? (document.getElementById('lf-check').value.trim() || null) : null,
category: document.getElementById('lf-category').value || null,
job_id: document.getElementById('lf-job').value || null,
memo: document.getElementById('lf-memo').value.trim() || null,
status: 'submitted',
};
const label = btn.textContent;
setBusy(btn, true, 'Saving…');
try {
const file = document.getElementById('lf-file').files[0];
if (file) rec.receipt_path = await uploadReceipt(file);
const q = ledEditId
? supabaseClient.from('ledger_entries').update(rec).eq('id', ledEditId)
: supabaseClient.from('ledger_entries').insert(Object.assign({ client_id: currentClient.id }, rec));
const { error } = await q;
if (error) throw error;
closeLedForm();
await loadLedgers();
} catch (err) {
setAlert('lf-msg', (err && err.message && !/^[A-Z_]+$/.test(err.message)) ? err.message : friendlyError(err), 'error');
} finally { setBusy(btn, false, label); }
});

async function deleteEntry(r, btn) {
if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Confirm'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Delete'; }, 4000); return; }
btn.disabled = true;
const { error } = await supabaseClient.from('ledger_entries').delete().eq('id', r.id);
if (error) { btn.disabled = false; btn.textContent = 'Error'; return; }
await loadLedgers();
}

// ---------- job costing ----------
function jobRollup(j) {
const money_ = ledEntries.filter(r => r.job_id === j.id);
const rev = money_.filter(r => dirOf(r.kind) === 'in').reduce((a, r) => a + Number(r.amount), 0);
const outs = money_.filter(r => dirOf(r.kind) === 'out');
const cost = outs.reduce((a, r) => a + Number(r.amount), 0);
const mat = outs.filter(r => MATERIAL_CATS.includes(r.category)).reduce((a, r) => a + Number(r.amount), 0);
const lab = outs.filter(r => LABOR_CATS.includes(r.category)).reduce((a, r) => a + Number(r.amount), 0);
const time = ledTime.filter(t => t.job_id === j.id);
const hours = time.reduce((a, t) => a + Number(t.hours), 0);
const miles = time.reduce((a, t) => a + Number(t.miles_to) + Number(t.miles_back), 0);
const mileCost = miles * MILE_RATE;
const profit = rev - cost - mileCost;
return { rev, cost, mat, lab, other: cost - mat - lab, hours, miles, mileCost, profit, margin: rev ? profit / rev : null, perHour: hours ? profit / hours : null, entries: money_, time };
}

function renderJobs() {
const table = document.getElementById('job-table'), empty = document.getElementById('job-empty');
table.textContent = '';
const rolls = ledJobs.map(j => ({ j, r: jobRollup(j) }));
const done = rolls.filter(x => x.j.status !== 'cancelled');
const rev = done.reduce((a, x) => a + x.r.rev, 0), prof = done.reduce((a, x) => a + x.r.profit, 0);
const hrs = done.reduce((a, x) => a + x.r.hours, 0), mi = done.reduce((a, x) => a + x.r.miles, 0);
statCards('job-stats', ledJobs.length ? [
['Open jobs', String(ledJobs.filter(j => j.status === 'open').length), `${ledJobs.length} total`],
['Job profit', money(prof), rev ? `${pctTxt(prof / rev)} margin` : ''],
['Profit per hour', hrs ? money(prof / hrs, { cents: true }) : '—', `${hrs.toFixed(1)} hours logged`],
['Miles driven', mi.toFixed(0), `≈ ${money(mi * MILE_RATE)} at IRS rate`],
] : []);
if (!ledJobs.length) { empty.hidden = false; document.getElementById('job-detail').hidden = true; return; }
empty.hidden = true;
const thead = el('thead'), hr = el('tr');
th(hr, [['Job'], ['Customer'], ['Status'], ['Revenue', 'r'], ['Materials', 'r'], ['Labor', 'r'], ['Other', 'r'], ['Mileage', 'r'], ['Profit', 'r'], ['Margin', 'r'], ['Hours', 'r'], ['$/hour', 'r']]);
thead.appendChild(hr);
const tbody = el('tbody');
rolls.forEach(({ j, r }) => {
const tr = el('tr', 'job-row' + (openJobId === j.id ? ' is-open' : ''));
tr.tabIndex = 0;
const name = el('td'); const b = el('button', 'job-open', j.name); b.type = 'button'; b.addEventListener('click', () => openJob(j.id)); name.appendChild(b);
if (j.quoted_amount != null) name.appendChild(el('span', 'led-sub', ` Quoted ${money(j.quoted_amount)}`));
tr.appendChild(name);
tr.appendChild(el('td', null, j.customer || '—'));
const st = el('td'); st.appendChild(el('span', 'badge ' + (j.status === 'complete' ? 'paid' : (j.status === 'cancelled' ? 'overdue' : 'open')), j.status[0].toUpperCase() + j.status.slice(1))); tr.appendChild(st);
[[r.rev], [r.mat], [r.lab], [r.other], [r.mileCost]].forEach(([v]) => tr.appendChild(el('td', 'r', money(v))));
tr.appendChild(el('td', 'r ' + (r.profit < 0 ? 'neg' : ''), money(r.profit)));
tr.appendChild(el('td', 'r', pctTxt(r.margin)));
tr.appendChild(el('td', 'r', r.hours ? r.hours.toFixed(1) : '—'));
tr.appendChild(el('td', 'r', r.perHour == null ? '—' : money(r.perHour, { cents: true })));
tbody.appendChild(tr);
});
table.append(thead, tbody);
if (openJobId) renderJobDetail();
}

function openJob(id) { openJobId = id; document.getElementById('time-form').hidden = true; renderJobs(); document.getElementById('job-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
document.getElementById('jd-close').addEventListener('click', () => { openJobId = null; document.getElementById('job-detail').hidden = true; renderJobs(); });

function renderJobDetail() {
const j = ledJobs.find(x => x.id === openJobId);
const box = document.getElementById('job-detail');
if (!j) { box.hidden = true; return; }
const r = jobRollup(j);
document.getElementById('jd-title').textContent = j.name + (j.customer ? ` · ${j.customer}` : '');
statCards('jd-stats', [
['Revenue', money(r.rev, { cents: true }), j.quoted_amount != null ? `Quoted ${money(j.quoted_amount, { cents: true })}` : ''],
['Costs', money(r.cost + r.mileCost, { cents: true }), `incl. ${money(r.mileCost)} mileage`],
['Profit', money(r.profit, { cents: true }), r.margin == null ? '' : `${pctTxt(r.margin)} margin`],
['Hours · miles', `${r.hours.toFixed(1)} h · ${r.miles.toFixed(0)} mi`, r.perHour == null ? '' : `${money(r.perHour, { cents: true })} profit per hour`],
]);
const tt = document.getElementById('jd-time'); tt.textContent = '';
if (r.time.length) {
const h = el('thead'), hr = el('tr'); th(hr, [['Date'], ['Worker'], ['Hours', 'r'], ['Miles', 'r'], ['Notes'], ['']]); h.appendChild(hr);
const tb = el('tbody');
r.time.forEach(t => {
const tr = el('tr');
tr.appendChild(el('td', null, ledDate(t.work_date)));
tr.appendChild(el('td', null, t.worker || '—'));
tr.appendChild(el('td', 'r', Number(t.hours).toFixed(2)));
tr.appendChild(el('td', 'r', `${Number(t.miles_to)} + ${Number(t.miles_back)}`));
tr.appendChild(el('td', 'led-memo', t.notes || ''));
const act = el('td', 'led-act'); const db = el('button', 'led-btn danger', 'Delete'); db.type = 'button';
db.addEventListener('click', async () => {
if (db.dataset.armed !== '1') { db.dataset.armed = '1'; db.textContent = 'Confirm'; setTimeout(() => { db.dataset.armed = ''; db.textContent = 'Delete'; }, 4000); return; }
db.disabled = true; const { error } = await supabaseClient.from('job_time').delete().eq('id', t.id); if (error) { db.textContent = 'Error'; return; } await loadLedgers();
});
act.appendChild(db); tr.appendChild(act); tb.appendChild(tr);
});
tt.append(h, tb);
} else { const tb = el('tbody'); const tr = el('tr'); const td = el('td', 'empty-note', 'No time logged yet.'); td.colSpan = 6; tr.appendChild(td); tb.appendChild(tr); tt.appendChild(tb); }
const mt = document.getElementById('jd-money'); mt.textContent = '';
if (r.entries.length) {
const h = el('thead'), hr = el('tr'); th(hr, [['Date'], ['Type'], ['Category'], ['Amount', 'r'], ['Status']]); h.appendChild(hr);
const tb = el('tbody');
r.entries.forEach(x => {
const tr = el('tr');
tr.appendChild(el('td', null, ledDate(x.entry_date)));
tr.appendChild(el('td', null, LED_KINDS[x.kind].title));
tr.appendChild(el('td', null, x.category || '—'));
tr.appendChild(el('td', 'r ' + (dirOf(x.kind) === 'out' ? 'neg' : 'pos'), (dirOf(x.kind) === 'out' ? '−' : '+') + money(x.amount, { cents: true })));
const st = el('td'); st.appendChild(statusBadge(x.status)); tr.appendChild(st);
tb.appendChild(tr);
});
mt.append(h, tb);
} else { const tb = el('tbody'); const tr = el('tr'); const td = el('td', 'empty-note', 'Nothing tagged yet. Pick this job when you add a cash or check entry.'); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); mt.appendChild(tb); }
box.hidden = false;
}

// job form
function openJobForm(job) {
jobEditId = job ? job.id : null;
document.getElementById('jf-name').value = job ? job.name : '';
document.getElementById('jf-customer').value = job ? (job.customer || '') : '';
document.getElementById('jf-type').value = job ? (job.job_type || '') : '';
document.getElementById('jf-start').value = job ? job.start_date : todayISO();
document.getElementById('jf-end').value = job ? (job.end_date || '') : '';
document.getElementById('jf-quote').value = job && job.quoted_amount != null ? Number(job.quoted_amount).toFixed(2) : '';
document.getElementById('jf-status').value = job ? job.status : 'open';
document.getElementById('jf-notes').value = job ? (job.notes || '') : '';
document.getElementById('jf-save').textContent = job ? 'Save changes' : 'Save job';
setAlert('jf-msg', '');
document.getElementById('job-form').hidden = false;
document.getElementById('jf-name').focus();
}
document.getElementById('job-new-btn').addEventListener('click', () => openJobForm(null));
document.getElementById('jd-edit').addEventListener('click', () => { const j = ledJobs.find(x => x.id === openJobId); if (j) { openJobForm(j); document.getElementById('job-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } });
document.getElementById('jf-cancel').addEventListener('click', () => { jobEditId = null; document.getElementById('job-form').hidden = true; });
document.getElementById('job-form').addEventListener('submit', async (e) => {
e.preventDefault();
const name = document.getElementById('jf-name').value.trim();
const start = document.getElementById('jf-start').value;
const qRaw = document.getElementById('jf-quote').value.trim();
const quote = qRaw ? num(qRaw) : null;
setAlert('jf-msg', '');
if (!name) { setAlert('jf-msg', 'Give the job a name.', 'error'); return; }
if (!start) { setAlert('jf-msg', 'Enter a start date.', 'error'); return; }
if (qRaw && !(quote >= 0)) { setAlert('jf-msg', 'Quoted price must be a number.', 'error'); return; }
const rec = {
name, customer: document.getElementById('jf-customer').value.trim() || null,
job_type: document.getElementById('jf-type').value.trim() || null,
start_date: start, end_date: document.getElementById('jf-end').value || null,
quoted_amount: quote, status: document.getElementById('jf-status').value,
notes: document.getElementById('jf-notes').value.trim() || null,
};
const btn = document.getElementById('jf-save'), label = btn.textContent;
setBusy(btn, true, 'Saving…');
try {
const q = jobEditId ? supabaseClient.from('jobs').update(rec).eq('id', jobEditId) : supabaseClient.from('jobs').insert(Object.assign({ client_id: currentClient.id }, rec));
const { error } = await q; if (error) throw error;
jobEditId = null; document.getElementById('job-form').hidden = true;
await loadLedgers();
} catch (err) { setAlert('jf-msg', friendlyError(err), 'error'); }
finally { setBusy(btn, false, label); }
});

// time & miles form
document.getElementById('jd-time-btn').addEventListener('click', () => {
['tf-worker', 'tf-hours', 'tf-to', 'tf-back', 'tf-notes'].forEach(id => { document.getElementById(id).value = ''; });
document.getElementById('tf-date').value = todayISO();
setAlert('tf-msg', '');
document.getElementById('time-form').hidden = false;
document.getElementById('tf-hours').focus();
});
document.getElementById('tf-cancel').addEventListener('click', () => { document.getElementById('time-form').hidden = true; });
document.getElementById('time-form').addEventListener('submit', async (e) => {
e.preventDefault();
const hours = num(document.getElementById('tf-hours').value || 0);
const to = num(document.getElementById('tf-to').value || 0), back = num(document.getElementById('tf-back').value || 0);
const date = document.getElementById('tf-date').value;
setAlert('tf-msg', '');
if (!date) { setAlert('tf-msg', 'Enter the date.', 'error'); return; }
if (!(hours >= 0 && hours <= 24)) { setAlert('tf-msg', 'Hours must be between 0 and 24.', 'error'); return; }
if (!(to >= 0) || !(back >= 0)) { setAlert('tf-msg', 'Miles must be numbers.', 'error'); return; }
if (!hours && !to && !back) { setAlert('tf-msg', 'Enter hours, miles, or both.', 'error'); return; }
const btn = document.getElementById('tf-save'), label = btn.textContent;
setBusy(btn, true, 'Saving…');
try {
const { error } = await supabaseClient.from('job_time').insert({
client_id: currentClient.id, job_id: openJobId, work_date: date,
worker: document.getElementById('tf-worker').value.trim() || null,
hours: Math.round(hours * 100) / 100, miles_to: Math.round(to * 10) / 10, miles_back: Math.round(back * 10) / 10,
notes: document.getElementById('tf-notes').value.trim() || null,
});
if (error) throw error;
document.getElementById('time-form').hidden = true;
await loadLedgers();
} catch (err) { setAlert('tf-msg', friendlyError(err), 'error'); }
finally { setBusy(btn, false, label); }
});

// =====================================================================
// Get Started: onboarding wizard + setup checklist
// Tables: client_onboarding (progress + answers), client_profiles,
// setup_items (recommendations). Submit runs public.submit_onboarding().
// =====================================================================
const ONB_STEPS = ['About you', 'Business', 'Tax IDs', 'Money setup', 'Documents', 'Review'];
const ONB_QS = [
  { k: 'biz_checking', q: 'Do you have a business checking account?', opts: [['yes', 'Yes'], ['no', 'No']] },
  { k: 'bank_names', q: 'Which bank(s) do you use for the business?', text: 'e.g. Pinnacle Bank, Chase', hint: 'Bank names only. Never send account numbers here.' },
  { k: 'mixes_personal', q: 'Do you ever pay business expenses from a personal account or card?', opts: [['yes', 'Yes, sometimes'], ['no', 'No']] },
  { k: 'tax_savings', q: 'Do you set money aside for taxes in a separate account?', opts: [['yes', 'Yes'], ['no', 'No']] },
  { k: 'takes_cards', q: 'Can customers pay you by card or online?', opts: [['yes', 'Yes'], ['no', 'No']] },
  { k: 'processors', q: 'How do customers pay you?', multi: true, hint: 'Choose all that apply.', opts: [['stripe', 'Stripe'], ['square', 'Square'], ['paypal', 'PayPal'], ['venmo', 'Venmo / Cash App'], ['zelle', 'Zelle'], ['cash', 'Cash & checks'], ['other', 'Other']] },
  { k: 'sales_tax', q: 'Do you sell products or services that could be subject to sales tax?', opts: [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']] },
  { k: 'workers', q: 'Who works in the business?', opts: [['just_me', 'Just me'], ['contractors', 'Contractors'], ['employees', 'Employees'], ['both', 'Both']] },
  { k: 'vehicle', q: 'Do you drive for the business (jobs, supplies, clients)?', opts: [['yes', 'Yes'], ['no', 'No']] },
  { k: 'software', q: 'How do you keep your books today?', opts: [['none', 'Nothing yet'], ['spreadsheet', 'Spreadsheet'], ['quickbooks', 'QuickBooks'], ['other', 'Other software']] },
  { k: 'last_return', q: 'Has the business filed a tax return before?', opts: [['yes', 'Yes'], ['first_year', 'No, first year'], ['unsure', 'Not sure']] },
  { k: 'goals', q: 'What do you most want help with?', area: true, text: 'e.g. Knowing what I owe in taxes, cleaning up last year, getting paid faster' },
];
const ONB_DOCS = [
  { k: 'EIN letter', d: 'IRS letter CP 575 or 147C showing your EIN.' },
  { k: 'Formation documents', d: 'Articles of organization or incorporation, operating agreement.' },
  { k: 'Prior tax return', d: "Last year's business return, or your Schedule C." },
  { k: 'Bank statements', d: 'The last 3 months of business bank statements.' },
  { k: 'Sales tax permit', d: 'Only if you have one.' },
];
const PROFILE_FIELDS = ['owner_first_name', 'owner_last_name', 'owner_email', 'owner_phone', 'owner_address', 'business_legal_name', 'dba_name', 'entity_type', 'industry', 'business_email', 'business_phone', 'business_address', 'formation_state', 'formation_date', 'fiscal_year_end', 'sales_tax_permit'];

let onb = null;          // client_onboarding row (or null)
let onbProfile = {};     // client_profiles row
let onbDocs = [];        // categories uploaded
let onbStep = 1;
let setupItems = [];

async function loadOnboarding() {
  const cid = currentClient.id;
  const [o, p, d, s] = await Promise.all([
    supabaseClient.from('client_onboarding').select('*').eq('client_id', cid).maybeSingle(),
    supabaseClient.from('client_profiles').select(PROFILE_FIELDS.concat(['ein_last4', 'ssn_last4']).join(',')).eq('client_id', cid).maybeSingle(),
    supabaseClient.from('documents').select('category').eq('client_id', cid).eq('direction', 'client_upload'),
    supabaseClient.from('setup_items').select('*').eq('client_id', cid).order('sort_order').order('created_at'),
  ]);
  if (o.error && p.error) return; // tables unavailable: leave the dashboard as-is
  onb = (!o.error && o.data) || null;
  onbProfile = (!p.error && p.data) || {};
  if (!onbProfile.business_legal_name) onbProfile.business_legal_name = currentClient.business_name;
  if (!onbProfile.owner_email) onbProfile.owner_email = currentUser.email || '';
  onbDocs = ((!d.error && d.data) || []).map(r => r.category).filter(Boolean);
  setupItems = (!s.error && s.data) || [];
  onbStep = onb ? Math.min(Math.max(onb.current_step || 1, 1), 6) : 1;
  buildOnbChrome();
  renderOnb();
  renderSetupCard();
  renderOnbBanner();
}

const onbApproved = () => !!(onb && onb.approved_at);
const onbSubmitted = () => !!(onb && onb.submitted_at);

function renderOnbBanner() {
  const nav = document.getElementById('nav-start');
  const banner = document.getElementById('onb-banner');
  if (onbApproved()) { nav.hidden = true; banner.hidden = true; return; }
  nav.hidden = false;
  const done = onbSubmitted() ? 6 : Math.max(onbStep - 1, 0);
  document.getElementById('onb-banner-fill').style.width = `${Math.round(done / 6 * 100)}%`;
  if (onbSubmitted()) {
    document.getElementById('onb-banner-title').textContent = "We're reviewing your setup";
    document.getElementById('onb-banner-copy').textContent = 'Your answers are in. We\'ll reach out within two business days. You can still make changes.';
    document.getElementById('onb-banner-btn').textContent = 'View your setup';
  } else if (onb) {
    document.getElementById('onb-banner-title').textContent = 'Finish setting up your account';
    document.getElementById('onb-banner-copy').textContent = `Step ${onbStep} of 6: ${ONB_STEPS[onbStep - 1]}. Your progress is saved.`;
    document.getElementById('onb-banner-btn').textContent = 'Continue setup';
  } else {
    document.getElementById('onb-banner-title').textContent = 'Set up your account';
    document.getElementById('onb-banner-copy').textContent = 'Six short steps, about 10 minutes. Tell us about your business so we can set up your books and tax plan.';
    document.getElementById('onb-banner-btn').textContent = 'Get started';
  }
  banner.hidden = false;
}

function buildOnbChrome() {
  // stepper
  const ol = document.getElementById('onb-steps');
  ol.textContent = '';
  ONB_STEPS.forEach((name, i) => {
    const li = el('li'); li.dataset.step = String(i + 1);
    const b = el('button', 'onb-dot'); b.type = 'button';
    b.appendChild(el('span', 'onb-num', String(i + 1)));
    b.appendChild(el('span', 'onb-name', name));
    b.addEventListener('click', () => { if (i + 1 <= maxReachable()) goStep(i + 1, true); });
    li.appendChild(b); ol.appendChild(li);
  });
  // questions
  const box = document.getElementById('onb-qs');
  box.textContent = '';
  const ans = (onb && onb.answers) || {};
  ONB_QS.forEach(q => {
    const f = el('fieldset', 'onb-q'); f.dataset.k = q.k;
    f.appendChild(el('legend', null, q.q));
    if (q.hint) f.appendChild(el('p', 'onb-hint', q.hint));
    if (q.opts) {
      const row = el('div', 'chips');
      q.opts.forEach(([v, label]) => {
        const lab = el('label', 'chip');
        const inp = document.createElement('input');
        inp.type = q.multi ? 'checkbox' : 'radio'; inp.name = 'q_' + q.k; inp.value = v;
        const cur = ans[q.k];
        inp.checked = q.multi ? Array.isArray(cur) && cur.includes(v) : cur === v;
        lab.append(inp, el('span', null, label));
        row.appendChild(lab);
      });
      f.appendChild(row);
    } else {
      const inp = document.createElement(q.area ? 'textarea' : 'input');
      if (!q.area) inp.type = 'text';
      inp.name = 'q_' + q.k; inp.maxLength = q.area ? 1000 : 160; inp.placeholder = q.text || '';
      inp.className = 'onb-text'; inp.value = typeof ans[q.k] === 'string' ? ans[q.k] : '';
      inp.setAttribute('aria-label', q.q);
      f.appendChild(inp);
    }
    box.appendChild(f);
  });
  // profile fields
  document.querySelectorAll('.onb-step [name]').forEach(inp => {
    if (PROFILE_FIELDS.includes(inp.name) && onbProfile[inp.name] != null) inp.value = onbProfile[inp.name];
  });
  renderTaxIdState();
  renderOnbDocs();
}

function maxReachable() { return onbSubmitted() ? 6 : Math.max(onbStep, (onb && onb.current_step) || 1); }

function renderOnb() {
  document.querySelectorAll('.onb-step').forEach(s => { s.hidden = Number(s.dataset.step) !== onbStep; });
  document.querySelectorAll('#onb-steps li').forEach(li => {
    const n = Number(li.dataset.step);
    li.className = n === onbStep ? 'on' : (n < maxReachable() || onbSubmitted() ? 'done' : '');
    const b = li.querySelector('button');
    b.disabled = n > maxReachable();
    if (n === onbStep) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  document.getElementById('onb-count').textContent = onbSubmitted() ? 'Submitted' : `Step ${onbStep} of 6`;
  document.getElementById('onb-submitted').hidden = !onbSubmitted();
  document.getElementById('onb-back').hidden = onbStep === 1;
  const next = document.getElementById('onb-next');
  next.textContent = onbStep === 6 ? (onbSubmitted() ? 'Resubmit changes' : 'Submit') : 'Save and continue';
  document.getElementById('onb-later').hidden = onbStep === 6;
  if (onbStep === 6) renderReview();
}

function goStep(n, scroll) {
  onbStep = n; setAlert('onb-msg', ''); renderOnb();
  if (scroll) document.getElementById('onb-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function collectProfile(stepEl) {
  const out = {};
  stepEl.querySelectorAll('[name]').forEach(inp => {
    if (!PROFILE_FIELDS.includes(inp.name)) return;
    const v = inp.value.trim();
    out[inp.name] = v === '' ? null : v;
  });
  return out;
}

function collectAnswers() {
  const ans = Object.assign({}, (onb && onb.answers) || {});
  ONB_QS.forEach(q => {
    if (q.opts && q.multi) ans[q.k] = Array.from(document.querySelectorAll(`[name="q_${q.k}"]:checked`)).map(i => i.value);
    else if (q.opts) { const c = document.querySelector(`[name="q_${q.k}"]:checked`); if (c) ans[q.k] = c.value; }
    else { const v = document.querySelector(`[name="q_${q.k}"]`).value.trim(); ans[q.k] = v; }
  });
  return ans;
}

function validateStep(n) {
  const stepEl = document.querySelector(`.onb-step[data-step="${n}"]`);
  let bad = null;
  stepEl.querySelectorAll('[required]').forEach(inp => {
    const empty = !inp.value.trim();
    const badEmail = inp.type === 'email' && inp.value.trim() && !emailOk(inp.value.trim());
    inp.toggleAttribute('aria-invalid', empty || badEmail);
    if ((empty || badEmail) && !bad) bad = { inp, msg: badEmail ? 'Check the email address.' : 'Fill in the fields marked *.' };
  });
  stepEl.querySelectorAll('input[type="email"]:not([required])').forEach(inp => {
    const badEmail = inp.value.trim() && !emailOk(inp.value.trim());
    inp.toggleAttribute('aria-invalid', !!badEmail);
    if (badEmail && !bad) bad = { inp, msg: 'Check the email address.' };
  });
  if (bad) { setAlert('onb-msg', bad.msg, 'error'); bad.inp.focus(); return false; }
  return true;
}

async function saveStep(n, nextStep) {
  const cid = currentClient.id;
  const stepEl = document.querySelector(`.onb-step[data-step="${n}"]`);
  if (n <= 3) {
    const prof = collectProfile(stepEl);
    if (Object.keys(prof).length) {
      const { error } = await supabaseClient.from('client_profiles').upsert(Object.assign({ client_id: cid }, prof), { onConflict: 'client_id' });
      if (error) throw error;
      Object.assign(onbProfile, prof);
    }
  }
  const row = { client_id: cid, current_step: Math.max(nextStep, (onb && onb.current_step) || 1), answers: n === 4 ? collectAnswers() : ((onb && onb.answers) || {}) };
  const { data, error } = await supabaseClient.from('client_onboarding').upsert(row, { onConflict: 'client_id' }).select('*').single();
  if (error) throw error;
  onb = data;
}

async function onbNext(later) {
  const btn = document.getElementById(later ? 'onb-later' : 'onb-next');
  const label = btn.textContent;
  setAlert('onb-msg', '');
  if (onbStep < 6 && !validateStep(onbStep)) return;
  setBusy(btn, true, label);
  try {
    if (onbStep < 6) {
      await saveStep(onbStep, later ? onbStep : onbStep + 1);
      if (later) { setAlert('onb-msg', 'Saved. Pick up where you left off any time.', 'success'); }
      else goStep(onbStep + 1, true);
    } else {
      const { error } = await supabaseClient.rpc('submit_onboarding', { p_client: currentClient.id });
      if (error) throw error;
      await loadOnboarding();
      goStep(6, true);
      setAlert('onb-msg', 'Submitted. Thank you! Your setup checklist is ready.', 'success');
    }
    renderOnbBanner();
  } catch (e) {
    const m = (e && e.message) || '';
    setAlert('onb-msg', m.startsWith('Please add') ? m + '.' : friendlyError(e), 'error');
  } finally { setBusy(btn, false, label); renderOnb(); }
}

// ---- Tax IDs ----
function renderTaxIdState() {
  [['ein', onbProfile.ein_last4], ['ssn', onbProfile.ssn_last4]].forEach(([f, last4]) => {
    const p = document.getElementById(`onb-${f}-on`);
    p.textContent = last4 ? `On file: ending in ${last4}` : '';
    p.className = 'taxid-on' + (last4 ? ' ok' : '');
  });
}
async function saveTaxId(field, btn) {
  const inp = document.getElementById(`onb-${field}`);
  const digits = inp.value.replace(/\D/g, '');
  setAlert('onb-msg', '');
  if (digits.length !== 9) { setAlert('onb-msg', `${field.toUpperCase()} must be 9 digits.`, 'error'); inp.focus(); return; }
  const label = btn.textContent; setBusy(btn, true, label);
  try {
    if (!onb) await saveStep(3, 3);
    const { error } = await supabaseClient.rpc('set_tax_id', { p_client: currentClient.id, p_field: field, p_value: digits });
    if (error) throw error;
    inp.value = '';
    onbProfile[field + '_last4'] = digits.slice(-4);
    renderTaxIdState();
    setAlert('onb-msg', `${field.toUpperCase()} saved and encrypted.`, 'success');
  } catch (e) { setAlert('onb-msg', friendlyError(e), 'error'); }
  finally { setBusy(btn, false, label); }
}

// ---- Documents ----
function renderOnbDocs() {
  const ul = document.getElementById('onb-docs');
  ul.textContent = '';
  ONB_DOCS.forEach((doc, i) => {
    const have = onbDocs.filter(c => c === doc.k).length;
    const li = el('li', have ? 'have' : '');
    const txt = el('div', 'onb-doc-txt');
    txt.appendChild(el('span', 'onb-doc-k', doc.k));
    txt.appendChild(el('span', 'onb-doc-d', doc.d));
    li.appendChild(el('span', 'ck', have ? '✓' : '○'));
    li.appendChild(txt);
    const ctl = el('div', 'onb-doc-ctl');
    if (have) ctl.appendChild(el('span', 'onb-doc-have', have === 1 ? 'Uploaded' : `${have} uploaded`));
    const id = 'onb-file-' + i;
    const inp = document.createElement('input'); inp.type = 'file'; inp.id = id; inp.className = 'sr-file';
    inp.accept = 'image/*,application/pdf'; inp.multiple = true;
    const lab = el('label', 'btn-plain btn-sm onb-up', have ? 'Add more' : 'Upload'); lab.htmlFor = id;
    inp.addEventListener('change', () => uploadOnbDocs(doc.k, inp, lab));
    ctl.append(inp, lab);
    li.appendChild(ctl);
    ul.appendChild(li);
  });
}
async function uploadOnbDocs(category, inp, lab) {
  const files = Array.from(inp.files || []);
  if (!files.length) return;
  setAlert('onb-msg', '');
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) { setAlert('onb-msg', `${f.name} is larger than 25 MB.`, 'error'); return; }
    if (!(f.type === 'application/pdf' || f.type.startsWith('image/'))) { setAlert('onb-msg', `${f.name}: please upload a PDF or a photo.`, 'error'); return; }
  }
  lab.textContent = 'Uploading…';
  try {
    for (const f of files) {
      const path = `${currentClient.id}/onboarding/${Date.now()}_${sanitizeFilename(f.name)}`;
      const up = await supabaseClient.storage.from(DOCS_BUCKET).upload(path, f);
      if (up.error) throw up.error;
      const ins = await supabaseClient.from('documents').insert({ client_id: currentClient.id, filename: f.name, storage_path: path, category, direction: 'client_upload', status: 'pending' });
      if (ins.error) throw ins.error;
      onbDocs.push(category);
    }
    setAlert('onb-msg', `${files.length === 1 ? 'File' : files.length + ' files'} uploaded.`, 'success');
    if (typeof loadDocuments === 'function') loadDocuments();
  } catch (e) { setAlert('onb-msg', friendlyError(e), 'error'); }
  renderOnbDocs();
}

// ---- Review ----
function renderReview() {
  const dl = document.getElementById('onb-review');
  dl.textContent = '';
  const p = onbProfile, a = (onb && onb.answers) || {};
  const name = [p.owner_first_name, p.owner_last_name].filter(Boolean).join(' ');
  const yn = (v) => ({ yes: 'Yes', no: 'No', unsure: 'Not sure' }[v] || '');
  const label = (k) => { const q = ONB_QS.find(x => x.k === k); const o = q && q.opts && q.opts.find(([v]) => v === a[k]); return o ? o[1] : ''; };
  const rows = [
    ['Owner', name, 1, true], ['Email', p.owner_email || p.business_email, 1, true], ['Phone', p.owner_phone, 1],
    ['Business', p.business_legal_name ? p.business_legal_name + (p.dba_name ? ` (DBA ${p.dba_name})` : '') : '', 2, true], ['Entity type', p.entity_type, 2, true],
    ['Industry', p.industry, 2], ['Business address', p.business_address, 2],
    ['EIN', p.ein_last4 ? `Ending in ${p.ein_last4}` : '', 3], ['SSN', p.ssn_last4 ? `Ending in ${p.ssn_last4}` : '', 3],
    ['Business checking', yn(a.biz_checking), 4], ['Tax savings account', yn(a.tax_savings), 4], ['Takes card payments', yn(a.takes_cards), 4],
    ['Who works in the business', label('workers'), 4], ['Sales tax', yn(a.sales_tax), 4],
    ['Documents', `${new Set(onbDocs.filter(c => ONB_DOCS.some(d => d.k === c))).size} of ${ONB_DOCS.length} uploaded`, 5],
  ];
  rows.forEach(([k, v, step, req]) => {
    const missing = !v || !String(v).trim();
    const dt = el('dt', null, k);
    const dd = el('dd', missing && req ? 'need' : (missing ? 'muted' : ''));
    dd.appendChild(el('span', null, missing ? (req ? 'Required' : (step === 4 ? 'Not answered' : 'Not provided')) : String(v)));
    const edit = el('button', 'link-edit', 'Edit'); edit.type = 'button';
    edit.setAttribute('aria-label', `Edit ${k}`);
    edit.addEventListener('click', () => goStep(step, true));
    dd.appendChild(edit);
    dl.append(dt, dd);
  });
}

// ---- Setup checklist (rail) ----
const SETUP_DONE_SHOW_DAYS = 14; // after everything is done, show "Setup complete" this long, then hide the card
function renderSetupCard() {
  const card = document.getElementById('setup-card');
  if (!setupItems.length) { card.hidden = true; return; }
  const live = setupItems.filter(i => i.status !== 'skipped');
  const done = live.filter(i => i.status === 'done').length;
  card.classList.toggle('setup-complete', live.length > 0 && done === live.length);
  if (live.length && done === live.length) {
    const last = Math.max(...live.map(i => Date.parse(i.completed_at || i.created_at) || 0));
    if (Date.now() - last > SETUP_DONE_SHOW_DAYS * 864e5) { card.hidden = true; return; }
  }
  document.getElementById('setup-fill').style.width = `${live.length ? Math.round(done / live.length * 100) : 0}%`;
  document.getElementById('setup-count').textContent = live.length && done === live.length ? `All ${live.length} done. Your setup is complete.` : `${done} of ${live.length} complete`;
  const list = document.getElementById('setup-list');
  list.textContent = '';
  live.slice().sort((x, y) => (x.status === 'done') - (y.status === 'done') || x.sort_order - y.sort_order).forEach(i => {
    const isDone = i.status === 'done';
    const li = el('li', isDone ? 'done' : (i.owner === 'client' ? 'needs-you' : 'pending'));
    if (i.owner === 'client' && i.key !== 'two_step') {
      const b = el('button', 'ck ck-btn', isDone ? '✓' : '○'); b.type = 'button';
      b.setAttribute('aria-label', isDone ? `Mark "${i.title}" not done` : `Mark "${i.title}" done`);
      b.addEventListener('click', () => toggleSetupItem(i, b));
      li.appendChild(b);
    } else li.appendChild(el('span', 'ck', isDone ? '✓' : '○'));
    const t = el('span', 'setup-txt');
    t.appendChild(el('span', 'setup-title', i.title));
    if (i.detail && !isDone) t.appendChild(el('span', 'setup-detail', i.detail));
    if (i.key === 'two_step' && !isDone) { const a = el('a', 'setup-link', 'Go to Security →'); a.href = '#security'; t.appendChild(a); }
    li.appendChild(t);
    if (!isDone) li.appendChild(el('span', 'ck-tag' + (i.owner === 'hcm' ? ' hcm' : ''), i.owner === 'hcm' ? 'HCM' : 'You'));
    list.appendChild(li);
  });
  card.hidden = false;
}
// Two-step item follows the account's real 2-step state (Security tab).
async function syncTwoStepItem(on) {
  const item = setupItems.find(i => i.key === 'two_step');
  if (!item || item.status === 'skipped' || (item.status === 'done') === on) return;
  const { data, error } = await supabaseClient.from('setup_items').update({ status: on ? 'done' : 'open' }).eq('id', item.id).select('*').single();
  if (!error && data) { Object.assign(item, data); renderSetupCard(); }
}
async function toggleSetupItem(item, btn) {
  btn.disabled = true;
  const status = item.status === 'done' ? 'open' : 'done';
  const { data, error } = await supabaseClient.from('setup_items').update({ status }).eq('id', item.id).select('*').single();
  btn.disabled = false;
  if (error) return;
  Object.assign(item, data);
  renderSetupCard();
}

// ---- wiring ----
document.getElementById('onb-next').addEventListener('click', () => onbNext(false));
document.getElementById('onb-later').addEventListener('click', () => onbNext(true));
document.getElementById('onb-back').addEventListener('click', () => goStep(Math.max(onbStep - 1, 1), true));
document.querySelectorAll('[data-taxid]').forEach(b => b.addEventListener('click', () => saveTaxId(b.dataset.taxid, b)));
document.querySelectorAll('.onb-step').forEach(f => f.addEventListener('submit', (e) => { e.preventDefault(); onbNext(false); }));

// ---------- Email notification preferences (Security tab) ----------
async function loadNotifPrefs() {
  const { data } = await supabaseClient.from('notification_prefs').select('reminders, updates').eq('user_id', currentUser.id).maybeSingle();
  document.getElementById('np-reminders').checked = data ? data.reminders : true;
  document.getElementById('np-updates').checked = data ? data.updates : true;
}
async function saveNotifPrefs() {
  const reminders = document.getElementById('np-reminders').checked;
  const updates = document.getElementById('np-updates').checked;
  const { error } = await supabaseClient.from('notification_prefs').upsert({ user_id: currentUser.id, reminders, updates, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  setAlert('np-msg', error ? friendlyError(error) : 'Saved.', error ? 'error' : 'success');
}
['np-reminders', 'np-updates'].forEach(id => document.getElementById(id).addEventListener('change', saveNotifPrefs));

// ---------- Face ID / passkeys (Security tab) ----------
async function passkeysEnabled() {
  if (!window.PublicKeyCredential) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_ANON_KEY } });
    return r.ok && !!(await r.json()).passkeys_enabled;
  } catch (e) { return false; }
}
async function loadPasskeys() {
  if (!(await passkeysEnabled())) return;
  document.getElementById('pk-panel').hidden = false;
  const list = document.getElementById('pk-list');
  const { data, error } = await supabaseClient.auth.passkey.list();
  list.textContent = '';
  if (error) { setAlert('pk-msg', friendlyError(error), 'error'); return; }
  const keys = data || [];
  if (!keys.length) { list.appendChild(el('li', 'pk-empty', 'No passkeys yet.')); return; }
  keys.forEach(k => {
    const li = el('li', 'pk-item');
    const t = el('span', 'pk-txt');
    t.appendChild(el('strong', null, k.friendly_name || 'Passkey'));
    t.appendChild(el('span', 'notif-hint', `Added ${fmtDate(k.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}` + (k.last_used_at ? ` · last used ${fmtDate(k.last_used_at, { month: 'short', day: 'numeric' })}` : '')));
    const rm = el('button', 'btn-plain btn-sm', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove ${k.friendly_name || 'passkey'}`);
    let armed = false;
    rm.addEventListener('click', async () => {
      if (!armed) { armed = true; rm.textContent = 'Click again to remove'; setTimeout(() => { armed = false; rm.textContent = 'Remove'; }, 5000); return; }
      rm.disabled = true;
      const { error: e2 } = await supabaseClient.auth.passkey.delete({ passkeyId: k.id });
      if (e2) { setAlert('pk-msg', friendlyError(e2), 'error'); rm.disabled = false; return; }
      setAlert('pk-msg', 'Passkey removed.', 'success');
      loadPasskeys();
    });
    li.append(t, rm);
    list.appendChild(li);
  });
}
document.getElementById('pk-add-btn').addEventListener('click', async () => {
  const btn = document.getElementById('pk-add-btn');
  setAlert('pk-msg', '');
  btn.disabled = true;
  const { error } = await supabaseClient.auth.registerPasskey();
  btn.disabled = false;
  if (error) {
    const m = String(error.code || error.message || '');
    setAlert('pk-msg', /abort|cancel|NotAllowed/i.test(m) ? 'Cancelled. Nothing was added.' : (/exist|duplicate|InvalidState/i.test(m) ? 'This device already has a passkey for your account.' : friendlyError(error)), 'error');
    return;
  }
  setAlert('pk-msg', 'Done. Next time, tap “Sign in with Face ID or passkey” on the login page.', 'success');
  loadPasskeys();
});

// ---------- Book a call (Calendly inside the portal) ----------
const CALENDLY = 'https://calendly.com/jorgen-hansencapitalmanagement/30min';
function openBooking() {
  const dlg = document.getElementById('book-dlg');
  const frame = document.getElementById('book-frame');
  if (!frame.src) {
    const p = new URLSearchParams({ embed_domain: location.hostname, embed_type: 'Inline', hide_gdpr_banner: '1', hide_landing_page_details: '1',
      background_color: '0a1424', text_color: 'f4f0e6', primary_color: 'd4af37' });
    const prof = (typeof onbProfile === 'object' && onbProfile) || {};
    const name = [prof.owner_first_name, prof.owner_last_name].filter(Boolean).join(' ');
    if (name) p.set('name', name);
    if (currentUser && currentUser.email) p.set('email', currentUser.email);
    frame.src = `${CALENDLY}?${p.toString()}`;
  }
  if (typeof dlg.showModal === 'function') dlg.showModal(); else window.open(CALENDLY, '_blank', 'noopener');
}
document.getElementById('book-btn').addEventListener('click', (e) => {
  if (typeof HTMLDialogElement === 'undefined') return; // old browsers: follow the link
  e.preventDefault(); openBooking();
});
document.getElementById('book-close').addEventListener('click', () => document.getElementById('book-dlg').close());
document.getElementById('book-dlg').addEventListener('click', (e) => { if (e.target.id === 'book-dlg') e.target.close(); });

// ---------- Product tour ----------
const TOUR = [
  { sel: '.portal-nav a[href="#overview"]', title: 'Your numbers at a glance', text: 'Overview shows your latest month: revenue, expenses, net income, cash and runway, with trends and a note from us each month.' },
  { sel: '.portal-nav a[href="#pnl"]', title: 'Profit & loss', text: 'Your income statement month by month, with year-to-date totals.' },
  { sel: '.portal-nav a[href="#cash"]', title: 'Cash', text: 'Where your money went each month, and how your cash balance is trending.' },
  { sel: '.portal-nav a[href="#ledgers"]', title: 'Ledgers', text: 'Log cash and checks, jobs, hours and miles here. We review every entry and post it to your books.' },
  { sel: '.portal-nav a[href="#reports"]', title: 'Reports', text: 'Your monthly financial package and analyses land here. We’ll email you when something new is posted.' },
  { sel: '.portal-nav a[href="#documents"]', title: 'Documents', text: 'Send us receipts, statements and anything else. Everything is stored encrypted.' },
  { sel: '.portal-nav a[href="#security"]', title: 'Security', text: 'Turn on two-step verification, add Face ID, and choose which emails you get.' },
  { sel: '#book-card', title: 'Questions? Book a call', text: 'Pick a time with us right here, any time you want to go over your numbers or plan for taxes.' },
];
let tourI = 0, tourLastFocus = null;
function tourShow(i) {
  tourI = i;
  const s = TOUR[i];
  const target = document.querySelector(s.sel);
  if (!target || target.offsetParent === null) { if (i < TOUR.length - 1) return tourShow(i + 1); return tourEnd(true); }
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  document.getElementById('tour-step').textContent = `${i + 1} of ${TOUR.length}`;
  document.getElementById('tour-title').textContent = s.title;
  document.getElementById('tour-text').textContent = s.text;
  document.getElementById('tour-back').hidden = i === 0;
  document.getElementById('tour-next').textContent = i === TOUR.length - 1 ? 'Done' : 'Next';
  requestAnimationFrame(() => tourPlace(target));
}
function tourPlace(target) {
  const r = target.getBoundingClientRect(), pad = 6;
  const ring = document.getElementById('tour-ring'), card = document.getElementById('tour-card');
  Object.assign(ring.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const cw = Math.min(360, window.innerWidth - 32), ch = card.offsetHeight || 180;
  let top = r.bottom + 14;
  if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
  const left = Math.min(Math.max(16, r.left + r.width / 2 - cw / 2), window.innerWidth - cw - 16);
  Object.assign(card.style, { top: `${top}px`, left: `${left}px`, width: `${cw}px` });
  document.getElementById('tour-next').focus();
}
function tourStart() {
  if (location.hash && location.hash !== '#overview') location.hash = '#overview';
  tourLastFocus = document.activeElement;
  document.getElementById('tour').hidden = false;
  document.body.classList.add('touring');
  tourShow(0);
}
async function tourEnd(done) {
  document.getElementById('tour').hidden = true;
  document.body.classList.remove('touring');
  if (tourLastFocus && tourLastFocus.focus) tourLastFocus.focus();
  try { localStorage.setItem('hcm_tour_done', '1'); } catch (e) { /* private mode */ }
  if (!(currentUser.user_metadata || {}).tour_done) {
    const { data } = await supabaseClient.auth.updateUser({ data: { tour_done: true } });
    if (data && data.user) currentUser = data.user;
  }
}
document.getElementById('tour-next').addEventListener('click', () => (tourI < TOUR.length - 1 ? tourShow(tourI + 1) : tourEnd(true)));
document.getElementById('tour-back').addEventListener('click', () => tourShow(Math.max(0, tourI - 1)));
document.getElementById('tour-skip').addEventListener('click', () => tourEnd(false));
document.getElementById('tour-btn').addEventListener('click', tourStart);
document.addEventListener('keydown', (e) => {
  if (document.getElementById('tour').hidden) return;
  if (e.key === 'Escape') tourEnd(false);
  else if (e.key === 'ArrowRight') document.getElementById('tour-next').click();
  else if (e.key === 'ArrowLeft' && tourI > 0) tourShow(tourI - 1);
});
window.addEventListener('resize', () => { if (!document.getElementById('tour').hidden) tourShow(tourI); });

// First visit: once setup is submitted (or not needed), show the tour on the Overview tab.
function maybeAutoTour() {
  let seen = false;
  try { seen = localStorage.getItem('hcm_tour_done') === '1'; } catch (e) { /* ignore */ }
  if (seen || (currentUser.user_metadata || {}).tour_done) return;
  const setupPending = typeof onb !== 'undefined' && currentClient.engagement_status === 'onboarding' && !(onb && (onb.submitted_at || onb.approved_at));
  const onOverview = !location.hash || location.hash === '#overview';
  if (!setupPending && onOverview) setTimeout(tourStart, 600);
}
