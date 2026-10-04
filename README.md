# cm-frontend

An [Astro](https://astro.build) site deployed to [Cloudflare Workers](https://developers.cloudflare.com/workers/) via the [`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) adapter.

## Project structure

```
├── .vscode/             # recommended editor extensions/launch config
├── public/
│   ├── admin/           # Sveltia CMS (index.html + config.yml), served at /admin/
│   └── images/uploads/  # images uploaded through the CMS
├── src/
│   ├── content/
│   │   ├── home.md      # homepage content
│   │   └── pages/       # one Markdown file per page; filename = URL slug
│   ├── content.config.ts # content schemas (must match public/admin/config.yml)
│   ├── layouts/
│   │   └── Layout.astro # shared page shell (menu built from pages, footer, styles)
│   └── pages/
│       ├── robots.txt.ts # /robots.txt (points crawlers at the sitemap)
│       ├── index.astro  # / (renders src/content/home.md)
│       └── [slug].astro # /<slug>/ for each file in src/content/pages
├── astro.config.mjs     # Astro config (Cloudflare adapter)
└── wrangler.jsonc       # Cloudflare Workers config
```

## Features

| Route | What it is |
| :-- | :-- |
| `/puzzle/` | Daily puzzle (on-demand; changes 00:00 UTC), archive at `/puzzle/archive/`, JSON at `/puzzle/today.json` and `/puzzle/YYYY-MM-DD.json` |
| `/openings/` | 149 opening families → `/openings/family/<slug>/` → 3,800+ lines at `/openings/<slug>/`; JSON at `/openings.json` |
| `/analysis/` | Analysis board: Stockfish (in-browser, `public/engine/`), variations, PGN/FEN import/export, `?fen=`/`?pgn=` links |
| `/board-image/` | FEN/PGN → diagram tool; image API at `/board.svg?fen=…` (on-demand) |
| `/chess-clock/` | Client-side chess clock |
| `/coordinates-trainer/` | Client-side coordinates game |
| `/llms.txt` | Summary of tools and endpoints for AI agents |

Data sources and licences: `src/data/README.md` and `/credits/`.

## Editing content

Content is edited with [Sveltia CMS](https://sveltiacms.app) at https://chessmoments.com/admin/.
Saving in the CMS commits to `main`, which triggers a production deploy (about a minute).

- **Homepage**: fixed entry (`src/content/home.md`).
- **Pages**: add or delete pages under *Pages*. Each becomes `/<slug>/`; "Show in menu" and
  "Menu order" control the header menu.

Sign-in options: *Sign In with GitHub* (needs the `sveltia-cms-auth` Worker set in
`backend.base_url`), or *Sign In Using Access Token* with a GitHub fine-grained token that has
Contents read/write on this repo. You can also edit the Markdown files directly.

## SEO

`/sitemap-index.xml` is generated at build time by `@astrojs/sitemap` from every page, so
new CMS pages are included automatically. `/robots.txt` allows everything except `/admin/`.
Each page has a canonical link to its chessmoments.com URL, so preview copies aren't indexed
as duplicates.

## Commands

| Command                  | Action                                                   |
| :----------------------- | :------------------------------------------------------- |
| `npm install`            | Install dependencies                                     |
| `npm run dev`            | Start local dev server at `localhost:4321`               |
| `npm run build`          | Build the site to `./dist/`                              |
| `npm run preview`        | Build and preview locally in the Workers runtime         |
| `npm run deploy`         | Build and deploy to Cloudflare (`wrangler deploy`)       |
| `npm run generate-types` | Generate types for bindings in `wrangler.jsonc`          |

## Deploying

Either run `npx wrangler login` once and then `npm run deploy`, or connect the repo in the
Cloudflare dashboard (Workers & Pages → Create → Import a repository) with build command
`npm run build` and deploy command `npx wrangler deploy`.

The build command is required: `wrangler deploy` uses the server entry point that
`astro build` generates in `dist/`, and fails with "entry-point file ... was not found" without it.

Pushes to `main` deploy to production at https://chessmoments.com.

Bindings (KV, D1, R2, env vars, etc.) are configured in `wrangler.jsonc`. Local secrets go in
`.dev.vars` (git-ignored).
