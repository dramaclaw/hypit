# Desktop runtime dependency lock

`package.json` copies the root Distribution's external `dependencies` exactly.
`package-lock.json` pins their full dependency graph, including optional packages
for every supported platform, with registry URLs and SHA-512 integrity values.
The local Hypit tarball is deliberately absent from this lock.

When root dependencies change, update this package's dependency object and run
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` here from
a clean directory with no `node_modules`. Review and commit both files together.
Do not generate a target-specific lock; both desktop targets share this lock.

Resource preparation checks the packed Distribution against this input, runs
`npm ci --omit=dev --include=optional --ignore-scripts` for the requested OS/CPU,
then copies the safely extracted Distribution into the runtime. The resource
manifest records hashes of both lock inputs as well as every staged file.

The artifact gate allows images only in the Distribution's package previews
and the bundled minimal-author-package example previews. The unused
`stream-http/test/server/static/browserify.png` dependency test fixture is
explicitly removed and recorded. Other unexpected media or credentials fail
the stage.
