---
name: network-check
description: Report the default route, addresses and error counters of the interfaces.
when: The user asks about connectivity, their IP, or which interface is in use.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Network check

1. Call `net_interfaces` with `{"addresses":true,"traffic":true,"down":true}`.
2. Name the interface that carries the default route, with its IPv4 address and
   its rx/tx totals.
3. A down interface is normal on a laptop (wlan down when wired) — say that
   instead of calling it a fault.
4. The one thing worth flagging is non-zero error or drop counters.
5. One line per interface, the important one first.
