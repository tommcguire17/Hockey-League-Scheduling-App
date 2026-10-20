# Putting the console online

The console is static files. It runs entirely in the browser, has no server
and no database, and never uploads anything — season files are opened and
saved from your own machine. That makes it free to host almost anywhere.

## Before the first push

**Check nothing in `data/` is about to be committed.** That folder holds real
season files and is already gitignored, but verify once:

```bash
git status --porcelain          # data/ must not appear
git ls-files | grep -i season   # should return nothing
```

CI fails the build if player data is ever committed, but it is cheaper to
catch it here.

## GitHub Pages

You already have an account and know the tool, so this is the right choice.
One thing to understand before you start:

> **A Pages site is public even when the repository is private.** The repo can
> hide the source; it cannot hide the published page. And on the free plan,
> Pages only works from a **public** repository at all — private-repo Pages
> needs Pro or Team.

That is fine here, because the console ships no data. It is an empty tool
until you open a file on your own computer. The only thing the world can see
is the code.

> ## The one mistake that keeps happening
>
> **There are two files called `index.html` in this repository.**
>
> | | size | what it is |
> |---|---|---|
> | `apps/web/index.html` | ~2 KB | the development page. Holds no app code. |
> | `dist/index.html` | ~250 KB | the built console. This is the one to publish. |
>
> Uploading the unzipped source folder into the same repository as the site
> flattens the folders, and the small one lands on top of the big one. The
> site then serves a page with an empty `<div id="root">` and a script tag
> pointing at TypeScript, which no browser can run — a blank page with the
> right title.
>
> Two ways to be sure you have the right one. **Check the size**: if the file
> you are uploading is under 10 KB it is the wrong one. And **open it first**:
> the development page now says *"This is the development page"* in plain
> words rather than showing nothing.
>
> Keep the source and the site in separate repositories, or put the site in a
> `docs/` folder, and the collision cannot happen at all.

### The short way: one file, no build

If you only want the console online and do not care about CI, this takes two
minutes and has nothing that can fail:

1. Run `npm run build:single`. It writes **`dist/index.html`** — the whole
   console in one file, about 200 KB, with no other assets to upload.
2. Put that `index.html` at the **root** of the repository.
3. Add an empty file named **`.nojekyll`** next to it. Create it through
   GitHub's **Add file → Create new file** box, typing `.nojekyll` as the
   name and leaving the body empty. Do not try to drag it in — see the trap
   below.
4. **Settings → Pages → Source: Deploy from a branch**, branch **`main`**,
   folder **`/ (root)`**. Not `/docs`: there is no `docs` folder, and Pages
   pointed at one fails the build with
   `No such file or directory @ dir_chdir0 - /github/workspace/docs`.

That is it. No Actions run, nothing to go wrong.

> **The dot-folder trap.** macOS and Windows hide files and folders whose name
> starts with a dot, and GitHub's drag-and-drop uploader skips them outright.
> So `.github/`, `.nojekyll` and `.gitignore` are in the zip but will NOT
> arrive if you upload by dragging the unzipped folder into the browser. That
> is why a repo can look complete and still have no workflow in the Actions
> tab. Either push with `git`, which sends everything, or create those files
> through **Add file → Create new file**.

### The full way: push the repo and let CI build

1. Create the repository on GitHub. Public is fine and is what the free plan
   needs. Call it something like `league-app`.

2. From the unzipped folder:

   ```bash
   git init
   git add -A
   git commit -m "League app: engine, importers, console"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/league-app.git
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages → Build and deployment → Source:
   GitHub Actions**. Not "Deploy from a branch" — the workflow in
   `.github/workflows/deploy.yml` handles it.

4. Push, or run the workflow by hand from the **Actions** tab. It typechecks,
   runs every test, builds, and only then publishes. A failing build never
   reaches the site.

   If the Actions tab is empty, `.github/` never arrived — see the dot-folder
   trap above. Push with `git` rather than the browser uploader.

5. The site lands at `https://YOUR-USERNAME.github.io/league-app/`. The first
   deploy takes a few minutes; later ones are under a minute.

### Using it with your own data

Open the site, click **Open season**, and pick a `.season.json` from your
machine. Nothing leaves your computer. Work, then **Save season** to download
it back. Keep those files wherever you keep the rest of your league records —
they are the real data and they do not belong in the repo.

To start from scratch rather than an existing season file:

```bash
npm install
npx tsx tools/js/build-msl.ts ice.csv teams.csv data/new.season.json blackouts.csv
```

## What it will cost

Nothing, by a wide margin.

| | this project | the limit |
|---|---|---|
| Repository | 104 KB | 1 GB recommended |
| Published site | 46 KB gzipped | 1 GB |
| Bandwidth per visit | 46 KB | ~100 GB a month |

That is roughly 2.2 million page loads a month before the soft bandwidth
limit is in sight.

## If you would rather not make the repo public

Three alternatives, all free:

- **Cloudflare Pages** — connect a private GitHub repo, free tier, no public
  source. Build command `npm run build:web`, output directory
  `apps/web/dist`.
- **Netlify** — same idea, same settings.
- **No host at all** — run `npm run build:web` and open
  `apps/web/dist/index.html` straight off your computer. It works from the
  file system because the build uses relative paths. Zero accounts, zero
  hosting, and nobody else can reach it.

That last one is worth taking seriously for a tool only you use. The reason to
host it is so a coworker can open it without installing anything.

## A sensible first real test

1. Deploy, open the site, and load your real season file.
2. Go to **Checks** and confirm it reads the same as it does locally.
3. Change one thing — move a game, enter a score — and **Save season**.
4. Reopen the saved file and confirm the change survived the round trip.
5. Export the SportNinja CSV and upload **five rows** to SportNinja before the
   whole file. The column order is now pinned to their template, but their
   importer is the only thing that settles it.
