# Nemroot — Landing Page 2 (Astro)

"Proven at a Real Dealership" — Kayalar Motors case-study angle.

## Stack

Astro (static output, no adapter needed) — ships as plain HTML/CSS/JS, works
out of the box on Cloudflare Pages. Shares the exact same design system,
component patterns and `interactions.js` behaviour as LP1 — this is a
separate repo/deploy, not a shared package, per the two GitHub repos in the
build spec.

## Local development

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # outputs to /dist
npm run preview   # serve the production build locally
```

## Deploying to Cloudflare Pages

Connect this repo in Cloudflare Pages and use:

- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Framework preset:** Astro

No environment variables are required for the current build.

## Project structure

```
src/
  layouts/BaseLayout.astro   <head> boilerplate, fonts, Meta Pixel, tracking placeholders
  components/                one component per page section, incl. CaseStudy.astro (LP2-only)
  scripts/interactions.js    popup, progressive reveal, phone formatting, validation, submit
  styles/global.css          shared design tokens (color/type/radius) + base elements
  pages/index.astro          assembles the page (Hero → Case Study → Stats → Proof → Problem → ...)
```

## What's already wired up

- **Meta Pixel** (`2302599970275699`) — loaded in `<head>`, fires `PageView` on load and a
  `Lead` event on every successful form submit (hero / bottom / popup).
- **Popup triggers** — desktop exit-intent + mobile scroll-depth (>65%), same as the original
  draft, but now gated to fire **at most once per browser session** (`sessionStorage`) instead
  of once per page load. Manual "See How It Works" clicks always open it regardless.
- No progressive reveal on this popup — the build spec only calls for that on LP1's popup, so
  this one shows all fields at once, matching its own spec and its original draft.
- **TCPA/SMS consent checkbox** — added to all three form instances with standard consent
  copy, since the doc flagged phone numbers being collected with no consent language. **Legal/
  compliance should review and approve the exact wording** before launch.
- **Hidden fields** on every form: `form_source` (hero/bottom/popup), `page_url`, `timestamp`,
  and `utm_source/medium/campaign/content/term` — ready for the CRM integration.
- **Inline success state** in place of a redirect, since there's no CRM endpoint or thank-you
  URL yet.
- Footer phone number is a working `tel:` link. Phone inputs auto-format as you type.
- The "120" stat is labeled **"Test drives booked"** everywhere on this page (stats bar and
  proof grid both), instead of "Leads converted" as one copy-doc cell suggested — the doc
  itself uses "Test drives booked" for the same number in the stats bar section, so this
  keeps the page internally consistent. Flag it if "Leads converted" was actually intended.
- FAQ section uses the eyebrow/heading pair ("Let's Be Straight With You" / "Good questions.
  Honest answers.") that's already in both HTML drafts, rather than the plain "FAQ" heading
  in this page's own copy table.

## ⚠️ Content calls worth a second look

- **Meta description rewritten.** The copy doc's description ("A 30-year dealer built Nemroot
  to fix his own lead problem first...") restates the founder-owns-Kayalar framing that the
  doc says was deliberately removed elsewhere on this page (Kayalar is presented everywhere
  else as an independent client, not a founder-owned lot). Shipping that line in the meta
  description would contradict the corrected page content, so it's been rewritten to:
  "Proven at a real Houston dealership before anywhere else. One inbox, 14-second response,
  automatic follow-up. Live in 24 to 48 hours. 30-day full refund."
- **Secondary CTA heading kept as-is** ("The Dealer Who Built This Was Losing the Same Leads
  You Are.") — it's consistent across both the docx and the HTML draft, so it's been left
  alone, but it sits close to the same founder/dealer territory as the line above. Worth a
  quick sanity check from whoever owns the Kayalar-as-client messaging.

## ⚠️ Still needs input before this goes live

1. **Domain / subdomain** this deploys to, and the Cloudflare Pages project/worker name.
2. **CRM endpoint URL, auth, and payload format** — `sendLeadToCRM()` in `interactions.js`
   is a no-op stub marked with a `TODO` until this exists.
3. **GTM / GA4 / CallRail / Search Console IDs** — placeholders with the correct placement
   are already commented into `BaseLayout.astro`; drop the real IDs/snippets in and
   uncomment.
4. **Thank-you page URL**, if a redirect is preferred over the inline success message.
5. **Exact TCPA consent copy** — see above.
6. **Privacy Policy / Terms of Service / Sitemap** URLs (footer links are `#` placeholders).

## A note on the Meta Conversions API token

The build doc included a Meta Conversions API **access token**. That's a server-side secret,
not a snippet — it must never ship in client/static code (this project is 100% static, so
anything in this repo is publicly visible in the browser). It has **not** been placed
anywhere in this project. When the CRM/CAPI integration is built, store it as an encrypted
Cloudflare Pages environment variable and call the Conversions API from a server-side
function (a Cloudflare Pages Function), never from the browser.
