import { defineConfig } from 'astro/config';

// Static build — no adapter needed for Cloudflare Pages (it serves the
// generated /dist folder directly). Once the final domain/subdomain is
// confirmed, set `site` below so canonical URLs / future sitemaps resolve
// correctly.
export default defineConfig({
  output: 'static',
  // site: 'https://REPLACE-WITH-FINAL-DOMAIN.com',
});
