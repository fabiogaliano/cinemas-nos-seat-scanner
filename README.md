# Melhor Lugar

Web app that compares live seat availability across Cinemas NOS sessions and recommends a contiguous, centered block for a group.

## Local development

```bash
bun install
bunx playwright install chromium
bun run dev
```

Open `http://localhost:5757`. The browser bundle rebuilds when the server starts; rerun after client changes.

## Commands

```bash
bun run build       # production client bundle
bun run typecheck   # TypeScript
bun run test        # Vitest
bun run start       # production server
```

## Deployment

`deploy/compose.yaml` runs the app and Chromium behind Traefik. From this repository:

```bash
./deploy/deploy.sh vps-f
```

Runtime scan artifacts are stored in the `cinemas-data` Docker volume.
