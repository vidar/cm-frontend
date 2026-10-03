# cm-frontend

An [Astro](https://astro.build) site deployed to [Cloudflare Workers](https://developers.cloudflare.com/workers/) via the [`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) adapter.

## Project structure

```
├── .vscode/             # recommended editor extensions/launch config
├── public/              # static assets (served as-is)
├── src/
│   ├── layouts/
│   │   └── Layout.astro # shared page shell (nav, footer, styles)
│   └── pages/
│       ├── index.astro  # /
│       └── about.astro  # /about
├── astro.config.mjs     # Astro config (Cloudflare adapter)
└── wrangler.jsonc       # Cloudflare Workers config
```

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
