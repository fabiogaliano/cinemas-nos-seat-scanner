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

## Configuration

The server reads these environment variables:

| Variable | Function |
| --- | --- |
| `PORT` | The port of the server. The default is `5757`. |
| `CINEMAS_DATA_DIR` | The directory for the scan data. The default is `./data`. |
| `CINEMAS_PUBLIC_DIR` | The directory of the client bundle. The default is `./dist`. |
| `NOS_SCAN_CONCURRENCY` | The quantity of parallel ticket flows. The default is `2`. The maximum is `4`. |
