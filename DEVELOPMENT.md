# Development

## Layout

```
opm-flow-editor-support/
├── opm-reference-manual/    # git submodule — keyword docs (.fodt)
├── opm-common/              # git submodule — parser truth (sparse: only
│                            #   opm/input/eclipse/share/keywords)
├── scripts/                 # keyword-index builder + site generator (Python)
│   ├── build_keyword_index.py
│   ├── test_build_keyword_index.py   # pytest suite for the builder
│   ├── build_keyword_site.py         # renders the index as a static website
│   ├── test_build_keyword_site.py    # pytest suite for the generator
│   ├── site_assets/                  # style.css + site.js copied into the site
│   └── requirements.txt
├── demo-decks/              # runnable sample decks + VIDEO-SCRIPT.md walkthrough
├── examples/                # small decks illustrating single features
└── vscode-extension/        # the VS Code extension
    ├── src/
    │   ├── extension.ts          # activation, command + provider wiring
    │   ├── analysis.ts           # deck parsing + diagnostics engine
    │   ├── boilerplate.ts        # keyword-completion snippet bodies
    │   ├── names.ts              # well/group name harvesting (WELSPECS/GRUPTREE)
    │   ├── udq.ts                # UDQ / ACTIONX recognition + metadata
    │   ├── formatting.ts         # Align Record Columns / Add Column Headers
    │   ├── align-exclusions.ts   # keywords skipped by the deck-wide align sweep
    │   ├── diagnostics-exclusions.ts
    │   ├── keyword-supplement.ts # deck-name alias / family resolution
    │   ├── links.ts              # INCLUDE/IMPORT/RESTART/GDFILE file links
    │   ├── paths.ts              # PATHS alias expansion + path resolution
    │   ├── outline.ts            # section/keyword tree view
    │   ├── simulator.ts          # Verify Deck / Run Simulation (optional)
    │   └── *.test.ts             # Jest unit tests, one per module
    ├── scripts/sync-manual-ref.js    # stamps the manual commit into README
    ├── syntaxes/opm-flow.tmLanguage.json
    ├── language-configuration.json
    ├── data/keyword_index_compact.json
    └── package.json
```

The two upstream sources are merged into a single index: `opm-reference-manual`
provides descriptions, units, and examples; `opm-common` provides authoritative
section validity and per-parameter `value_type` (INT/DOUBLE/STRING/…) and
`dimension` (Length/Pressure/…) — both surfaced in hover and the docs panel.

## Clone

This repo uses a submodule, so clone recursively:

```sh
git clone --recurse-submodules https://github.com/OPM/opm-flow-editor-support.git
```

If you already cloned without `--recurse-submodules`:

```sh
git submodule update --init --recursive
```

To pull the latest manual content:

```sh
git submodule update --remote opm-reference-manual
```

## Build the extension

```sh
cd vscode-extension
npm install
npm run compile        # TypeScript → out/
npx vsce package       # produce a .vsix
```

## Tests

The extension's logic is covered by Jest unit tests (run under `ts-jest`):

```sh
cd vscode-extension
npm test               # all unit tests
npx jest analysis      # a single suite
```

The Python keyword-index builder has its own pytest suite:

```sh
cd scripts
pip install -r requirements.txt
python -m pytest test_build_keyword_index.py
```

### Corpus false-positive harness

`src/corpus.test.ts` runs the diagnostics engine over the
[OPM/opm-tests](https://github.com/OPM/opm-tests) decks. Those decks are
known-good (they parse and run in OPM Flow), so any diagnostic emitted on them is
a suspected false positive — an analyzer bug, a keyword/shape missing from the
index, or an exclusion candidate.

Point it at a local clone via `OPM_TESTS_DIR` (it defaults to
`M:/gitroot/opm-tests`); the harness is skipped automatically when no clone is
found, so the normal `npm test` and CI runs are unaffected:

```sh
cd vscode-extension
OPM_TESTS_DIR=/path/to/opm-tests npx jest corpus
```

It writes a triage report to `vscode-extension/corpus-report.md` (gitignored)
grouping suspected false positives by diagnostic type and keyword, plus the
noisiest files.

## Regenerate the keyword index

The shipped `vscode-extension/data/keyword_index_compact.json` is generated
from the `.fodt` files in the submodule:

```sh
cd scripts
pip install -r requirements.txt
python build_keyword_index.py \
    --manual-dir ../opm-reference-manual \
    --opm-common-dir ../opm-common/opm/input/eclipse/share/keywords \
    --output ../keyword_index.json \
    --compact ../vscode-extension/data/keyword_index_compact.json
```

Or run the wrapper from the extension, which writes the compact index in place:

```sh
cd vscode-extension
npm run build-index
```

`vscode-extension/README.md` carries the manual commit it was built from inside a
`<!-- manual-ref:start -->` marker. `npm run sync-manual-ref` (also part of
`vscode:prepublish`) stamps the current `opm-reference-manual` submodule commit
into that marker, so the listing always shows the data revision being shipped.

## Build the keyword website

`scripts/build_keyword_site.py` renders the keyword data as a static site —
one page per keyword plus a searchable front page — that is published to GitHub
Pages. It needs the **full** `keyword_index.json`; the compact index bundled
with the extension has no descriptions.

```sh
python scripts/build_keyword_index.py \
    --manual-dir opm-reference-manual \
    --opm-common-dir opm-common/opm/input/eclipse/share/keywords \
    --output keyword_index.json

python scripts/build_keyword_site.py \
    --index keyword_index.json \
    --output site \
    --manual-ref "$(git -C opm-reference-manual rev-parse HEAD)"
```

`--manual-ref` pins the per-page "Manual source" links to a submodule commit; it
defaults to `main`. The output (`site/`, gitignored) is ~10 MB across ~3 160
pages. All links are relative, so preview it either way:

```sh
python -m http.server -d site 8000    # then open http://localhost:8000/
```

The generator is stdlib-only — no additions to `requirements.txt` — and its
pytest suite runs as part of the existing `pytest scripts/`.

### Publishing

The `build-index` job in `.github/workflows/build-vsix.yml` builds the site and
uploads it as a Pages artifact on every run; the `deploy-pages` job publishes it
on pushes to `main`. Pull requests build but do not deploy.

> **One-time repository setup:** GitHub Pages must be switched to
> **Settings → Pages → Source: GitHub Actions**. Until then `deploy-pages`
> fails with "Pages is not enabled".

Keyword documentation on the site comes from the OPM Flow reference manual,
which is licensed CC BY 4.0 — every generated page carries the required
attribution in its footer.

## Release

Releases are tag-driven. On pushing a `v*` tag, CI:

1. Rebuilds the keyword index from the submodule.
2. Packages a VSIX named `opm-flow-editor-support-<version>.vsix`.
3. Attaches the VSIX to a GitHub Release.
4. Publishes the VSIX to the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=magne-sjaastad.opm-flow-editor-support)
   using the `VSCE_PAT` repo secret.
5. Publishes the same VSIX to [Open VSX](https://open-vsx.org/extension/magne-sjaastad/opm-flow-editor-support)
   using the `OVSX_PAT` repo secret.

```sh
# bump vscode-extension/package.json "version"
git commit -am "Release v0.6.1"
git tag v0.6.1
git push && git push --tags
```

### Marketplace publishing prerequisites

Already in place for this repo, but documented for reference:

- **Publisher**: `magne-sjaastad` on the [VS Code Marketplace](https://marketplace.visualstudio.com/manage/publishers/magne-sjaastad).
- **Repo secret `VSCE_PAT`**: an Azure DevOps Personal Access Token with scope
  *Marketplace > Manage*. Rotate by generating a new PAT and replacing the secret.

To publish manually from a workstation (bypassing CI):

```sh
cd vscode-extension
npx vsce login magne-sjaastad   # one-time, paste PAT
npx vsce publish                # bumps version interactively if asked
```

### Open VSX publishing prerequisites

Open VSX is the registry used by VSCodium, Cursor, Gitpod and other non-Microsoft
builds. Setup is one-time:

- **Eclipse account**: sign in at [open-vsx.org](https://open-vsx.org) with GitHub and
  sign the **Eclipse Publisher Agreement** in your profile. Publishing fails without it.
- **Namespace**: must match the `publisher` field in `package.json`.
  `npx ovsx create-namespace magne-sjaastad -p <token>` (one-time).
- **Repo secret `OVSX_PAT`**: an access token from open-vsx.org → Profile → Access Tokens.

Check the token and namespace without uploading anything:

```sh
npx ovsx verify-pat magne-sjaastad -p <token>
```

Note that Open VSX has no staging registry, `ovsx publish` has no dry-run mode, and a
published version cannot be replaced or removed by its owner — only by registry admins.
To publish manually from a workstation:

```sh
cd vscode-extension
npx ovsx publish opm-flow-editor-support-<version>.vsix -p <token>
```
