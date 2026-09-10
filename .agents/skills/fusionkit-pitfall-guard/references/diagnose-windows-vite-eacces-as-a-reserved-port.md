# FK-PIT-0125: Diagnose Windows Vite EACCES as a reserved port

## Area

Windows frontend services / Vite development server / host networking.

## Triggers

`pnpm dev`, `listen EACCES`, `permission denied`, `::1:5173`, Socket error
10013, no listener on the requested port, `excludedportrange`, HNS, WinNAT,
Hyper-V, WSL, or container networking.

## Symptoms

- Vite previously started on port 5173 but suddenly exits before compilation.
- The error is `listen EACCES: permission denied ::1:5173`, not
  `EADDRINUSE`.
- `Get-NetTCPConnection` or `netstat` finds no process listening on 5173.
- A direct socket bind to 5173 fails with `AccessDenied`, while a nearby port
  outside the excluded range succeeds.

## Root cause

Windows host networking can reserve TCP exclusion ranges for HNS, WinNAT,
Hyper-V, WSL, VPN, or container features. A port inside one of those ranges is
unavailable to user processes even when no process owns a listener. These
dynamic ranges can move after a reboot or networking-service change, which
makes a default Vite port appear to fail suddenly. When the range exists for
both protocol stacks, changing only the host from `::1` to `127.0.0.1` does
not solve it.

## Do

- First distinguish an occupied port from a reserved one:

  ```powershell
  Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
  netsh interface ipv4 show excludedportrange protocol=tcp
  netsh interface ipv6 show excludedportrange protocol=tcp
  ```

- If 5173 falls inside an exclusion range, use a verified port outside every
  listed range, for example:

  ```powershell
  pnpm dev --host 127.0.0.1 --port 7777
  ```

- Keep Electron coupled to Vite's resolved development URL instead of adding
  a second hard-coded renderer URL.
- Treat the exclusion table as host state that may change across reboots.
- If a fixed 5173 port is mandatory, coordinate any administrative HNS/WinNAT
  reconfiguration with the user's WSL, Docker, VPN, and Hyper-V setup.

## Avoid

- Do not keep looking for or killing a nonexistent process after the port has
  been proven listener-free.
- Do not assume switching from `localhost`/IPv6 to IPv4 bypasses a reservation
  that appears in both exclusion tables.
- Do not delete exclusion ranges or stop networking services as a routine
  development fix; doing so can disrupt WSL, containers, VPNs, or Hyper-V and
  the reservation may return later.
- Do not blame firewall rules for an exact local bind failure before checking
  the exclusion table.

## Validation

1. Confirm the failing port is inside an excluded range and has no listener.
2. Bind a loopback test socket to the replacement port, or start Vite there.
3. Confirm Electron receives and loads the actual Vite development URL.
4. Stop the validation Vite/Electron processes and confirm they no longer
   appear in the process table.

## Related files

- `vite.config.ts`
- `package.json`
- `.agents/skills/fusionkit-pitfall-guard/references/frontend-service-cleanup-before-final.md`
