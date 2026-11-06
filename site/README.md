# Open CRM landing page

A static page: `index.html`, `favicon.svg`, `og.png` and `assets/app.png`. It has no build step. The CSS and the small copy-button script are inline, and fonts load from Google Fonts.

## Run it in Docker

The `Dockerfile` serves the files with `nginx:1.27-alpine`. It listens on `$PORT` (default `8080`), gzips text, caches `/assets/` for a year, sends `no-cache` for `index.html`, and answers `GET /health` with `200 ok`.

```bash
cd site
docker build -t opencrm-site .
docker run --rm -p 8080:8080 opencrm-site   # http://localhost:8080
docker run --rm -e PORT=9000 -p 9000:9000 opencrm-site   # any other port
```

## Deploy as a separate service

**Railway:** in the same project as the app, choose **New → GitHub Repo**, then pick this repo again. In the service's **Settings**, set **Root Directory** to `site`. Railway detects the `Dockerfile` and injects `PORT`. Set the health check path to `/health`, then generate a domain under **Networking**.

**Render:** create a **Web Service** from the repo with **Runtime: Docker** and **Root Directory: `site`**. Render injects `PORT`. Set **Health Check Path** to `/health`.

You can also use Render's free **Static Site** type with no Docker: set Root Directory to `site`, leave the build command empty and set Publish Directory to `.`.

**Any static host:** upload the contents of `site/` (skip `screenshots/`, `Dockerfile` and `nginx.conf.template`). This works on GitHub Pages, Netlify, Cloudflare Pages or an S3 bucket. To preview locally, run `npx serve site`.

## Files

- `index.html`: the page
- `assets/app.png`: product screenshot (1440×900 at 2x, light theme, default indigo accent)
- `og.png`: 1200×630 social card
- `Dockerfile`, `nginx.conf.template`, `.dockerignore`: the container
- `screenshots/`: reference renders of the page (excluded from the image)
