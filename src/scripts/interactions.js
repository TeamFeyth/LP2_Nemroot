// Nemroot landing page — shared client-side behaviour.
// Radio-pill visual state is pure CSS (:checked + label). Everything here
// covers what CSS can't: the popup lifecycle, progressive field reveal,
// phone formatting, hidden UTM/context fields, validation and the
// inline success state + pixel event on submit.

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
      handleValidSubmit(form);
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

function handleValidSubmit(form) {
  const fields = form.querySelector('.lead-form-fields');
  const success = form.querySelector('[data-form-success]');
  if (fields) fields.classList.add('hide');
  if (success) success.classList.add('show');

  // Client-side Meta Pixel event — safe to fire today (no backend needed).
  if (typeof window.fbq === 'function') {
    window.fbq('track', 'Lead', { content_name: form.dataset.formSource || 'unknown' });
  }

  const payload = Object.fromEntries(new FormData(form).entries());
  sendLeadToCRM(payload);
}

// TODO: wire up once the Nemroot CRM endpoint exists (Section 2 of the
// build spec — endpoint URL, payload format and auth are all still
// pending). Keep this a no-op stub until then; do not add a fetch() call
// with a hardcoded secret in this file — any CRM auth token must live
// server-side (a Cloudflare Pages Function / Worker), never in client JS.
function sendLeadToCRM(payload) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info('[nemroot] lead captured (CRM endpoint not yet configured):', payload);
  }
}
