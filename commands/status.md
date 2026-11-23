---
description: List search engines that can actually run a query
---

You are handling the `/web:status` command.

## Instructions

1. Call `web_status` with `{}`.
2. Report only the usable search engines from the result. Do not invent providers that are not listed.
3. If the list is empty or the tool fails, say so and stop. Do not start a gateway, guess keys, or print bind addresses, PIDs, quotas, or dashboard URLs.
4. To change Search Mode, use `/web:mode auto|smart|required|off`. Provider keys and routing live in the dashboard, not in this command.

User request: $ARGUMENTS
