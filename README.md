# Fusion Add-ins by Stastyle

The source of **https://stastyle.github.io/fusion-addins/**, a page listing every
Autodesk Fusion add-in I publish on GitHub.

Nothing on the page is written by hand. A GitHub Action rebuilds it every day (and on every
push here) from all of my repositories tagged with the topic **`fusion-addin`**.

## Adding a new add-in to the page

1. In the add-in's repository, click the gear next to **About** and add the topic `fusion-addin`.
2. Wait for the next daily build, or run it now: **Actions → Build and publish the add-in page → Run workflow**.

That's all. Removing the topic removes the card.

## Where each card's content comes from

| On the card | Taken from (first one found) |
|---|---|
| Name | `overrides.json` → the README's first `# heading` (minus "for Fusion 360", "— Fusion 360 Add-in") → the add-in folder name |
| Description | `overrides.json` → the `.manifest` description → the repo description |
| Version | `overrides.json` → latest GitHub release tag → the `.manifest` version |
| Picture | `overrides.json` → the first image in the README (badges and icons skipped) |
| Icon | `overrides.json` → `icon.png` at the root or in `docs/` → the add-in's `resources/` (64×64, then 32×32) |
| Download | the `.zip` attached to the latest release → the release source zip → the default branch zip |
| Install folder | the folder that holds the add-in's `.manifest` |

Images are copied into the page, so they work for private repos too.

## Fixing a card without touching the add-in repo

Edit `overrides.json` in this repo, keyed by repository name:

```json
{
  "F360-sequential-bridging": {
    "name": "Sequential Bridge",
    "description": "One line about what it does.",
    "screenshot": "docs/example-add-hex.png",
    "icon": "docs/icon.png",
    "order": 1,
    "hidden": false
  }
}
```

Every key is optional. Paths are inside the add-in repo. `order` pins cards to the front
(lower first); everything else is sorted by most recent push. A repo can also carry the same
keys in its own `fusion-addin.json` at the root; `overrides.json` wins.

## Private add-ins

The default token only sees public repos. To list private ones too, add a fine-grained
personal token with read access to the repos as the secret `CATALOG_TOKEN`
(**Settings → Secrets and variables → Actions**). The page itself is always public.

## Build checks

Each run's summary (Actions → the run) lists what made it onto the page, and names any repo
that contains a Fusion `.manifest` but has no `fusion-addin` topic yet.

## Run it locally

```bash
GITHUB_TOKEN=... node scripts/build.mjs   # writes dist/index.html
```

Set `REPOS=repo-a,repo-b` to build only those repos, ignoring the topic.

## Note on the daily schedule

GitHub pauses scheduled workflows in a repo with no commits for 60 days. If that happens,
GitHub emails a notice; open **Actions** here and click **Enable workflow**, or push any commit.
