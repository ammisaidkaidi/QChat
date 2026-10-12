---
name: machine-health
description: One health check — CPU, memory, disk and uptime — worst finding first.
when: The user asks whether the machine is healthy, why it is slow, or for a status check.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Machine health

1. Call `system_info` with `{"cpu_load":true,"top_processes":5}` and `disk_report`
   in the same step.
2. Report load, memory used/total, uptime, and the mount with the least free space.
3. Flag only what is a real problem: load well above the core count, a mount under
   10% free, a disk that is missing.
4. Asked why it is slow? Name the heaviest process from `top_processes`.
5. Every number must come from the results — never from memory.
