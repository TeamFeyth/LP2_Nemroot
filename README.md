# Nemroot — Landing Page 2 (Astro)

## Copy policy for this repo

**Every user-visible string on this page is reproduced verbatim from Section 5 of
the build spec** (`Nemroot_Landing_Pages.md` / `.pdf`). Nothing has been reworded.
The HTML draft (`lp2-html.html`) was used only as the reference for layout and
visual design — where the draft's wording differs from the spec, **the spec wins**.

This matters especially on this page: the `lp2-html.html` draft still carries the
old framing in which Nemroot's founder owns Kayalar Motors ("He Ran a Lot. Then He
Built the Tool He Wished He Had", "the dealership the dealer who built this ran").
The spec explicitly retired that framing — Section 5 / 7 notes: *"both the .docx
and HTML draft previously implied Nemroot's founder owns Kayalar Motors. Both
versions have been rewritten to frame Kayalar Motors as a client case study
instead."* **This build follows the spec. None of the founder-ownership language
appears on the page.**

All page copy lives in `src/pages/index.astro`, commented with its spec section number.

## Contradictions in the source, reproduced as written

The spec contradicts itself in two places. Both are reproduced exactly as
specified rather than silently reconciled, because both are listed as open items
for the client to decide:

- **The "120" stat.** The stats bar (Section 5 / 6) labels it `Test drives booked`.
  The proof section (Section 5 / 7) labels it `Leads converted (copy doc)`. The
  page therefore shows a different label in each place. Open Item #5 asks which
  ships.
- **Testimonial 3.** LP2's spec gives the short wording ("...so well.") while LP1's
  spec gives the long one ("...5 stars for innovation and reliability."). Each page
  uses its own. Open Item #4 asks which ships.

Also note Section 5 / 11 puts the sentence `Built for the showroom.` in the
**eyebrow** slot and `Why Dealers Choose Nemroot` in the **heading** slot — the
reverse of LP1's pattern. Built as specified.

## Stack

Astro, static output. No adapter needed for Cloudflare Pages.

## Local development

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # outputs to /dist
npm run preview
```

## Deploying to Cloudflare Pages

- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Framework preset:** Astro

## What's implemented

- **Meta Pixel** (`2302599970275699`) in `<head>`, `PageView` on load, `Lead` on submit.
- **Popup** — desktop exit-intent (`clientY < 10`) + mobile scroll-depth (>65%),
  firing **once per page load**, exactly as the spec describes for this page
  (`ONCE_PER_SESSION = false` in `interactions.js`). No progressive reveal on this
  page — the spec only specifies that for LP1. Open Item #6 asks whether
  once-per-page-load is sufficient or a session rule is wanted; flip the constant
  if so.
- **Form** — exactly the six fields the spec lists. No extra fields.
- **"Check the Numbers"** button scrolls to the stats bar (`.sbar`) per Section 5 / 2.
- **Hidden fields** for the CRM handoff: `form_source`, `page_url`, `timestamp`,
  and the full UTM set.
- Footer phone is a `tel:` link (Open Item #8).

## ⚠️ Open Items — unresolved, carried over from the spec

1. **Confirmation copy and thank-you URL** ("blank — not specified"). A minimal
   placeholder is in place, marked in `LeadForm.astro`. **Replace before launch.**
2. **No SMS/call consent language despite collecting phone numbers.** The spec says
   consent language "needs to be added and approved"; it has not been, so nothing
   has been put on the form. Legal/TCPA exposure to resolve before paid traffic.
3. Confirm the "120" label (Open Item #5) and testimonial wording (Open Item #4).
4. Privacy Policy, Terms of Service and Sitemap links have no destinations (`#`).
5. **CRM endpoint** — `sendLeadToCRM()` in `interactions.js` is a no-op stub.
   Submissions are not stored anywhere yet.
6. GTM / GA4 / CallRail / Search Console IDs — commented placeholders in
   `BaseLayout.astro`.

## Meta Conversions API token

The build doc included a Meta Conversions API **access token**. It is a server-side
secret and this project is fully static, so **the token is not in this project**.
Store it as an encrypted Cloudflare Pages environment variable and call the
Conversions API from a Pages Function when the CRM work happens.
