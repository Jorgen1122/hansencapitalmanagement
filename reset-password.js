// Set a new password from a reset (or invite) email link.
// Helpers come from portal-auth.js.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let recoveryReady = false;
async function checkSecondStep() {
  // Accounts with two-step verification must enter a code before changing the password.
  if (await hcmAuth.needsSecondStep(supabaseClient)) $('mfa-row').hidden = false;
}
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY' || (session && event === 'SIGNED_IN')) { recoveryReady = true; checkSecondStep(); }
});
supabaseClient.auth.getSession().then(({ data }) => {
  if (data.session) { recoveryReady = true; checkSecondStep(); }
});

$('password').addEventListener('input', (e) => { updateRules(e.target.value); fieldError('password', ''); });
$('confirm').addEventListener('input', () => fieldError('confirm', ''));
$('mfa-code').addEventListener('input', () => fieldError('mfa-code', ''));

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('password').value;
  const confirm = $('confirm').value;
  const needCode = !$('mfa-row').hidden;
  const code = $('mfa-code').value.replace(/\s/g, '');
  const btn = $('submit-btn');
  setAlert('message', '');

  let bad = false;
  if (!passwordOk(password)) { fieldError('password', 'Your new password doesn’t meet all the requirements below.'); bad = true; }
  if (!confirm) { fieldError('confirm', 'Re-enter your new password.'); bad = true; }
  else if (password !== confirm) { fieldError('confirm', 'Passwords don’t match.'); bad = true; }
  if (needCode && !/^\d{6}$/.test(code)) { fieldError('mfa-code', 'Enter the 6-digit code from your authenticator app.'); bad = true; }
  if (bad) { document.querySelector('[aria-invalid="true"]').focus(); return; }

  if (!recoveryReady) {
    setAlert('message', 'This reset link is invalid or has expired. Request a new one from the login page.', 'error');
    return;
  }

  setBusy(btn, true, 'Updating password…');
  try {
    if (needCode) await hcmAuth.verifyCode(supabaseClient, code);
    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) throw error;
    setAlert('message', 'Password updated. Redirecting you to log in…', 'success');
    await supabaseClient.auth.signOut();
    setTimeout(() => { window.location.href = 'login.html'; }, 1800);
  } catch (err) {
    setAlert('message', friendlyError(err), 'error');
    setBusy(btn, false, 'Update Password');
  }
});
