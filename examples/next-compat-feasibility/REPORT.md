# denext drop-in verification — shadcn-next-template

| field  | value                                          |
| ------ | ---------------------------------------------- |
| app    | https://github.com/shadcn-ui/next-template.git |
| ref    | main (d117bd0)                                 |
| denext | /Users/nightness/Source/Brainwires/denext      |
| date   | 2026-08-16T13:48:33Z                           |

## Stage results

| stage   | status | note                                          |
| ------- | ------ | --------------------------------------------- |
| clone   | PASS   | d117bd0 (reused)                              |
| install | PASS   | reused node_modules                           |
| convert | PASS   | no hard blockers                              |
| check   | FAIL   | see 4-check.log (first errors below)          |
| build   | PASS   | unmodified app built                          |
| render  | PASS   | homepage served, 9610 bytes (body markers: 1) |

## Conversion detail

```
# denext conversion report

App:    /private/var/folders/4w/pbxjrpdd5fq9xdgb1jxvsfcm0000gn/T/denext-dropin/shadcn-next-template/app
denext: /Users/nightness/Source/Brainwires/denext (v0.12.0)

Router:        App Router (app/)
Pages Router:  absent ✅
Routes found:  1
tsconfig paths: @/→./

## Dependency conversion (27 total)
- aliased to denext (4): next, react, react-dom, react-is
- passed through to npm (14): @radix-ui/react-slot, class-variance-authority, clsx, lucide-react, next-themes, tailwind-merge, tailwindcss-animate, @ianvs/prettier-plugin-sort-imports, @typescript-eslint/parser, autoprefixer, postcss, prettier, tailwindcss, typescript
- dropped (9): sharp (denext provides its own; not needed); @types/node (dev-only tooling); @types/react (dev-only tooling); @types/react-dom (dev-only tooling); eslint (dev-only tooling); eslint-config-next (denext provides its own; not needed); eslint-config-prettier (dev-only tooling); eslint-plugin-react (dev-only tooling); eslint-plugin-tailwindcss (dev-only tooling)
- ⚠️  FLAGGED unsupported (0): none 🎉

Wrote deno.json + denext.pages.json into the app.
```

Logs: `/var/folders/4w/pbxjrpdd5fq9xdgb1jxvsfcm0000gn/T//denext-dropin/shadcn-next-template/logs`
