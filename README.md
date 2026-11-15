# IMPOSTER

A mobile-friendly multiplayer word game that runs as a single Node.js app.

## Run locally

1. Install Node.js 18 or newer.
2. In this folder, run `npm ci`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

To host the game, use a service that runs Node.js applications. Install dependencies with `npm ci` and start it with `npm start`. The server listens on the port provided by the host through `PORT`, or port 3000 by default.

The installable PWA requires HTTPS when hosted publicly. Multiplayer rooms are kept in server memory, so rooms are lost when the server restarts.
