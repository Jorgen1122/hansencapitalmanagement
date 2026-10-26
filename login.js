// Client portal login. Helpers ($, setAlert, fieldError, setBusy, friendlyError,
// hcmAuth, hcmCaptcha) come from portal-auth.js.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { experimental: { passkey: true } } }); // passkeys (Face ID) are an opt-in Supabase feature

hcmCaptcha.mount('captcha');

function showMfaStep() {
  $('auth-form').hidden = true;
  $('forgot-row').hidden = true;
  $('new-client-row').hidden = true;
  $('mfa-form').hidden = false;
  $('form-title').textContent = 'Two-Step Verification';
  $('mfa-code').focus();
}

// Already signed in? Finish the second step if needed, otherwise go straight to the dashboard.
(async () => {
  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) return;
  if (await hcmAuth.needsSecondStep(supabaseClient)) showMfaStep();
  else window.location.href = 'dashboard.html';
})();

$('email').addEventListener('input', () => fieldError('email', ''));
$('password').addEventListener('input', () => fieldError('password', ''));
$('mfa-code').addEventListener('input', () => fieldError('mfa-code', ''));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  const btn = $('submit-btn');
  setAlert('message', '');

  let bad = false;
  if (!emailOk(email)) { fieldError('email', 'Enter a valid email address.'); bad = true; }
  if (!password) { fieldError('password', 'Enter your password.'); bad = true; }
  if (bad) { document.querySelector('[aria-invalid="true"]').focus(); return; }
  if (!hcmCaptcha.ready()) { setAlert('message', 'Please complete the security check above the button.', 'error'); return; }

  setBusy(btn, true, 'Signing in…');
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email, password, options: { captchaToken: hcmCaptcha.token_() },
    });
    hcmCaptcha.reset();
    if (error) throw error;
    if (await hcmAuth.needsSecondStep(supabaseClient)) {
      setBusy(btn, false, 'Log In');
      showMfaStep();
      return;
    }
    setBusy(btn, true, 'Opening your dashboard…');
    window.location.href = 'dashboard.html';
  } catch (err) {
    setAlert('message', friendlyError(err), 'error');
    setBusy(btn, false, 'Log In');
  }
});

$('mfa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('mfa-code').value.replace(/\s/g, '');
  const btn = $('mfa-btn');
  setAlert('mfa-message', '');
  if (!/^\d{6}$/.test(code)) { fieldError('mfa-code', 'Enter the 6-digit code from your authenticator app.'); $('mfa-code').focus(); return; }
  setBusy(btn, true, 'Verifying…');
  try {
    await hcmAuth.verifyCode(supabaseClient, code);
    setBusy(btn, true, 'Opening your dashboard…');
    window.location.href = 'dashboard.html';
  } catch (err) {
    setAlert('mfa-message', friendlyError(err), 'error');
    setBusy(btn, false, 'Verify');
    $('mfa-code').select();
  }
});

$('mfa-cancel').addEventListener('click', async (e) => {
  e.preventDefault();
  await supabaseClient.auth.signOut();
  window.location.reload();
});

$('forgot-link').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  if (!emailOk(email)) {
    fieldError('email', 'Enter the email for your account, then click “Forgot password?” again.');
    $('email').focus();
    return;
  }
  if (!hcmCaptcha.ready()) { setAlert('message', 'Please complete the security check, then click “Forgot password?” again.', 'error'); return; }
  const link = $('forgot-link');
  link.setAttribute('aria-busy', 'true');
  link.textContent = 'Sending reset link…';
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://www.hansencapitalmanagement.com/reset-password.html',
      captchaToken: hcmCaptcha.token_(),
    });
    hcmCaptcha.reset();
    if (error) throw error;
    setAlert('message', 'If that email has an account, a reset link is on its way. It can take a few minutes to arrive.', 'success');
  } catch (err) {
    setAlert('message', friendlyError(err), 'error');
  } finally {
    link.removeAttribute('aria-busy');
    link.textContent = 'Forgot password?';
  }
});

// ---------- Other ways to sign in: Face ID / passkey, Google ----------
// The login page asks Supabase which methods are switched on, so a button only appears once
// that method is configured (Authentication → Providers / Passkeys).
(async () => {
  let s = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_ANON_KEY } });
    if (r.ok) s = await r.json();
  } catch (e) { /* offline: keep password only */ }
  if (!s) return;
  const passkeys = !!s.passkeys_enabled && !!window.PublicKeyCredential;
  const google = !!(s.external && s.external.google);
  $('passkey-btn').hidden = !passkeys;
  $('google-btn').hidden = !google;
  $('alt-login').hidden = !(passkeys || google);
})();

$('passkey-btn').addEventListener('click', async () => {
  const btn = $('passkey-btn');
  setAlert('message', '');
  if (!hcmCaptcha.ready()) { setAlert('message', 'Please complete the security check above, then try Face ID again.', 'error'); return; }
  btn.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signInWithPasskey({ options: { captchaToken: hcmCaptcha.token_() } });
    hcmCaptcha.reset();
    if (error) throw error;
    if (await hcmAuth.needsSecondStep(supabaseClient)) { btn.disabled = false; showMfaStep(); return; }
    window.location.href = 'dashboard.html';
  } catch (err) {
    const m = String((err && (err.code || err.message)) || '');
    if (/abort|cancel|NotAllowed/i.test(m)) setAlert('message', 'Face ID was cancelled. Try again, or log in with your password.', 'error');
    else if (/not.?found|no.?credential|unknown/i.test(m)) setAlert('message', 'No passkey found for this device. Log in with your password, then add Face ID under Security.', 'error');
    else setAlert('message', friendlyError(err), 'error');
    btn.disabled = false;
  }
});

$('google-btn').addEventListener('click', async () => {
  setAlert('message', '');
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'https://www.hansencapitalmanagement.com/login.html', queryParams: { prompt: 'select_account' } },
  });
  if (error) setAlert('message', friendlyError(error), 'error');
});

// Coming back from Google with an error (e.g. no HCM account for that email)
(() => {
  const q = new URLSearchParams(location.hash.slice(1) || location.search);
  const desc = q.get('error_description');
  if (!desc) return;
  const noAccount = /signup|not allowed|disabled/i.test(desc);
  setAlert('message', noAccount
    ? 'That Google account isn’t linked to a Hansen Capital Management login. Sign in with the email we invited you with, or contact us.'
    : 'Google sign-in didn’t finish. Try again, or log in with your password.', 'error');
  history.replaceState(null, '', location.pathname);
})();
