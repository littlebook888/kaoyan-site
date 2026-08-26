# Canonical Git and Sites deployment

## Repository roles

- `origin/main` is the only canonical source history. Local `main` tracks it.
- The OpenAI Sites source repository uses its own `main`, but that branch must
  contain the exact same commits as canonical `main`. It is a mirror target,
  not a second place to develop or reconcile changes.
- OpenAI Sites saved versions and production deployments are build artifacts.
  They do not define source history.
- GitHub Pages deploys the `dist-pages` artifact from canonical `main`; it does
  not use a `gh-pages` source branch.

Never create an orphan commit, initialize a temporary repository, replay a
patch on a snapshot, or force-push a generated tree during normal deployment.

## Safe update and deployment sequence

1. Update and publish canonical source normally:

   ```bash
   git pull --ff-only
   git push
   ```

2. Obtain a short-lived OpenAI Sites source-repository credential. Fetch its
   `main` into `refs/remotes/sites/main` without storing the credential in Git
   configuration.
3. Verify the exact source and history before publishing:

   ```bash
   pnpm run check:deployment-history
   ```

4. Push the current canonical commit to the Sites source repository with a
   normal fast-forward `HEAD:main` push. Do not use `--force` or
   `--force-with-lease` during routine deployment.
5. Build, package, save, and deploy the Sites version using that exact pushed
   commit SHA.

The check intentionally fails when either remote ref was not fetched, the two
histories have no merge base, the local source is not exactly `origin/main`, or
the Sites source branch cannot fast-forward. Resolve the source-history problem
instead of bypassing the check.
