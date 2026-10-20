# Iconoplasm blots

Every [Iconoplasm](https://iconoplasm.brinedew.bio) blot, one WebP per human protein-coding gene (about 19,400). A blot is the gene's character portrait with its full name and symbol painted into the image. All files are CC0: use them anywhere, no attribution required.

This copy exists for code that can reach GitHub but not `iconoplasm.brinedew.bio`, such as Claude.ai's code sandbox. If your code can reach the site, its [developer page](https://iconoplasm.brinedew.bio/developers) has the full API.

## File addresses

```
blot/{FIRST LETTER}/{SYMBOL}.webp
```

`{SYMBOL}` is the HGNC symbol in upper case: `blot/N/NOTCH1.webp`, `blot/T/TP53.webp`, `blot/C/C10ORF105.webp`. Each file is 768 × 1024 pixels, about 120 KB. [index.json](index.json) lists every symbol with its full name and path.

## Downloading

**Single files:**

```
https://raw.githubusercontent.com/Brinedew/iconoplasm-blots/main/blot/N/NOTCH1.webp
```

**If only github.com is reachable** (the default for Claude.ai's sandbox), use git. This fetches only the files you ask for, not the whole repository:

```sh
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/Brinedew/iconoplasm-blots.git
cd iconoplasm-blots
git checkout main -- blot/N/NOTCH1.webp blot/D/DLL1.webp blot/R/RBPJ.webp
```

To put a blot inside an SVG so the file works offline, embed it as a data URL:

```python
import base64
data = base64.b64encode(open("blot/N/NOTCH1.webp", "rb").read()).decode()
image = f'<image href="data:image/webp;base64,{data}" width="192" height="256"/>'
```

**If your code can't download files at all** (a sandbox with network access off), link the `raw.githubusercontent.com` address instead of embedding. GitHub serves it, and the figure shows it wherever it is opened online. Claude.ai's file preview shows only embedded images, so a linked figure looks empty there until it is opened in a browser.
## Aliases

Paths use official HGNC symbols. For a name like p53, IL-1β or a UniProt accession, map it to its HGNC symbol first (p53 is TP53). From code that can reach the site, the resolver does that: `POST https://iconoplasm.brinedew.bio/api/public/v1/images/resolve`.

## Freshness

A gene's blot changes when the community votes in a better portrait. A GitHub Action ([sync.yml](.github/workflows/sync.yml)) is scheduled to check Iconoplasm every hour and commit the blots that changed. GitHub runs hourly schedules on a best-effort basis and skips many of them, so a file here can be a few hours behind the site.

## License

[CC0 1.0](LICENSE). Credit "Brinedew / Iconoplasm" if you like.
