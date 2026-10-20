const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const DOCS_BUCKET = 'client-documents';
let currentUser = null;
let currentClient = null;
let kpiHistory = [];
let trendChart = null;
let chartMetric = 'net_income_mtd';
let chartView = 'monthly';
const CHART_MONTHS = 13; // bars shown: current + trailing 12

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

const cards = [
['Cash Balance', fmt(latest.cash), ''],
['Revenue (MTD)', fmt(latest.revenue_mtd), `YTD ${fmt(latest.ytd_revenue)}`],
['Expenses (MTD)', fmt(latest.expenses_mtd), `YTD ${fmt(latest.ytd_expenses)}`],
['Net Income (MTD)', fmt(latest.net_income_mtd), `YTD ${fmt(latest.ytd_net_income)}`],
['Gross Margin', fmtPct(latest.gross_margin), `YTD ${fmtPct(latest.ytd_gross_margin)}`],
];
document.getElementById('kpi-grid').innerHTML = cards.map(([label, value, sub]) => `
<div class="kpi-card"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
`).join('');

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
const rows = kpiHistory.slice(-CHART_MONTHS);
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
// expenses are a cost, so show them in gold like the others; only negative values turn red
const barColors = values.map(v => (v != null && v < 0) ? '#C0504D' : '#D4AF37');

if (trendChart) trendChart.destroy();
const ctx = document.getElementById('trend-chart').getContext('2d');
const dataset = useLine ? {
label,
data: values,
borderColor: '#D4AF37',
backgroundColor: 'rgba(212, 175, 55, 0.1)',
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
plugins: {
legend: { display: false },
tooltip: { callbacks: { label: (c) => `${label}: ${fmtTip(c.parsed.y)}` } }
},
scales: {
x: { ticks: { color: '#E8E0C5' }, grid: useLine ? { color: 'rgba(212,175,55,0.08)' } : { display: false } },
y: {
ticks: { color: '#E8E0C5', callback: fmtAxis },
grid: { color: (c) => c.tick && c.tick.value === 0 ? 'rgba(232,224,197,0.55)' : 'rgba(212,175,55,0.08)' }
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
const path = link.dataset.path;
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
