# Development

## Layout

```
opm-flow-editor-support/
├── opm-reference-manual/    # git submodule — keyword docs (.fodt)
├── opm-common/              # git submodule — parser truth (sparse: only
│                            #   opm/input/eclipse/share/keywords)
├── scripts/                 # keyword-index builder (Python)
│   ├── build_keyword_index.py
│   └── requirements.txt
└── vscode-extension/        # the VS Code extension
    ├── src/extension.ts
    ├── syntaxes/opm-flow.tmLanguage.json
    ├── language-configuration.json
    ├── data/keyword_index_compact.json
    └── package.json
```

The two upstream sources are merged into a single index: `opm-reference-manual`
provides descriptions, units, and examples; `opm-common` provides authoritative
section validity and per-parameter `value_type` (INT/DOUBLE/STRING/…) and
`dimension` (Length/Pressure/…) — both surfaced in hover and the docs sidebar.

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

## Release

Releases are tag-driven. On pushing a `v*` tag, CI:

1. Rebuilds the keyword index from the submodule.
2. Packages a VSIX named `opm-flow-editor-support-<version>.vsix`.
3. Attaches the VSIX to a GitHub Release.
4. Publishes the VSIX to the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=magne-sjaastad.opm-flow-editor-support)
   using the `VSCE_PAT` repo secret.

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
