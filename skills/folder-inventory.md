---
name: folder-inventory
description: List and count files across several folders.
when: The user names two or more folders, or asks how many files are in them.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Folder inventory

1. One `list_files` call per folder, `{"path":"<the folder>"}` — exactly the
   arguments the user gave, no pattern and no filter of your own.
2. Several folders may go in one step (up to four calls).
3. Never count a folder you did not list, and never list one twice.
4. Read `count` and `totals.files` from each result; a result that reports
   `filtered_out` or `truncated` is not a whole count.
5. The engine adds the same number up and appends the total — quote that number,
   do not compute a second one.
6. If one folder failed, name it and give the total of the ones that worked.
