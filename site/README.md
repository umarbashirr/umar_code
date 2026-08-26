# site/

Static landing files. No build, no package, no JavaScript.

## Files

- `index.html` is the page. Copy, landmarks, and the install command text live here.
- `styles.css` is zinc tokens, color scheme, first-viewport packing, and pane layout.
- `vercel.json` sets cache headers. It has no rewrites and no build.
- `favicon.png` is the tab icon.

Edit visitor copy in `index.html`. Change an install command by replacing the text inside the matching `pre[data-os] > code` node. Do not add a `macos` block.

## How to deploy this folder to Vercel

1. Create a Vercel project from this git repo, or upload this `site/` directory.
2. If the project root is the parent repo, set the Root Directory to `site`.
3. Set Framework Preset to Other.
4. Leave the build command empty.
5. Set the output directory to `.`.
6. Deploy.

Vercel serves `index.html` at `/` and `styles.css` at `/styles.css`.
