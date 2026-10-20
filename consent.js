/*
 * Hansen Capital Management - cookie consent + Google Analytics loader.
 *
 * Google Analytics is NOT loaded until the visitor clicks "Accept".
 * Declining (or a browser Global Privacy Control signal) keeps it off.
 * The choice is stored in this browser only; the "Cookie settings"
 * link in the footer reopens the banner so visitors can change it.
 *
 * Never include this file on client portal pages (login, dashboard,
 * reset-password): no portal activity is sent to Google.
 */
(function () {
  'use strict';

  var GA_ID = 'G-W88KZQ73YL';
  var KEY = 'hcm_cookie_consent'; // 'granted' | 'denied'
  var loaded = false;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });

  function readChoice() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function saveChoice(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* private mode: choice lasts this page only */ }
  }

  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
  }

  /* Lead events: only sent when the visitor has accepted analytics. */
  window.hcmTrack = function (name, params) {
    if (loaded) window.gtag('event', name, params || {});
  };

  function buildBanner() {
    var wrap = document.createElement('div');
    wrap.className = 'cookie-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-live', 'polite');
    wrap.setAttribute('aria-label', 'Cookie preferences');

    var p = document.createElement('p');
    p.appendChild(document.createTextNode(
      'We use analytics cookies (Google Analytics) to understand how visitors use this site. ' +
      'We do not use advertising cookies. You can change your choice at any time. '
    ));
    var a = document.createElement('a');
    a.href = '/privacy-policy.html#cookies';
    a.textContent = 'Privacy Policy';
    p.appendChild(a);

    var btns = document.createElement('div');
    btns.className = 'cookie-actions';
    var decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'cookie-btn';
    decline.textContent = 'Decline';
    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'cookie-btn';
    accept.textContent = 'Accept';
    btns.appendChild(decline);
    btns.appendChild(accept);

    wrap.appendChild(p);
    wrap.appendChild(btns);

    decline.addEventListener('click', function () {
      saveChoice('denied');
      wrap.remove();
      // Analytics already running this page? Stop it from setting further cookies.
      if (loaded) window.gtag('consent', 'update', { analytics_storage: 'denied' });
    });
    accept.addEventListener('click', function () {
      saveChoice('granted');
      wrap.remove();
      loadAnalytics();
    });
    return wrap;
  }

  function showBanner() {
    if (document.querySelector('.cookie-banner')) return;
    document.body.appendChild(buildBanner());
  }

  function init() {
    var choice = readChoice();
    var gpc = navigator.globalPrivacyControl === true;

    if (choice === 'granted') {
      loadAnalytics();
    } else if (choice === null) {
      if (gpc) {
        saveChoice('denied'); // honor the browser's opt-out signal without asking
      } else {
        showBanner();
      }
    }

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-cookie-settings]')) {
        e.preventDefault();
        showBanner();
        return;
      }
      var link = t.closest('a[href^="tel:"], a[href^="mailto:"]');
      if (link) {
        window.hcmTrack(link.href.indexOf('tel:') === 0 ? 'phone_click' : 'email_click', { link_url: link.href });
      }
    });

    window.addEventListener('message', function (e) {
      if (e.origin === 'https://calendly.com' && e.data && e.data.event === 'calendly.event_scheduled') {
        window.hcmTrack('generate_lead', { method: 'calendly' });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
