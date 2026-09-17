// Nemroot landing page — shared client-side behaviour.
// Radio-pill visual state is pure CSS (:checked + label). Everything here
// covers what CSS can't: the popup lifecycle, progressive field reveal,
// phone formatting, hidden UTM/context fields, validation and the
// inline success state + pixel event on submit.

/* ---------------------------------------------------------------- */
/* Lead relay (Nemroot-lead-relay Apps Script)                       */
/* Fill these in after deploying the script. See the tutorial.       */
/* The token is not a secret that protects data — it only stops      */
/* casual junk POSTs. Never put a CRM credential in this file.       */
/* ---------------------------------------------------------------- */

const LEAD_RELAY_URL = 'https://script.google.com/macros/s/AKfycbzCGZt2T0Qgko8AZTNIrbt3B3pYI_q5gX_FNaIgr2ja9ZHhKGF2MlPCQcyBUVTQBvvmVw/exec';   // https://script.google.com/macros/s/AKfyc.../exec
const LEAD_RELAY_TOKEN = '06d06061235f440381700994f024573e'; // value printed by setup() in the Apps Script editor
const LANDING_PAGE_ID = 'LP2';

const SESSION_KEY = 'nemroot_popup_autoshown';

// LP2 spec, Section 5 / 4: "fires once per page load (fired flag), not
// explicitly once-per-session". Open Item #6 asks whether that is sufficient.
const ONCE_PER_SESSION = false;

function ready(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn);
}

ready(() => {
  initHiddenFields();
  initPhoneFormatting();
  initPopup();
  initProgressiveReveal();
  initFormSubmission();
  initScrollToTriggers();
});

/* ---------------------------------------------------------------- */
/* Hidden context fields (form source is set at render time already) */
/* ---------------------------------------------------------------- */

function initHiddenFields() {
  const params = new URLSearchParams(window.location.search);
  const now = new Date().toISOString();

  document.querySelectorAll('[data-hidden-field]').forEach((el) => {
    const key = el.dataset.hiddenField;
    if (key === 'page_url') el.value = window.location.href;
    else if (key === 'timestamp') el.value = now;
    else if (key.startsWith('utm_')) el.value = params.get(key) || '';
    // Google and Meta click IDs, so paid clicks stay attributable and
    // offline conversions can be imported back later.
    else if (key === 'gclid') el.value = params.get('gclid') || params.get('gbraid') || params.get('wbraid') || '';
    else if (key === 'fbclid') el.value = params.get('fbclid') || '';
  });
}

/* ---------------------------------------------------------------- */
/* Phone auto-formatting: (XXX) XXX-XXXX as the user types           */
/* ---------------------------------------------------------------- */

function initPhoneFormatting() {
  document.querySelectorAll('[data-phone-input]').forEach((input) => {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 10);
      let formatted = digits;
      if (digits.length > 6) formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      else if (digits.length > 3) formatted = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
      else if (digits.length > 0) formatted = `(${digits}`;
      input.value = formatted;
    });
  });
}

/* ---------------------------------------------------------------- */
/* Popup: manual open/close is always available; the automatic       */
/* exit-intent / scroll-depth triggers fire at most once per session */
/* ---------------------------------------------------------------- */

function initPopup() {
  const overlay = document.querySelector('[data-popup-overlay]');
  if (!overlay) return;

  const openPopup = () => {
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    const firstField = overlay.querySelector('input, button');
    if (firstField) firstField.focus();
  };

  const closePopup = () => {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  };

  document.querySelectorAll('[data-open-popup]').forEach((el) => {
    el.addEventListener('click', openPopup);
  });
  document.querySelectorAll('[data-close-popup]').forEach((el) => {
    el.addEventListener('click', closePopup);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closePopup(); }
    });
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closePopup();
  });

  // Automatic triggers — gated to once per browser session so returning
  // visitors (or anyone who already dismissed it) aren't interrupted again.
  let autoFired = false;
  const alreadyShownThisSession = () => {
    if (!ONCE_PER_SESSION) return false;
    try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
  };
  const markShown = () => {
    autoFired = true;
    if (!ONCE_PER_SESSION) return;
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* private mode etc. */ }
  };

  if (!alreadyShownThisSession()) {
    // Desktop: exit-intent (cursor leaves toward the top of the viewport)
    document.addEventListener('mouseleave', (e) => {
      if (autoFired || alreadyShownThisSession()) return;
      if (window.innerWidth >= 768 && e.clientY < 10) {
        markShown();
        setTimeout(openPopup, 300);
      }
    });

    // Mobile: scroll-depth past ~65%
    window.addEventListener('scroll', () => {
      if (autoFired || alreadyShownThisSession()) return;
      if (window.innerWidth >= 768) return;
      const scrollable = document.body.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const pct = (window.scrollY / scrollable) * 100;
      if (pct > 65) {
        markShown();
        setTimeout(openPopup, 300);
      }
    }, { passive: true });
  }
}

/* ---------------------------------------------------------------- */
/* Progressive field reveal — only active on forms marked            */
/* data-progressive="true" (the LP1 popup, per the build spec)       */
/* ---------------------------------------------------------------- */

function initProgressiveReveal() {
  document.querySelectorAll('form[data-progressive="true"]').forEach((form) => {
    form.addEventListener('change', (e) => {
      const groupId = e.target?.dataset?.progressiveGroup;
      if (!groupId) return;
      revealIfAnswered(form, groupId);
    });
  });
}

function revealIfAnswered(form, groupId) {
  const gatedInputs = form.querySelectorAll(`[data-progressive-group="${groupId}"]`);
  const names = new Set(Array.from(gatedInputs).map((el) => el.name));
  const allAnswered = Array.from(names).every((name) => form.querySelector(`[name="${cssEscape(name)}"]:checked`));
  if (!allAnswered) return;
  const target = document.getElementById(groupId);
  if (target && target.classList.contains('reveal-hidden')) {
    target.classList.remove('reveal-hidden');
    const focusTarget = target.querySelector('input:not([type=hidden]), button');
    if (focusTarget) focusTarget.focus();
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value;
}

/* ---------------------------------------------------------------- */
/* Scroll-to triggers (e.g. LP2's "Check the Numbers" button)        */
/* ---------------------------------------------------------------- */

function initScrollToTriggers() {
  document.querySelectorAll('[data-scroll-to]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = document.querySelector(el.dataset.scrollTo);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

/* ---------------------------------------------------------------- */
/* Validation + submit                                                */
/* ---------------------------------------------------------------- */

function initFormSubmission() {
  document.querySelectorAll('form[data-lead-form]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const errorEl = form.querySelector('[data-form-error]');
      if (!validate(form)) {
        if (errorEl) errorEl.classList.add('show');
        return;
      }
      if (errorEl) errorEl.classList.remove('show');
      handleValidSubmit(form);   // async; errors surface inside the function
    });
  });
}

function validate(form) {
  let valid = true;

  const radioNames = new Set(Array.from(form.querySelectorAll('input[type=radio]')).map((r) => r.name));
  radioNames.forEach((name) => {
    if (!form.querySelector(`[name="${cssEscape(name)}"]:checked`)) valid = false;
  });

  form.querySelectorAll('input[type=text]').forEach((f) => {
    const filled = f.value.trim().length > 0;
    f.classList.toggle('field-error', !filled);
    if (!filled) valid = false;
  });

  const phone = form.querySelector('[data-phone-input]');
  if (phone) {
    const digits = phone.value.replace(/\D/g, '');
    const ok = digits.length >= 10;
    phone.classList.toggle('field-error', !ok);
    if (!ok) valid = false;
  }

  return valid;
}

async function handleValidSubmit(form) {
  const fields = form.querySelector('.lead-form-fields');
  const success = form.querySelector('[data-form-success]');
  const errorEl = form.querySelector('[data-form-error]');
  const submitBtn = form.querySelector('.field-submit');

  const originalLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
  }

  const delivered = await sendLead(buildPayload(form));

  if (!delivered) {
    // The lead did not reach the relay. Keep the form filled in so the
    // person can retry rather than losing what they typed.
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
    if (errorEl) {
      // PLACEHOLDER copy — Open Item #1 (confirmation/error wording is
      // "blank — not specified" in the build doc). Replace once approved.
      errorEl.textContent = "That didn't go through. Please try again, or call (346) 666-7377.";
      errorEl.classList.add('show');
    }
    return;
  }

  if (fields) fields.classList.add('hide');
  if (success) success.classList.add('show');

  // Client-side Meta Pixel event.
  if (typeof window.fbq === 'function') {
    window.fbq('track', 'Lead', { content_name: form.dataset.formSource || 'unknown' });
  }
}

/**
 * Flattens the form into the payload the relay expects. The three qualifying
 * radios are named per form instance (hero_seats, popup_seats...), so they are
 * normalized to stable keys here.
 */
function buildPayload(form) {
  const raw = Object.fromEntries(new FormData(form).entries());
  const variant = form.dataset.formSource || 'unknown';

  return {
    token: LEAD_RELAY_TOKEN,
    landing_page: LANDING_PAGE_ID,
    form_source: variant,

    first_name: raw.first_name || '',
    phone: raw.phone || '',
    dealership_name: raw.dealership_name || '',

    seats: raw[`${variant}_seats`] || '',
    monthly_leads: raw[`${variant}_leads`] || '',
    ad_platforms: raw[`${variant}_platforms`] || '',

    utm_source: raw.utm_source || '',
    utm_medium: raw.utm_medium || '',
    utm_campaign: raw.utm_campaign || '',
    utm_content: raw.utm_content || '',
    utm_term: raw.utm_term || '',
    gclid: raw.gclid || '',
    fbclid: raw.fbclid || '',

    page_url: raw.page_url || window.location.href,
    submitted_at: raw.timestamp || new Date().toISOString(),
    user_agent: navigator.userAgent,

    hp: raw.hp || '',
  };
}

/**
 * Posts the lead to the Nemroot-lead-relay Apps Script, which writes the
 * backup row to Google Sheets and emails Nemroot's intake address.
 *
 * Content-Type is text/plain on purpose: it keeps this inside the CORS
 * "simple request" rules, so the browser skips the preflight OPTIONS call
 * that Apps Script web apps cannot answer. The body is still JSON.
 *
 * Returns true only when the relay confirms it handled the lead.
 */
async function sendLead(payload) {
  if (!LEAD_RELAY_URL) {
    console.warn('[nemroot] LEAD_RELAY_URL is not set — lead not sent:', payload);
    return false;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(LEAD_RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data && data.ok) return true;

      console.error('[nemroot] relay rejected the lead:', data && data.error);
      return false;
    } catch (err) {
      console.error(`[nemroot] relay attempt ${attempt + 1} failed:`, err);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
    }
  }

  return false;
}
