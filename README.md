# Melhor Lugar

Melhor Lugar is a web application for the cinemas of Cinemas NOS. It reads the
free seats of each show. Then it shows the best block of adjacent seats near the
center of the room for your group.

## Before you start

Install [Bun](https://bun.sh).

## Installation

1. Install the dependencies:

   ```bash
   bun install
   ```

2. Install the Chromium browser:

   ```bash
   bunx playwright install chromium
   ```

## Operation

1. Start the development server:

   ```bash
   bun run dev
   ```

2. Open `http://localhost:5757` in a browser.

The server makes the client bundle again at each start. If you change the client
code, start the server again.

## Commands

| Command | Function |
| --- | --- |
| `bun run build` | Makes the client bundle for production. |
| `bun run typecheck` | Examines the TypeScript types. |
| `bun run test` | Does the tests. |
| `bun run start` | Starts the production server. |

## Deployment

`deploy/compose.yaml` starts the application and Chromium behind Traefik.

1. Deploy the application to a host:

   ```bash
   ./deploy/deploy.sh <host>
   ```

2. Optional: set `CLOUDFLARE_API_TOKEN` before step 1. Then the script also
   removes the data in the Cloudflare cache.

The application keeps the scan data in the `cinemas-data` Docker volume.
