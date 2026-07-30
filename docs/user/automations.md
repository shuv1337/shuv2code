# Project automations

Project automations start ordinary project threads from a saved prompt and schedule. Create and
manage them from **Settings → Automations**. New automations are paused until you enable them.

## Runtime behavior

- The shuv2code server must be running when an automation is due. The scheduler runs in the server,
  not in a hosted cloud service.
- After downtime, shuv2code starts one overdue run and schedules the next future occurrence. It does
  not replay every interval missed while the server was stopped.
- If a due run cannot be dispatched, it is recorded as failed and the schedule advances normally.
- The **Skip** overlap policy records a skipped run while an earlier run is queued or running. The
  **Parallel** policy allows both runs to proceed.
- Pausing an automation preserves its configuration and history. Deleting it also deletes its run
  history.

## Permissions

Each run uses the model, permission mode, and agent mode saved on the automation. **Full access**
allows unattended commands and file changes without approval, so use a narrower mode when the task
does not require it.

Agents can manage automations through the project-scoped MCP tools. Agent-created automations
default to paused, durable mutations are marked destructive for MCP clients, and an agent cannot
create, enable, or run an automation with broader permissions than its current chat.
