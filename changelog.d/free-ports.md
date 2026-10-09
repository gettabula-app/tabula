section: Changed
audience: dev

- `npm run dev` and `npm run desktop:dev` now honor `PORT` for the relay and `VITE_PORT` for Vite while keeping the documented `8787` and `5173` defaults; docs-image relays always request system-assigned ports.
