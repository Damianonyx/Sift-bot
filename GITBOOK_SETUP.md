# Connect Sift's documentation to GitBook

This is a documentation-only addition to `Damianonyx/Sift-bot`. The six public-facing pages live in `gitbook/`; the bot source, configuration and runtime are unchanged. The documented development version is identified in `gitbook/status-and-roadmap.md`.

## Prepared configuration

- `gitbook-docs.yaml` at the repository root maps the Sift documentation space to `./gitbook`.
- `gitbook/.gitbook.yaml` sets the page root, welcome page and contents file.
- `gitbook/SUMMARY.md` lists each of the six pages once in the intended order.

The files follow GitBook's current [content-configuration documentation](https://gitbook.com/docs/docs-as-code/git-sync/content-configuration). GitBook now distinguishes site mapping (`gitbook-docs.yaml`) from per-space configuration (`.gitbook.yaml`).

## Initial connection

1. In GitBook onboarding, select **Markdown in a Git repository** and continue with GitHub.
2. Authorize GitBook for **only `Damianonyx/Sift-bot`** when choosing repository access.
3. Select repository `Damianonyx/Sift-bot` and branch `codex/gitbook-docs`.
4. Use the repository root as the Git Sync project directory if asked. The root `gitbook-docs.yaml` maps the content to `gitbook/`. If asked to map the space's content directory separately, choose `gitbook`.
5. For the first sync, import the content **from GitHub into GitBook**. Do not export a blank or sample GitBook space over these Markdown files.
6. Check that Welcome, Getting started, Your screening rules, Data and evidence, Current status and roadmap, and FAQ appear in order.
7. Review the imported pages before choosing any public publishing setting.

For a space-level or older sync flow that asks directly for the directory containing `.gitbook.yaml`, that directory is `gitbook`. Avoid applying a second `gitbook/` prefix inside its configuration; its `root` is already `./`.

No GitBook account connection or import has been performed by this change. Onboarding wording and Git Sync availability can depend on the GitBook account. No upgrade or paid plan is authorized; leave any billing choice to the owner. Keep GitBook's initial content private or unpublished during review.

## Ongoing edits

GitBook can write changes back to its connected branch. Before changing repository files later, fetch that branch's current head and preserve any GitBook edits. Do not force-push over them.

Once this documentation change is merged through review, the owner can deliberately switch Git Sync to `main`. Until then, selecting `main` will not import these new pages. The docs branch is not a bot release branch; it should not be used to update the running bot.

Keep the `sift-docs` space key stable after connection. Review the status page when capabilities change, and update implementation and live-validation claims separately. Do not copy runtime databases, Telegram IDs, bot tokens or other credentials into the docs.
