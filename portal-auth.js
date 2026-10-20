/*
 * Hansen Capital Management - shared client-portal helpers.
 * Loaded on login.html, reset-password.html and dashboard.html only.
 *
 *  - Frame-busting: the portal must never load inside another site's frame.
 *  - Two-step verification (TOTP authenticator apps) via Supabase MFA.
 *  - CAPTCHA (Cloudflare Turnstile): switched on only when TURNSTILE_SITE_KEY
 *    is filled in (supabase-config.js). Turn it on in Supabase AFTER this code is live.
 *  - Shared form helpers (messages, field errors, busy buttons, friendly errors).
 */

// ---------- Clickjacking protection ----------
if (window.top !== window.self) {
  try { window.top.location = window.self.location.href; } catch (e) { document.documentElement.style.display = 'none'; }
}

// ---------- Small DOM helpers ----------
const $ = (id) => document.getElementById(id);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const PW_RULES = [
  ['len', (p) => p.length >= 12],
  ['upper', (p) => /[A-Z]/.test(p)],
  ['lower', (p) => /[a-z]/.test(p)],
  ['num', (p) => /\d/.test(p)],
];
const passwordOk = (p) => PW_RULES.every(([, test]) => test(p));
function updateRules(p) {
  PW_RULES.forEach(([key, test]) => { const li = $('rule-' + key); if (li) li.classList.toggle('ok', test(p)); });
}

function friendlyError(err) {
  const m = ((err && err.message) || '').toLowerCase();
  const status = err && err.status;
  if (status === 429 || m.includes('rate limit') || m.includes('too many'))
    return 'Too many attempts. Please wait a few minutes, then try again.';
  if (m.includes('captcha'))
    return 'Please complete the security check, then try again.';
  if (m.includes('invalid login credentials'))
    return 'That email and password don’t match our records. Check for typos, or use “Forgot password?” below.';
  if (m.includes('email not confirmed'))
    return 'Please confirm your email first — check your inbox for the confirmation link.';
  if (m.includes('invalid totp') || m.includes('invalid code') || (m.includes('code') && m.includes('invalid')) || m.includes('mfa'))
    return 'That code didn’t work. Codes change every 30 seconds — enter the current one from your authenticator app.';
  if (m.includes('should be different'))
    return 'Your new password must be different from your current one.';
  if (m.includes('signups not allowed') || m.includes('signup is disabled'))
    return 'New accounts are set up by Hansen Capital Management. Please contact us to get access.';
  if (m.includes('password'))
    return 'That password doesn’t meet the requirements. Use at least 12 characters with uppercase and lowercase letters and a number.';
  if (m.includes('failed to fetch') || m.includes('network'))
    return 'We couldn’t reach the server. Check your internet connection and try again.';
  return 'Something went wrong. Please try again, or email general@hansencapitalmanagement.com.';
}

function setAlert(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'form-alert' + (cls ? ' ' + cls : '');
}
function fieldError(id, msg) {
  const input = $(id), el = $(id + '-error');
  if (msg) { input.setAttribute('aria-invalid', 'true'); if (el) el.textContent = msg; }
  else { input.removeAttribute('aria-invalid'); if (el) el.textContent = ''; }
}
function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.textContent = '';
  if (busy) { const sp = document.createElement('span'); sp.className = 'spinner'; sp.setAttribute('aria-hidden', 'true'); btn.appendChild(sp); }
  btn.appendChild(document.createTextNode(label));
}

// ---------- Two-step verification ----------
const hcmAuth = {
  /** True when the user has a verified authenticator but this session hasn't entered a code yet. */
  async needsSecondStep(client) {
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return false;
    return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
  },
  async verifiedFactor(client) {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    return (data.totp || []).find((f) => f.status === 'verified') || null;
  },
  async verifyCode(client, code) {
    const factor = await this.verifiedFactor(client);
    if (!factor) throw new Error('No authenticator app is set up for this account.');
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) throw error;
  },
};

// ---------- CAPTCHA (Cloudflare Turnstile) ----------
const hcmCaptcha = {
  enabled: typeof TURNSTILE_SITE_KEY === 'string' && TURNSTILE_SITE_KEY.length > 0,
  token: null,
  widget: null,
  mount(elId) {
    if (!this.enabled) return;
    const el = $(elId);
    el.hidden = false;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => {
      this.widget = window.turnstile.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'dark',
        callback: (t) => { this.token = t; },
        'expired-callback': () => { this.token = null; },
        'error-callback': () => { this.token = null; },
      });
    };
    document.head.appendChild(s);
  },
  ready() { return !this.enabled || !!this.token; },
  token_() { return this.enabled ? this.token : undefined; },
  reset() {
    if (this.enabled && window.turnstile && this.widget !== null) { window.turnstile.reset(this.widget); this.token = null; }
  },
};
