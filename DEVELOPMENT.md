# Development

## Layout

```
opm-flow-editor-support/
├── opm-reference-manual/    # git submodule — source of truth for keywords (.fodt)
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
    --output ../vscode-extension/data/keyword_index_compact.json
```

## Release

Releases are tag-driven. On pushing a `v*` tag, CI rebuilds the keyword index
from the submodule, packages a VSIX, and attaches it to a GitHub Release.

```sh
# bump vscode-extension/package.json "version"
git commit -am "Release v0.5.1"
git tag v0.5.1
git push && git push --tags
```
