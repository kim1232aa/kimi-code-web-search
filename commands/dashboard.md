---
description: Point the user at the Web UI dashboard without starting a gateway
---

You are handling the `/web:dashboard` command.

## Instructions

1. Do not call `web_status`, and do not start a gateway to look up an address.
2. Tell the user the dashboard runs on the **gateway host**, not on this Kimi client. If they already know that origin, use it. Do not invent `http://127.0.0.1:18492` for a remote setup.
3. Summarize what the dashboard configures: Search Mode (`auto` / `smart` (`Jev 判定`) / `required` / `off`), provider keys, routing, Smart/Jev, Xiaohongshu / X login. Do not print keys, bind addresses, or PIDs.
4. Mention `/web:mode` to change Search Mode from the chat, and `/web:status` to list engines that can actually search.

User request: $ARGUMENTS
