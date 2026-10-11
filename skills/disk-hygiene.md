---
name: disk-hygiene
description: Check disk space and suggest what to clean up first.
when: The user asks about disk usage, free space, or "why is my machine full".
updatedAt: 2026-10-11T00:00:00.000Z
---

# Disk hygiene

1. Run the `disk_report` script with no arguments to get free and used space per
   mount point.
2. Name the mount with the least free space, with its numbers.
3. Suggest, in this order, the cheapest wins: package caches, build output
   (`dist/`, `node_modules/` of unused projects), logs, then old downloads.
4. Never delete anything yourself from this skill — propose, then wait for a
   confirmation.
