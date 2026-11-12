# Google R1 HTTPS fixture

This fixture uses a simulated Google provider and synthetic accounts. It writes to the explicitly supplied, already migrated disposable database and Valkey instance. Use a fresh disposable database and remove it separately after inspection. It requires loopback PostgreSQL at port 5433, an `outpost_m01b_r1_*` database name, and loopback Valkey on a dedicated nonstandard port.

Prerequisites: Node, OpenSSL on PATH, an installed Chromium-compatible browser, and the backend's installed dependencies and generated Prisma client. Supply `M01B_R1_DATABASE_URL`, `M01B_R1_VALKEY_URL`, and `M01B_R1_BROWSER` (the browser executable path). If OpenSSL is not on PATH, set `M01B_R1_OPENSSL` to its executable. Optionally set `M01B_R1_EVIDENCE` to a disposable output path. Then run `npm run test:e2e:google` from `frontend`.

The fixture covers the happy path, wrong-browser callback, lost activation body, closed tab, reload, process termination, delayed headers and bootstrap response ordering. The restart probe requires the activation cookie to survive termination before checking the server fence. The verification report records observed results and outstanding variants. Diagnostic-only environment switches run subsets and return a nonzero status.
